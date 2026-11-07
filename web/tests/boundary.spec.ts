import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function login(page: Page) {
  await page.goto('/note/'); await page.getByLabel('服务密码').fill('p1-test-password');
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
}
async function create(page: Page, filename: string, markdown = '# 边界验证\n\n正文。\n') {
  const origin = new URL(page.url()).origin;
  expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown } })).status()).toBe(201);
  return origin;
}

test('a room accepts 16 connections, rejects the seventeenth, and releases a disconnected slot', async ({ page }) => {
  await login(page); await create(page, '连接边界.md');
  await page.goto('/note/' + encodeURIComponent('连接边界.md'));
  await expect(page.getByRole('status')).toHaveText('已保存');
  const result = await page.evaluate(async () => {
    const { buildId } = await (await fetch('/api/config')).json();
    const sockets: WebSocket[] = [];
    async function join(id: number): Promise<string> {
      const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/notes/' + encodeURIComponent('连接边界.md') + '/ws');
      sockets.push(ws);
      return await new Promise((resolve, reject) => {
        ws.onopen = () => ws.send(JSON.stringify({ type: 'join', buildId, clientId: id, name: '边界成员', color: '#2563eb' }));
        ws.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'init') resolve('init'); else if (message.type === 'error') resolve(message.code); };
        ws.onerror = () => reject(new Error('Boundary socket transport failed'));
        ws.onclose = () => reject(new Error('Boundary socket closed before join response'));
      });
    }
    try {
      const accepted = [];
      for (let index = 0; index < 15; index++) accepted.push(await join(100000 + index));
      const rejected = await join(200000);
      await new Promise<void>(resolve => { sockets[0].onclose = () => resolve(); sockets[0].close(); });
      // The close frame is handled before the server removes ownership. The
      // next handshake is independently processed after that close completes.
      const replacement = await join(300000);
      return { accepted, rejected, replacement };
    } finally { for (const socket of sockets) socket.close(); }
  });
  expect(result.accepted).toEqual(Array(15).fill('init'));
  expect(result.rejected).toBe('room_full'); expect(result.replacement).toBe('init');
  await expect(page.getByRole('status')).toHaveText('已保存');
});

test('malformed socket messages and cross-origin writes remain explicit input errors', async ({ page }) => {
  await login(page); const origin = await create(page, '畸形消息.md');
  const codes = await page.evaluate(async () => {
    const payloads: (string | ArrayBuffer)[] = ['{', JSON.stringify({ type: 'join', unknown: true }), new Uint8Array([1, 2, 3]).buffer];
    const codes = [];
    for (const payload of payloads) {
      const code = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/notes/' + encodeURIComponent('畸形消息.md') + '/ws');
        socket.onopen = () => socket.send(payload);
        socket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'error') { resolve(message.code); socket.close(); } };
        socket.onerror = () => reject(new Error('Socket transport error'));
        socket.onclose = () => reject(new Error('Missing explicit invalid message response'));
      });
      codes.push(code);
    }
    return codes;
  });
  expect(codes).toEqual(Array(3).fill('invalid_message'));
  expect((await page.request.post('/api/notes', { headers: { Origin: 'http://other.invalid' }, data: { filename: '不可创建.md', markdown: '' } })).status()).toBe(403);
  const session = await page.request.get('/api/session'); expect(session.status()).toBe(200);
  expect((await page.request.get(origin + '/api/notes/' + encodeURIComponent('畸形消息.md'))).status()).toBe(200);
});

test('oversize upload is rejected before publishing any asset and service remains usable', async ({ page }) => {
  await login(page); const origin = await create(page, '上传大小.md');
  const response = await page.request.post('/api/notes/' + encodeURIComponent('上传大小.md') + '/assets', {
    headers: { Origin: origin }, multipart: { sourceKind: 'file', file: { name: '过大.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(50 * 1024 * 1024 + 1) } },
  });
  expect(response.status()).toBe(413);
  expect((await page.request.get('/note/static/' + encodeURIComponent('过大.bin'))).status()).toBe(404);
  expect((await page.request.get('/api/session')).status()).toBe(200);
  const largeNote = await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename: '过大正文.md', markdown: 'x'.repeat(1024 * 1024 + 1) } });
  expect(largeNote.status()).toBe(400); expect((await largeNote.json()).code).toBe('invalid_markdown');
  expect((await page.request.get('/api/notes/' + encodeURIComponent('过大正文.md'))).status()).toBe(404);
  const exact = Buffer.alloc(50 * 1024 * 1024);
  const accepted = await page.request.post('/api/notes/' + encodeURIComponent('上传大小.md') + '/assets', {
    headers: { Origin: origin }, multipart: { sourceKind: 'file', file: { name: '刚好上限.bin', mimeType: 'application/octet-stream', buffer: exact } },
  });
  expect(accepted.status()).toBe(200); expect((await accepted.json()).kind).toBe('attachment');
  const download = await page.request.get('/note/static/' + encodeURIComponent('刚好上限.bin'));
  expect(download.headers()['content-length']).toBe(String(exact.length));
  expect((await download.body()).equals(exact)).toBe(true);
});

test('embedded editor and print resources work with every external page request blocked', async ({ page }, testInfo) => {
  const filename = `离线资源-${testInfo.repeatEachIndex}.md`;
  const imageName = `离线图片-${testInfo.repeatEachIndex}.png`;
  const external: string[] = []; const localFonts: string[] = [];
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:18081') { external.push(url.origin); return route.abort(); }
    if (/\.(woff2?|ttf)(\?|$)/.test(url.pathname)) localFonts.push(url.pathname);
    return route.continue();
  });
  await login(page); const origin = await create(page, filename, '# 中文与公式\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n![本地图片](static/' + imageName + ')\n');
  expect((await page.request.post('/api/notes/' + encodeURIComponent(filename) + '/assets', { headers: { Origin: origin }, multipart: { sourceKind: 'file', file: { name: imageName, mimeType: 'image/png', buffer: await readFile('tests/fixtures/image.png') } } })).status()).toBe(200);
  await page.goto('/note/' + encodeURIComponent(filename)); await expect(page.getByRole('status')).toHaveText('已保存');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view [role="status"]')).toHaveText('可打印');
  expect(await page.locator('.print-body img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(localFonts.length).toBeGreaterThan(0); expect(external).toEqual([]);
  await page.getByRole('button', { name: '关闭打印预览' }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
});

test('oversize decoded CRDT update is rejected without changing the saved revision', async ({ page }) => {
  await login(page); await create(page, '更新大小.md');
  await page.goto('/note/' + encodeURIComponent('更新大小.md')); await expect(page.getByRole('status')).toHaveText('已保存');
  const endpoint = '/api/notes/' + encodeURIComponent('更新大小.md');
  const before = await (await page.request.get(endpoint)).json();
  const result = await page.evaluate(async () => {
    const { buildId } = await (await fetch('/api/config')).json();
    return await new Promise<{ code: string; message: string }>((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/notes/' + encodeURIComponent('更新大小.md') + '/ws');
      socket.onopen = () => socket.send(JSON.stringify({ type: 'join', buildId, clientId: 910001, name: 'size-probe', color: '#2563eb' }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'init') socket.send(JSON.stringify({ type: 'update', messageId: 'oversize', data: btoa('\0'.repeat(16 * 1024 * 1024 + 1)) }));
        if (message.type === 'error') { resolve({ code: message.code, message: message.message }); socket.close(); }
      };
      socket.onerror = () => reject(new Error('Unexpected transport failure before explicit CRDT error'));
      socket.onclose = () => reject(new Error('Missing explicit CRDT size error'));
    });
  });
  expect(result.code).toBe('invalid_update'); expect(result.message).toContain('大小');
  expect(await (await page.request.get(endpoint)).json()).toEqual(before);
  await expect(page.getByRole('status')).toHaveText('已保存');
});

test('24 MiB JSON websocket message is accepted and one extra byte closes with 1009', async ({ page }) => {
  await login(page); await create(page, '帧大小.md');
  await page.goto('/note/' + encodeURIComponent('帧大小.md')); await expect(page.getByRole('status')).toHaveText('已保存');
  const endpoint = '/api/notes/' + encodeURIComponent('帧大小.md'); const before = await (await page.request.get(endpoint)).json();
  const results = await page.evaluate(async () => {
    const { buildId } = await (await fetch('/api/config')).json();
    const results: string[] = [];
    for (const extra of [0, 1]) {
      results.push(await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/notes/' + encodeURIComponent('帧大小.md') + '/ws');
        socket.onopen = () => {
          const header = JSON.stringify({ type: 'join', buildId, clientId: 920001 + extra, name: 'frame-probe', color: '#2563eb' });
          socket.send(header + ' '.repeat(24 * 1024 * 1024 + extra - header.length));
        };
        socket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'init') { resolve('init'); socket.close(); } else if (message.type === 'error') reject(new Error(message.code)); };
        socket.onclose = event => resolve(`close:${event.code}`);
        socket.onerror = () => reject(new Error('Unexpected frame transport failure'));
      }));
    }
    return results;
  });
  expect(results).toEqual(['init', 'close:1009']);
  expect(await (await page.request.get(endpoint)).json()).toEqual(before);
  await expect(page.getByRole('status')).toHaveText('已保存');
});
