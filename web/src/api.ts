import { t } from './i18n';
export class APIError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(t(message)); }
}

export async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let value: unknown;
  try { value = await response.json(); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  if (typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' && 'message' in value && typeof value.message === 'string') {
    throw new APIError(response.status, value.code, value.message);
  }
  // Proxies and HTTP infrastructure can return HTML, text, or an empty body.
  // Preserve the status so reconnect can recognize temporary gateway failures.
  throw new APIError(response.status, 'http_error', `${t('请求失败，请稍后重试。')} (HTTP ${response.status})`);
}

export async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await checked(await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return response.json();
}

export function noteAPI(filename: string): string { return `/api/notes/${encodeURIComponent(filename)}`; }

export interface TreeEntry { path: string; folder: boolean; asset?: boolean }

export async function fileEntries(): Promise<TreeEntry[]> {
  const value = await request('/api/workspace/tree');
  if (!Array.isArray(value) || !value.every((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'path' in entry && typeof entry.path === 'string' &&
    'folder' in entry && typeof entry.folder === 'boolean' &&
    (!('asset' in entry) || typeof entry.asset === 'boolean'))) throw new Error('Invalid file tree');
  return value;
}
