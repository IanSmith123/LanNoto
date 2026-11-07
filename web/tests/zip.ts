import { expect } from '@playwright/test';
import { inflateRawSync } from 'node:zlib';

export function unzip(data: Buffer): Map<string, Buffer> {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); expect(end).toBeGreaterThanOrEqual(0);
  const count = data.readUInt16LE(end + 10), entries = new Map<string, Buffer>(); let offset = data.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    expect(data.readUInt32LE(offset)).toBe(0x02014b50);
    const method = data.readUInt16LE(offset + 10), size = data.readUInt32LE(offset + 20), length = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32), local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + length).toString('utf8');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28), compressed = data.subarray(start, start + size);
    expect(entries.has(name)).toBe(false); entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed); offset += 46 + length + extra + comment;
  }
  return entries;
}
