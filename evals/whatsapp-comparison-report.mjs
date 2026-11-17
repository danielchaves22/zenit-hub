import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modelOrder = ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.2-sol', 'gpt-6.2-astra'];
const ambiguityCases = new Set(['agenda-sem-duracao', 'agenda-ambigua', 'categoria-ambigua', 'lembrete-horario-invalido']);
const number = (value, digits = 0) => new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
}).format(value);
const seconds = value => value === null ? '—' : number(value / 1000, 2) + ' s';
const money = value => value === null ? '—' : 'US$ ' + number(value, 5);
const fraction = (part, total) => total ? part + '/' + total + ' (' + number(100 * part / total, 1) + '%)' : '—';
const hasTechnicalError = row => Boolean(Object.hasOwn(row, 'technicalError') ? row.technicalError : row.error);
const tidy = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const cell = value => tidy(value).replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const short = (value, size = 220) => {
  const text = tidy(value);
  return text.length <= size ? text : text.slice(0, size - 1) + '…';
};

function counts(rows) {
  const graded = rows.filter(row => !hasTechnicalError(row));
  return {
    count: rows.length, passed: graded.filter(row => row.passed).length, graded: graded.length,
    technical: rows.length - graded.length,
  };
}

function measuredSum(values) {
  const present = values.filter(v => Number.isFinite(v) && v >= 0);
  return { total: present.length ? present.reduce((a, b) => a + b, 0) : null, missing: values.length - present.length };
}

function summarizeModel(model, rows) {
  const completed = rows.filter(row => !hasTechnicalError(row));
  const times = completed.map(row => row.ms).filter(time => Number.isFinite(time) && time >= 0).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = times.length === 0 ? null : times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
  const p95 = times.length ? times[Math.ceil(times.length * 0.95) - 1] : null;
  const usage = Object.fromEntries(['input', 'cached', 'output', 'reasoning'].map(key => [
    key, measuredSum(rows.map(row => row.usage?.[key])),
  ]));
  return {
    model, efforts: [...new Set(rows.map(row => row.effort || 'padrão'))],
    ...counts(rows), measuredTimes: times.length, median, p95, calls: measuredSum(rows.map(row => row.calls)),
    cost: measuredSum(rows.map(row => row.cost)), usage,
    ambiguous: counts(rows.filter(row => row.ambiguous === true || row.group === 'Ambiguidade' || ambiguityCases.has(row.id))),
  };
}

export function summarize(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('O arquivo de resultados está vazio.');
  const keys = new Set();
  for (const row of rows) {
    if (!row.model || !row.id || row.rep == null || (!hasTechnicalError(row) && typeof row.passed !== 'boolean')) {
      throw new Error('Resultado incompleto em ' + JSON.stringify([row.model, row.id, row.rep]));
    }
    const key = JSON.stringify([row.model, row.effort, row.id, row.rep]);
    if (keys.has(key)) throw new Error('Execução duplicada em ' + key);
    keys.add(key);
  }
  const allModels = [...new Set(rows.map(row => row.model))];
  const models = [...modelOrder.filter(m => allModels.includes(m)), ...allModels.filter(m => !modelOrder.includes(m))];
  const cases = [...new Set(rows.map(row => row.id))].sort().map(id => {
    const matches = rows.filter(row => row.id === id);
    const byModel = Object.fromEntries(models.map(model => [model, counts(matches.filter(row => row.model === model))]));
    const evaluated = Object.values(byModel).filter(result => result.graded);
    const divergent = new Set(evaluated.map(result => result.passed / result.graded)).size > 1;
    return { id, group: matches[0].group ?? null, text: matches[0].text ?? null, byModel, divergent };
  });
  return { rows: rows.length, models: models.map(model => summarizeModel(model, rows.filter(r => r.model === model))), cases };
}

function formatSum(value, formatter = number) {
  if (value.total === null) return '—';
  return formatter(value.total) + (value.missing ? ' (parcial)' : '');
}

export function renderMarkdown(summary, rows) {
  const { models, cases } = summary;
  const parts = [
    '# Comparação de modelos no WhatsApp do Zenit Hub', '',
    `A bateria contém ${number(summary.rows)} execuções registradas de ${cases.length} cenários, com chamadas à API da OpenAI e conectores simulados. O tempo medido vai da entrada no assistente até o retorno da última resposta do cenário. A entrega ao telefone e a latência dos serviços de produção ficam fora da medição.`, '',
    '| Modelo | Raciocínio | Acerto entre avaliações concluídas | Falhas técnicas | Mediana | P95 | Custo medido por tokens |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...models.map(m => `| ${m.model} | ${m.efforts.join(', ')} | ${fraction(m.passed, m.graded)} | ${m.technical}/${m.count} | ${seconds(m.median)} | ${seconds(m.p95)} | ${formatSum(m.cost, money)} |`),
    '', 'O acerto exige satisfazer todos os critérios do cenário. A mediana e o percentil 95 incluem os acertos e as falhas de comportamento com tempo registrado. Falhas técnicas aparecem em coluna própria. O custo em dólares é uma estimativa baseada no uso informado pela API, incluindo as tentativas técnicas cujo uso foi retornado. Pode haver cobrança sem uso reportado quando uma conexão é interrompida.', '',
    '## Uso da API', '',
    '| Modelo | Requisições | Tokens de entrada | Destes, em cache | Tokens de saída | Destes, de raciocínio |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...models.map(m => `| ${m.model} | ${formatSum(m.calls)} | ${formatSum(m.usage.input)} | ${formatSum(m.usage.cached)} | ${formatSum(m.usage.output)} | ${formatSum(m.usage.reasoning)} |`),
    '', '## Pedidos ambíguos', '',
    'O conjunto original inclui um evento com duração ausente, dois eventos que correspondem ao pedido de exclusão, uma categoria com mais de um caminho e o horário “155h” em um lembrete. Nesses casos, pedir esclarecimento pode ser o resultado correto.', '',
    ...models.map(m => `- **${m.model}** obteve ${fraction(m.ambiguous.passed, m.ambiguous.graded)} nas execuções concluídas.`),
    '', '## Acerto por cenário', '',
    'Cada célula mostra a contagem de acertos sobre as execuções avaliadas. O sufixo T identifica as falhas técnicas adicionais.', '',
    '| Cenário | ' + models.map(m => m.model).join(' | ') + ' |',
    '| --- | ' + models.map(() => '---:').join(' | ') + ' |',
  ];
  for (const c of cases) {
    const cells = models.map(m => {
      const score = c.byModel[m.model];
      return (score.graded ? score.passed + '/' + score.graded : '—') + (score.technical ? ' + ' + score.technical + ' T' : '');
    });
    parts.push('| ' + cell(c.id) + ' | ' + cells.join(' | ') + ' |');
  }
  const divergent = cases.filter(c => c.divergent);
  if (divergent.length) {
    parts.push('', '## Exemplos com resultados diferentes', '', 'A seleção abaixo compara, no mesmo pedido, um resultado aprovado e um reprovado pela rubrica. Quando há evidência, o trecho identifica a condição que deixou de ser atendida.', '');
    for (const c of divergent.slice(0, 6)) {
      const comparable = rows.filter(row => row.id === c.id && !hasTechnicalError(row));
      const failed = comparable.find(row => !row.passed && comparable.some(other => other.model !== row.model && other.passed));
      if (!failed) continue;
      const passed = comparable.find(row => row.passed && row.model !== failed.model && row.rep === failed.rep)
        ?? comparable.find(row => row.passed && row.model !== failed.model);
      const note = Array.isArray(failed.notes) ? failed.notes.join(', ') : failed.notes;
      parts.push(`- **${cell(c.text || c.id)}** — ${passed.model} passou na repetição ${passed.rep}. ${failed.model} falhou na repetição ${failed.rep}.${note ? ' Critério registrado — ' + cell(short(note)) : ''}`);
    }
  }
  return parts.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, report, json] = process.argv.slice(2);
  if (!input || !report) throw new Error('Uso: node evals/whatsapp-comparison-report.mjs resultados.jsonl relatorio.md [resumo.json]');
  const lines = (await readFile(input, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const rows = lines.map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error('JSON inválido na linha ' + (i + 1)); }
  });
  const summary = summarize(rows);
  await writeFile(report, renderMarkdown(summary, rows), 'utf8');
  if (json) await writeFile(json, JSON.stringify(summary, null, 2) + '\n', 'utf8');
}
