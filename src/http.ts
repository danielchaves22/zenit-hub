import type { Fetch } from './types.js';
import { PublicError } from './types.js';
export class HttpError extends PublicError {
  constructor(readonly status: number, readonly code?: string) {
    super(status === 401 || status === 403
      ? 'A conexão não está autorizada. Reconecte a aplicação.'
      : 'O serviço não concluiu a solicitação. Tente consultar novamente mais tarde.');
  }
}
export async function jsonRequest(fetcher: Fetch, url: string, init: RequestInit = {}, timeoutMs = 45_000): Promise<any> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new PublicError('O serviço não respondeu. Consulte o estado antes de repetir uma operação.'); }
  if (!response.ok) {
    // Keep only known machine codes, never provider messages, bodies or credentials.
    let code: string | undefined;
    try {
      const body = await response.json();
      const candidate = body.error_code ?? body.code ?? body.error;
      if (['invalid_grant', 'refresh_token_not_found', 'refresh_token_already_used', 'invalid_client'].includes(candidate)) code = candidate;
    } catch { /* A non-JSON error still has an HTTP status. */ }
    throw new HttpError(response.status, code);
  }
  const text = await response.text();
  if (text.length > 2_000_000) throw new PublicError('A resposta ultrapassou o limite. Consulte um período menor.');
  try { return JSON.parse(text); } catch { throw new PublicError('Resposta inválida do serviço.'); }
}
