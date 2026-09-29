import type { Fetch } from './types.js';
import { PublicError } from './types.js';
export async function jsonRequest(fetcher: Fetch, url: string, init: RequestInit = {}, timeoutMs = 45_000): Promise<any> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new PublicError('O serviço não respondeu. Consulte o estado antes de repetir uma operação.'); }
  if (!response.ok) throw new PublicError(response.status === 401 || response.status === 403
    ? 'A conexão não está autorizada. Reconecte a aplicação.' : 'O serviço não concluiu a solicitação. Tente consultar novamente mais tarde.');
  const text = await response.text();
  if (text.length > 2_000_000) throw new PublicError('A resposta ultrapassou o limite. Consulte um período menor.');
  try { return JSON.parse(text); } catch { throw new PublicError('Resposta inválida do serviço.'); }
}
