import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Assistant } from '../dist/assistant.js';
import { PublicError } from '../dist/types.js';
import { NOW, ZONE, scenarios, fixture, gradeHistorical } from './whatsapp-comparison-cases.mjs';
import { adaptHistoricalFixture } from './whatsapp-comparison-fixture.mjs';
import { gradeCurrent } from './whatsapp-comparison-grade.mjs';

const prices = {
  'gpt-6-luna': [.10, .01, .125, .50],
  'gpt-6-astra': [10, 1, 12.50, 50],
  'gpt-6.2-sol': [2, .10, 2.50, 10],
  'gpt-6.2-astra': [8, .40, 10, 40],
};
const args = process.argv.slice(2);
const param = (name, fallback) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback;
const dry = args.includes('--dry');
if (dry === args.includes('--run')) throw Error('Escolha --dry ou --run.');
if (!dry && !process.env.OPENAI_API_KEY) throw Error('OPENAI_API_KEY ausente.');
const output = param('output', null);
if (!output) throw Error('Informe --output=<diretório da avaliação>.');
const models = param('models', Object.keys(prices).join(',')).split(',');
if (new Set(models).size !== models.length || models.some(model => !Object.hasOwn(prices, model))) throw Error('Modelos inválidos.');
function bounded(name, fallback, max) {
  const value = Number(param(name, fallback));
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('Parâmetro inválido: ' + name);
  return value;
}
const repeats = bounded('repeats', 2, 10);
const concurrency = bounded('concurrency', 6, 12);
const selected = scenarios.slice(0, bounded('limit', scenarios.length, scenarios.length));
const budget = Number(param('budget', 28));
if (!Number.isFinite(budget) || budget <= 0) throw Error('Orçamento inválido.');
const effort = param('effort', 'low');
if (!['none', 'low', 'medium', 'high'].includes(effort)) throw Error('Use --effort=none|low|medium|high.');
const endpoint = 'https://api.openai.com/v1/responses';

// Application dates are deterministic; HTTP, latency and retries use the actual clock.
const systemDate = Date;
const appClock = new AsyncLocalStorage();
const epoch = systemDate.parse(NOW);
globalThis.Date = new Proxy(systemDate, {
  construct(target, values, newTarget) {
    return Reflect.construct(target, !values.length && appClock.getStore() ? [epoch] : values, newTarget);
  },
  apply(target, self, values) {
    return appClock.getStore() ? new systemDate(epoch).toString() : Reflect.apply(target, self, values);
  },
  get(target, key, rec) {
    return key === 'now' && appClock.getStore() ? () => epoch : Reflect.get(target, key, rec);
  },
});
function tokenUsage(usage) {
  if (!Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.output_tokens)) return null;
  return { input: usage.input_tokens, cached: usage.input_tokens_details?.cached_tokens ?? 0,
    written: usage.input_tokens_details?.cache_write_tokens ?? 0, output: usage.output_tokens,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0 };
}
function price(usage, model) {
  const [input, cached, write, output] = prices[model];
  return ((usage.input - usage.cached - usage.written) * input + usage.cached * cached
    + usage.written * write + usage.output * output) / 1e6;
}
function safe(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,96}$/.test(value) ? value : undefined; }
const signature = createHash('sha256');
for (const filename of ['../dist/assistant.js', './whatsapp-comparison-cases.mjs', './whatsapp-comparison-fixture.mjs', './whatsapp-comparison-grade.mjs', './whatsapp-comparison-run.mjs'])
  signature.update(await readFile(new URL(filename, import.meta.url)));
const manifest = { version: 1, signature: signature.digest('hex'), dry, effort, models, repeats, timeZone: ZONE,
  referenceDate: NOW, scenarios: selected.map(c => c.id), prices, outputLimit: 1800, concurrency };
const dir = resolve(output);
await mkdir(dir, { recursive: true });
const manifestFile = resolve(dir, 'manifest.json');
try { await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); }
catch (e) {
  if (e.code !== 'EEXIST') throw e;
  if (JSON.stringify(JSON.parse(await readFile(manifestFile, 'utf8'))) !== JSON.stringify(manifest))
    throw Error('Manifesto incompatível com tentativas anteriores. Use outro diretório.');
}
const resultsFile = resolve(dir, 'resultados.jsonl');
const records = (await readFile(resultsFile, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }))
  .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const jobKey = row => JSON.stringify([row.model, row.id, row.rep]);
const done = new Set(records.map(jobKey));
if (records.length !== done.size) throw Error('Resultados duplicados.');
let spent = records.reduce((total, row) => total + (row.cost ?? 0), 0), reserved = 0;
let fatal = '', next = 0, queue = Promise.resolve();
const blockedModels = new Map();
const jobs = [];
for (let rep = 1; rep <= repeats; rep++) for (const [i, c] of selected.entries()) {
  for (let offset = 0; offset < models.length; offset++) {
    const model = models[(i + rep - 1 + offset) % models.length];
    if (!done.has(jobKey({ model, id: c.id, rep }))) jobs.push({ model, c, rep });
  }
}
const total = repeats * models.length * selected.length;
async function reserve(estimate, signal) {
  while (!fatal && spent + reserved + estimate > budget && reserved > 0) await sleep(75, undefined, {signal});
  signal.throwIfAborted();
  if (spent + estimate > budget) fatal ||= 'EVAL_BUDGET_LIMIT';
  if (fatal) throw Error(fatal);
  reserved += estimate;
}
function extractCalls(data) {
  return (data.output ?? []).filter(item => item.type === 'function_call').map(item => {
    let args = null;
    try { args = JSON.parse(item.arguments); } catch {}
    return { name: item.name, args };
  });
}
async function run({c, model, rep}) {
  const f = adaptHistoricalFixture(fixture(c));
  const attempts = [];
  let technicalError = null, error = null;
  const consume = async (url, init) => {
    const blocked = blockedModels.get(model);
    if (blocked) { technicalError = blocked; throw Error('MODEL_UNAVAILABLE'); }
    if (url !== endpoint) { fatal = 'Unexpected network destination'; throw Error(fatal); }
    const body = JSON.parse(init.body);
    if (body.model !== model || body.reasoning?.effort !== effort || body.max_output_tokens !== 1800 || body.store !== false
        || !body.instructions.includes(NOW)) { fatal = 'Production payload or clock mismatch'; throw Error(fatal); }
    body.service_tier = 'default';
    if (dry) {
      const reply = { output: [{type:'message', content:[{type:'output_text', text:'DRY RUN'}]}] };
      f.state.requests.push({status:200, calls:[]});
      return Response.json(reply);
    }
    const wire = JSON.stringify(body);
    // Reserve a conservative upper estimate using request bytes before concurrent calls.
    const estimate = ((Buffer.byteLength(wire) + 2048) * prices[model][2] + 1800 * prices[model][3]) / 1e6;
    // The production wrapper starts one 45 s deadline per logical call.
    // Count queueing and all backoffs against that same deadline.
    const signal = init.signal;
    for (let number = 1; number <= 3; number++) {
      await reserve(estimate, signal);
      const began = performance.now();
      const attempt = { number, status: null, code: null };
      attempts.push(attempt);
      let delay = 0, retryable = false;
      try {
        const response = await fetch(endpoint, { method: 'POST', redirect:'error',
          headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
          body: wire, signal });
        attempt.status = response.status;
        delay = Number(response.headers.get('retry-after')) * 1000 || 0;
        const data = await response.json();
        const usage = tokenUsage(data.usage);
        if (usage) { attempt.usage = usage; attempt.cost = price(usage, model); spent += attempt.cost; }
        attempt.code = safe(data.error?.code) ?? safe(data.error?.type) ?? null;
        if (response.ok) {
          f.state.requests.push({status:response.status, responseStatus:data.status, incompleteReason:safe(data.incomplete_details?.reason),
            responseModel:data.model, serviceTier:data.service_tier, usage, calls:extractCalls(data)});
          return Response.json(data);
        }
        if (response.status === 401 || ['insufficient_quota','credit_balance_exhausted'].includes(attempt.code)) {
          fatal ||= 'API_' + response.status + '_' + (attempt.code ?? 'access');
        } else if ([403,404].includes(response.status) || attempt.code === 'model_not_found') {
          blockedModels.set(model, {status:response.status, code:attempt.code || 'model_unavailable'});
        } else retryable = [408,409,429,500,502,503,504].includes(response.status);
      } catch(e) {
        attempt.code = safe(e.name) || 'network_error';
        retryable = true;
      } finally {
        attempt.ms = Math.round(performance.now() - began);
        reserved -= estimate;
        if (reserved < 0.000001) reserved = 0;
      }
      if (fatal || !retryable || number === 3) {
        technicalError = {status:attempt.status, code:attempt.code};
        throw Error('OPENAI_REQUEST_FAILED');
      }
      await sleep(Math.max(delay, (2 ** number) * 1000), undefined, {signal});
    }
  };
  const aiFetch = (url, init) => appClock.exit(async () => {
    try { return await consume(url, init); }
    catch (e) {
      if (init.signal?.aborted) technicalError = {status:null, code:'timeout_45s'};
      throw e;
    }
  });
  const a = new Assistant({ timeZone:ZONE, ai:{key:'fixture', model, effort}, cash:{bindingPrefix:'VINCULAR ZENIT'} },
    f.store, {}, f.cash, f.day, f.calendar, aiFetch, {}, f.notifications);
  a.guests.list = async () => ({ revision:1, items:[{id:'ana-fixture',name:'Ana',email:'ana@example.com'}] });
  const began = performance.now();
  try {
    f.state.replies = await appClock.run(true, () => a.handle({ id:'fixture-'+c.id, sender:'synthetic-user',
      text:c.text, timestamp:epoch / 1000 }));
  } catch(e) {
    const publicError = e instanceof PublicError;
    error = {name:publicError ? 'PublicError' : e.name, message:e.message};
    if (!publicError && !technicalError) technicalError = {code:'fixture_error'};
  }
  const ms = performance.now() - began;
  if (!technicalError && fatal && error) technicalError = {code:fatal};
  const raw = {error, effects:f.state.effects, replies:f.state.replies, requests:f.state.requests, currentWorkspace:f.state.current.id};
  const grade = gradeCurrent(c, raw), historical = gradeHistorical(c, raw);
  const measured = attempts.filter(attempt => attempt.usage);
  const usage = measured.length ? Object.fromEntries(Object.keys(measured[0].usage).map(key =>
    [key, measured.reduce((sum, attempt) => sum + attempt.usage[key], 0)])) : null;
  const cost = measured.length ? measured.reduce((sum, attempt) => sum + attempt.cost, 0) : attempts.length ? null : 0;
  const row = {model, id:c.id, group:c.group, text:c.text, rep, effort, passed:grade.pass, historicalPassed:historical.pass,
    notes:[...grade.checks.filter(g => !g.pass).map(g => g.name), ...grade.notes], technicalError, cost, usage,
    ms, calls:attempts.length, attempts, ...raw};
  queue = queue.then(() => appendFile(resultsFile, JSON.stringify(row) + '\n'));
  await queue;
  records.push(row);
  console.log(JSON.stringify({completed:records.length,total,model,scenario:c.id,rep,passed:row.passed,
    technicalError, observedCostUsd:Number(spent.toFixed(5))}));
}
async function worker() { while (!fatal && next < jobs.length) await run(jobs[next++]); }
await Promise.all(Array.from({length:concurrency}, worker));
await queue;
const technical = records.filter(row => row.technicalError).length;
console.log(JSON.stringify({recorded:records.length, expected:total, technical, observedCostUsd:spent, fatal, dry}));
if (technical || records.length !== total || fatal) process.exitCode = 2;
