import * as Y from 'yjs';

export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function fullUpdate(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}
