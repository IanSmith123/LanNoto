import { t } from './i18n';
export class APIError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(t(message)); }
}

export async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value: unknown = await response.json();
  if (!response.ok) {
    if (typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' && 'message' in value && typeof value.message === 'string') {
      throw new APIError(response.status, value.code, value.message);
    }
    throw new Error(`Invalid error response (${response.status})`);
  }
  return value;
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
