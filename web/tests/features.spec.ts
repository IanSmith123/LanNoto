import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { copyFile, readFile, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzip } from './zip';

const image = resolve('tests/fixtures/image.png');

test('Mermaid previews render locally, preserve source and update after edits and theme changes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const external: string[] = [];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:18081') { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const filename = 'Mermaid 图表.md', markdown = '# 图表\n\n```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```\n';
  const origin = await create(page, filename, markdown); await open(page, filename);
  const preview = page.locator('#note-editor .mermaid-preview');
  await expect(preview.locator('svg')).toBeVisible();
  await expect(preview).toContainText('开始'); await expect(preview).toContainText('完成');
  const revision = await page.getByRole('status').getAttribute('data-saved-revision');
  const exported = await page.request.post(`/api/notes/${encodeURIComponent(filename)}/export`, { headers: { Origin: origin }, data: { format: 'markdown', revision: Number(revision) } });
  expect(await exported.text()).toBe(markdown);
  const word = await page.request.post(`/api/notes/${encodeURIComponent(filename)}/export`, { headers: { Origin: origin }, data: { format: 'docx', revision: Number(revision) } });
  expect(word.status()).toBe(422); expect((await word.json()).message).toContain('先在浏览器渲染');
  const light = await preview.locator('svg').innerHTML();
  await page.getByRole('button', { name: '切换夜间模式' }).click();
  await expect.poll(() => preview.locator('svg').innerHTML()).not.toBe(light);
  expect(await page.getByRole('status').getAttribute('data-saved-revision')).toBe(revision);
  const peer = await page.context().newPage();
  try {
    await peer.goto(`/note/${encodeURIComponent(filename)}`); await expect(peer.getByRole('status')).toHaveText('已保存');
    await peer.getByRole('button', { name: '源码', exact: true }).click();
    const source = peer.getByRole('textbox', { name: 'Markdown 源码' }); await source.click(); await peer.keyboard.press('Control+a');
    await peer.keyboard.insertText('# 图表\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: 你好\n```\n');
    await expect(peer.getByRole('status')).toHaveText('已保存');
    await expect(preview.locator('svg')).toBeVisible(); await expect(preview).toContainText('你好');
  } finally { await peer.close(); }
  expect(external).toEqual([]); expect(errors).toEqual([]);
});

test('Mermaid previews finish when nearby code blocks mount together', async ({ page }) => {
  const filename = '相邻 Mermaid 图表.md';
  const markdown = [
    '## 7.2 时序图',
    '',
    '```mermaid',
    'sequenceDiagram',
    '    participant A as Tom 的浏览器',
    '    participant S as LanNoto 服务',
    '    participant B as Tim 的浏览器',
    '    A->>S: 修改 Markdown',
    '    S-->>A: 确认更新',
    '    S-->>B: 同步正文',
    '    A->>S: Ctrl+S 保存',
    '    S-->>A: 保存与历史记录完成',
    '```',
    '',
    '## 7.3 状态图',
    '',
    '```mermaid',
    'stateDiagram-v2',
    '    [*] --> Saved',
    '```',
  ].join('\n');
  await page.setViewportSize({ width: 1280, height: 1200 });
  await create(page, filename, markdown); await open(page, filename);
  const previews = page.locator('#note-editor .mermaid-preview');
  await expect(previews).toHaveCount(2);
  await expect(previews.nth(0).locator('svg')).toContainText('保存与历史记录完成');
  await expect(previews.nth(1).locator('svg')).toContainText('Saved');
});

test('printing eagerly renders offscreen Mermaid diagrams and errors remain recoverable', async ({ page }) => {
  const filename = 'Mermaid 打印.md';
  await create(page, filename, '# 打印图表\n\n' + '长正文。\n\n'.repeat(90) + '```mermaid\nflowchart LR\n  A[离屏图表] --> B[打印完成]\n```\n'); await open(page, filename);
  const savedRevision = await page.getByRole('status').getAttribute('data-saved-revision');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  const print = page.getByRole('region', { name: '打印预览' });
  await expect(print.getByRole('status')).toHaveText('可打印');
  const image = print.locator('img[src^="blob:"]');
  await expect(image).toHaveCount(1);
  expect(await image.evaluate(node => node instanceof HTMLImageElement && node.naturalWidth > 0)).toBe(true);
  await print.getByRole('button', { name: '关闭打印预览' }).click();
  expect(await page.getByRole('status').getAttribute('data-saved-revision')).toBe(savedRevision);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' }); await source.click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('```mermaid\nflowchart LR\nA --> [\n```\n');
  await expect(page.getByRole('status')).toHaveText('已保存'); await page.getByRole('button', { name: '所见即所得', exact: true }).click();
  await expect(page.locator('.mermaid-preview[role="alert"]')).toContainText('Mermaid 语法或渲染错误');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(print.getByRole('status')).toContainText('Mermaid 语法或渲染错误'); await expect(print.getByRole('button', { name: '打印', exact: true })).toBeDisabled();
  await print.getByRole('button', { name: '关闭打印预览' }).click();
  await page.getByRole('button', { name: '源码', exact: true }).click(); await source.click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('```mermaid\nflowchart LR\nA --> B\n```\n');
  await page.getByRole('button', { name: '所见即所得', exact: true }).click(); await expect(page.locator('.mermaid-preview svg')).toBeVisible();
});

test('source is the live authoritative Markdown and switching views preserves its bytes', async ({ page, browser }) => {
  const original = '#   标题\n\n* a\n* b\n\n|a|b|\n|-|-|\n|1|2|\n\n```text\n\t😀\n```\n\n尾部  \n换行\n\n';
  const filename = '原文协作.md'; const origin = await create(page, filename, original); await open(page, filename);
  const exported = async () => {
    const revision = Number(await page.getByRole('status').getAttribute('data-saved-revision'));
    const response = await page.request.post(`/api/notes/${encodeURIComponent(filename)}/export`, { headers: { Origin: origin }, data: { format: 'markdown', revision } });
    expect(response.ok()).toBe(true); return response.text();
  };
  expect(await exported()).toBe(original);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' }); await expect(source).toBeVisible();
  expect(await source.innerText()).toContain('标题');
  await page.getByRole('button', { name: '所见即所得' }).click(); await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click(); expect(await exported()).toBe(original);
  const context = await browser.newContext({ locale: 'zh-CN' }); const peer = await context.newPage();
  try {
    await peer.goto(`/note/${encodeURIComponent(filename)}`); await peer.getByLabel('服务密码').fill('p1-test-password'); await peer.getByRole('button', { name: '进入工作区' }).click();
    await expect(peer.getByRole('status')).toHaveText('已保存');
    await page.getByRole('button', { name: '源码', exact: true }).click();
    await source.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('源码实时新增😀');
    await expect(peer.locator('#note-editor')).toContainText('源码实时新增😀');
    await peer.locator('#note-editor p').last().click(); await peer.keyboard.press('End'); await peer.keyboard.insertText('所见即所得新增');
    await expect(source).toContainText('所见即所得新增');
    await page.keyboard.press('Control+s'); await expect(page.getByRole('status')).toHaveText('已保存');
    expect(await exported()).toBe(original + '源码实时新增😀所见即所得新增');
    await source.click(); await page.keyboard.press('Control+z');
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect(await exported()).toBe(original + '所见即所得新增');
    await page.keyboard.press('Control+Shift+Z');
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect(await exported()).toBe(original + '源码实时新增😀所见即所得新增');
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存');
    await expect(page.locator('#note-editor')).toContainText('源码实时新增😀所见即所得新增');
  } finally { await context.close(); }
});

test('source clipboard preserves CRLF, tabs and Unicode and offline edits sync after reconnect', async ({ page }) => {
  let disconnect: (() => void) | undefined;
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer();
    disconnect = () => { socket.close({ code: 1012 }); server.close({ code: 1012 }); };
  });
  const filename = '源码剪贴板.md', original = '#   CRLF\r\n\r\n\t😀源码\r\n';
  const origin = await create(page, filename, original); await open(page, filename);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' }); await source.click();
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
  // Windows native clipboard text uses CRLF. Compare logical newlines here,
  // and separately verify exact disk bytes via the saved export below.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(original.replace(/\r\n/g, '\n'));
  const inserted = '# 精细粘贴😀\n\n```text\n\t中英文\n```\n';
  await page.evaluate(value => navigator.clipboard.writeText(value), inserted);
  await page.keyboard.press('Control+v'); await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toHaveText('已保存');
  const revision = Number(await page.getByRole('status').getAttribute('data-saved-revision'));
  const exported = await page.request.post(`/api/notes/${encodeURIComponent(filename)}/export`, { headers: { Origin: origin }, data: { format: 'markdown', revision } });
  expect((await exported.text()).replace(/\r\n/g, '\n')).toBe(inserted);
  await page.context().setOffline(true);
  disconnect?.();
  await expect(page.getByRole('status')).toContainText('连接中断');
  await expect(source).toHaveAttribute('contenteditable', 'true');
  await source.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('离线源码修改😀');
  await expect(source).toContainText('离线源码修改😀');
  await page.context().setOffline(false);
  await expect(page.getByRole('status')).toHaveText('已保存'); await expect(source).toHaveAttribute('contenteditable', 'true');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor')).toContainText('离线源码修改😀');
});

test('preferences persist and Ctrl+S saves the current note without downloading', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto('/note/');
    await page.getByLabel('Workspace password').fill('p1-test-password');
    await page.getByRole('button', { name: 'Open workspace' }).click();
    const name = page.getByRole('button', { name: 'Edit username' });
    await expect(name).toHaveText(/^[A-Z][a-z]+$/);
    await name.click(); await page.getByLabel('Username', { exact: true }).fill('Tom Example');
    await page.getByLabel('Username', { exact: true }).press('Enter');
    await expect(name).toHaveText('Tom Example');
    await page.getByRole('button', { name: 'Toggle dark mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const origin = new URL(page.url()).origin;
    expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename: 'preferences.md', markdown: '# Preferences\n\nOriginal.\n' } })).status()).toBe(201);
    await page.goto('/note/preferences.md');
    await expect(page.getByRole('status')).toHaveText('Saved');
    let downloads = 0; page.on('download', () => downloads++);
    await page.locator('#note-editor p').click(); await page.keyboard.press('End'); await page.keyboard.insertText(' Saved with shortcut.');
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status')).toHaveText('Saved');
    await expect(page.getByLabel('Online members')).toContainText('1 online');
    expect(downloads).toBe(0);
    await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await expect(page.getByRole('button', { name: '修改用户名' })).toHaveText('Tom Example');
    await expect(page.getByRole('status')).toHaveText('已保存');
    await expect(page.locator('#note-editor')).toContainText('Saved with shortcut.');
    const freshPage = await context.newPage(); await freshPage.goto('/note/preferences.md');
    await expect(freshPage.getByRole('button', { name: '修改用户名' })).toHaveText('Tom Example');
    await expect(freshPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    const cookies = await context.cookies();
    for (const key of ['lannoto-name', 'lannoto-language', 'lannoto-theme']) expect(cookies.find(cookie => cookie.name === key)?.expires).toBeGreaterThan(Date.now() / 1000);
  } finally { await context.close(); }
});

test('four isolated browsers converge and save a 64 KiB note', async ({ page, browser }) => {
  test.setTimeout(60000);
  const markdown = '# 性能验证\n\n' + Array.from({ length: 256 }, (_, index) => `段落${index} ` + 'x'.repeat(250)).join('\n\n') + '\n';
  expect(Buffer.byteLength(markdown)).toBeGreaterThanOrEqual(65536);
  const filename = '四人性能.md';
  await create(page, filename, markdown); await open(page, filename);
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ locale: 'zh-CN' })));
  try {
    const pages = [page, ...await Promise.all(contexts.map(context => context.newPage()))];
    await Promise.all(pages.slice(1).map(async peer => {
      await peer.goto('/note/'); await peer.getByLabel('服务密码').fill('p1-test-password');
      await peer.getByRole('button', { name: '进入工作区' }).click();
      await expect(peer.getByRole('heading', { name: '你的团队笔记' })).toBeVisible(); await open(peer, filename);
    }));
    await expect(page.getByLabel('在线成员')).toContainText('4 人在线');
    const rounds: { convergedMs: number; savedMs: number }[] = [];
    for (let round = 0; round < 10; round++) {
      const start = performance.now();
      await Promise.all(pages.map(async (peer, index) => {
        await peer.locator('#note-editor p').nth(index * 50).click();
        await peer.keyboard.press('Home'); await peer.keyboard.insertText(`成员${index}第${round}轮标记`);
      }));
      await Promise.all(pages.map(async peer => {
        for (let index = 0; index < 4; index++) await expect(peer.locator('#note-editor')).toContainText(`成员${index}第${round}轮标记`);
      }));
      const convergedMs = performance.now() - start;
      await Promise.all(pages.map(peer => expect(peer.getByRole('status')).toHaveText('已保存')));
      rounds.push({ convergedMs, savedMs: performance.now() - start });
    }
    await mkdir('../tests/artifacts', { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile('../tests/artifacts/performance.json', JSON.stringify({ bytes: Buffer.byteLength(markdown), peers: 4, rounds, scope: 'local Chrome, includes browser automation and assertions; ten consecutive rounds with four concurrent writers each' }, null, 2));
    expect((await page.request.get('/api/notes/' + encodeURIComponent(filename))).status()).toBe(200);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

async function create(page: Page, filename: string, markdown = '# 功能测试\n\n正文。\n') {
  await page.goto('/note/');
  await page.getByLabel('服务密码').fill('p1-test-password');
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown } });
  expect(response.status()).toBe(201);
  return origin;
}
async function open(page: Page, filename: string) {
  await page.goto(`/note/${encodeURIComponent(filename)}`);
  await expect(page.getByRole('status')).toHaveText('已保存');
}

test('file picker uploads one image and ordinary attachment, preserving names and protected bytes', async ({ page, browser }) => {
  const filename = '选择上传.md'; const origin = await create(page, filename); await open(page, filename);
  let uploads = 0; page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/assets')) uploads++; });
  await page.locator('#upload-files').setInputFiles([{ name: '原名 image.png', mimeType: 'image/png', buffer: await readFile(image) }]);
  const uploadStatus = page.locator('.sidebar-section-heading .upload-status');
  await expect(uploadStatus).toHaveText('已插入 原名 image.png');
  await expect(uploadStatus).toHaveAttribute('title', '已插入 原名 image.png');
  await expect(page.locator('#note-editor img')).toBeVisible();
  expect(await page.locator('#note-editor img').evaluate((node) => node instanceof HTMLImageElement && node.naturalWidth > 0)).toBe(true);
  await page.locator('#upload-files').setInputFiles([{ name: '需求 说明.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nattachment bytes') }]);
  await expect(page.locator('#note-editor').getByRole('link', { name: '需求 说明.pdf' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存');
  expect(uploads).toBe(2);
  const asset = await page.request.get('/note/static/' + encodeURIComponent('原名 image.png'));
  expect(asset.status()).toBe(200); expect(asset.headers()['content-type']).toBe('image/png');
  expect((await asset.body()).equals(await readFile(image))).toBe(true);
  const attachment = await page.request.get('/note/static/' + encodeURIComponent('需求 说明.pdf'));
  expect(attachment.headers()['content-disposition'].startsWith('attachment')).toBe(true);
  expect(attachment.headers()['x-content-type-options']).toBe('nosniff');
  const other = await browser.newContext({ locale: 'zh-CN' });
  try { expect((await other.request.get(origin + '/note/static/' + encodeURIComponent('原名 image.png'))).status()).toBe(401); }
  finally { await other.close(); }
});

test('a pasted file with a filesystem entry keeps its original name', async ({ page }) => {
  const filename = '原名粘贴测试.md'; await create(page, filename); await open(page, filename);
  const directory = await mkdtemp(resolve('../tests/artifacts/paste-files-'));
  const bitmap = resolve(directory, 'image.webp');
  const attachment = resolve(directory, '普通附件.txt');
  await copyFile(resolve('../internal/storage/testdata/bitmap.webp'), bitmap);
  await writeFile(attachment, 'Attachment contents');

  const editor = page.locator('#note-editor').getByRole('textbox').first();
  await editor.evaluate(node => {
    // Chromium provides native filesystem entries on a DevTools file drop.
    // Forward that payload to the paste handler while its entries are readable.
    document.addEventListener('drop', event => {
      const data = event.dataTransfer;
      if (!data || ![...data.items].every(item => item.webkitGetAsEntry()?.isFile)) return;
      event.preventDefault(); event.stopPropagation();
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, { capture: true, once: true });
  });
  const position = await editor.boundingBox();
  if (!position) throw new Error('Missing editor position');
  const client = await page.context().newCDPSession(page);
  const payload = {
    x: position.x + 8,
    y: position.y + 8,
    data: { items: [], files: [bitmap, attachment], dragOperationsMask: 1 },
  };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await client.send('Input.dispatchDragEvent', { type, ...payload });
  }
  await expect(page.locator('#note-editor img[src$="/image.webp"]')).toBeVisible();
  await expect(page.locator('#note-editor').getByRole('link', { name: '普通附件.txt' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('已保存');
  const asset = await page.request.get('/note/static/image.webp');
  expect((await asset.body()).equals(await readFile(bitmap))).toBe(true);
});

test('static browser previews text, images and PDF, and confirms archive downloads', async ({ page }) => {
  const filename = '静态文件浏览.md';
  const origin = await create(page, filename);
  await open(page, filename);
  const pdfPage = await page.context().newPage();
  await pdfPage.setContent('<p>PDF preview test</p>');
  const pdf = await pdfPage.pdf();
  await pdfPage.close();
  const archive = await page.request.post('/api/workspace/export', { headers: { Origin: origin }, data: {} });
  expect(archive.ok()).toBe(true);
  const zip = await archive.body();
  const wideImage = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2200;
    canvas.height = 1100;
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#upload-files').setInputFiles([
    { name: '预览说明.txt', mimeType: 'text/plain', buffer: Buffer.from('<script>preview as plain text</script>') },
    { name: '预览图片.png', mimeType: 'image/png', buffer: Buffer.from(wideImage, 'base64') },
    { name: '预览报告.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: '预览归档.zip', mimeType: 'application/zip', buffer: zip },
  ]);
  await page.getByRole('button', { name: '展开文件夹 static' }).click();
  const sidebar = page.getByRole('navigation', { name: '笔记文件' });
  const dialog = page.getByRole('dialog');
  for (const name of ['预览说明.txt', '预览图片.png', '预览报告.pdf']) {
    await sidebar.getByRole('button', { name, exact: true }).click();
    await expect(dialog).toHaveAccessibleName(name);
    const frame = dialog.frameLocator('iframe');
    if (name.endsWith('.txt')) await expect(frame.locator('body')).toHaveText('<script>preview as plain text</script>');
    if (name.endsWith('.png')) {
      const image = dialog.getByRole('img', { name });
      await expect(image).toBeVisible();
      const fits = await image.evaluate((node: HTMLImageElement) => {
        const bounds = node.getBoundingClientRect();
        const stage = node.parentElement!.getBoundingClientRect();
        return bounds.width < node.naturalWidth && bounds.width <= stage.width && bounds.height <= stage.height &&
          Math.abs(bounds.width / bounds.height - 2) < 0.01 &&
          Math.abs((bounds.left + bounds.right) - (stage.left + stage.right)) < 2 &&
          Math.abs((bounds.top + bounds.bottom) - (stage.top + stage.bottom)) < 2;
      });
      expect(fits).toBe(true);
      await page.mouse.click(5, 5);
      await expect(dialog).toHaveCount(0);
      continue;
    }
    if (name.endsWith('.pdf')) await expect(dialog.locator('iframe')).toHaveAttribute('src', /\.pdf\?preview=1$/);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  }
  const archiveButton = sidebar.getByRole('button', { name: '预览归档.zip', exact: true });
  let downloads = 0;
  page.on('download', () => downloads++);
  await archiveButton.click();
  await expect(dialog).toHaveAccessibleName('是否下载此文件？');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(downloads).toBe(0);
  await archiveButton.click();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载文件', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('预览归档.zip');
  expect(await readFile(await download.path())).toEqual(zip);
  await expect(page).toHaveURL('/note/' + encodeURIComponent(filename));
});

test('attachments move into and out of static folders without losing their bytes', async ({ page }) => {
  const filename = '附件移动.md';
  const origin = await create(page, filename);
  await open(page, filename);
  for (const path of ['static/子目录', '资料']) {
    const response = await page.request.post('/api/workspace/folders', { headers: { Origin: origin }, data: { path } });
    expect(response.status()).toBe(201);
  }
  const asset = '拖动附件.txt';
  const content = 'Attachment contents';
  await page.locator('#upload-files').setInputFiles([{ name: asset, mimeType: 'text/plain', buffer: Buffer.from(content) }]);
  await page.getByRole('button', { name: '展开文件夹 static' }).click();
  const sidebar = page.getByRole('navigation', { name: '笔记文件' });
  const file = sidebar.getByRole('button', { name: asset, exact: true });
  const folder = (name: string) => sidebar.getByRole('button', { name, exact: true });
  const assetURL = (path: string) => '/note/' + path.split('/').map(encodeURIComponent).join('/');
  let oldPath = 'static/' + asset;
  for (const [target, directory] of [[folder('子目录'), 'static/子目录'], [folder('资料'), '资料'],
    [page.getByRole('heading', { name: '笔记文件' }), ''], [folder('static'), 'static']] as const) {
    const next = directory ? directory + '/' + asset : asset;
    const moved = page.waitForResponse(response => response.url().endsWith('/api/workspace/move'));
    await file.hover({ position: { x: 12, y: 8 } });
    const source = await file.boundingBox();
    if (!source) throw new Error('Missing draggable file');
    await page.mouse.down();
    await page.mouse.move(source.x + 28, source.y + 8, { steps: 4 });
    await target.hover({ position: { x: 12, y: 8 } });
    await target.hover({ position: { x: 16, y: 8 } });
    await page.mouse.up();
    const result = await moved;
    expect(result.status(), await result.text()).toBe(200);
    await expect(file).toHaveAttribute('title', next);
    expect((await page.request.get(assetURL(oldPath))).status()).toBe(404);
    const response = await page.request.get(assetURL(next));
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe(content);
    oldPath = next;
  }
  await file.click();
  await expect(page.getByRole('dialog', { name: asset }).frameLocator('iframe').locator('body')).toHaveText(content);
});

test('ambiguous browser paste asks for source, inserts once and cancellation does not upload', async ({ page }) => {
  const filename = '粘贴测试.md'; await create(page, filename); await open(page, filename);
  let uploads = 0; page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/assets')) uploads++; });
  const bytes = [...await readFile(image)];
  async function paste() {
    await page.locator('#note-editor').getByRole('textbox').first().evaluate((node, bytes) => {
      const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, bytes);
  }
  // This tests browser event routing and the explicit choice, not OS clipboard provenance.
  await paste(); await expect(page.getByRole('dialog')).toBeVisible(); expect(uploads).toBe(0);
  await page.getByRole('button', { name: '保留文件名', exact: true }).click();
  await expect(page.locator('.upload-status')).toHaveText('已插入 image.png'); expect(uploads).toBe(1);
  await paste(); await page.getByRole('button', { name: '按截图时间命名' }).click();
  await expect(page.locator('.upload-status')).toHaveText(/已插入 \d{14}\.png/); expect(uploads).toBe(2);
  await paste(); await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.upload-status')).toHaveText('已取消上传'); expect(uploads).toBe(2);
  await expect(page.getByRole('status')).toHaveText('已保存');
});

test('drop preserves filename and active formats remain download-only; conflicts and bad paths are explicit', async ({ page }) => {
  const filename = '拖放测试.md'; const origin = await create(page, filename); await open(page, filename);
  await page.locator('#note-editor').getByRole('textbox').first().evaluate((node) => {
    const data = new DataTransfer(); data.items.add(new File(['<svg onload="alert(1)"></svg>'], '架构图.svg', { type: 'image/svg+xml' }));
    node.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#note-editor').getByRole('link', { name: '架构图.svg' })).toBeVisible();
  expect(await page.locator('#note-editor img').count()).toBe(0);
  const resource = await page.request.get('/note/static/' + encodeURIComponent('架构图.svg'));
  expect(resource.headers()['content-disposition'].startsWith('attachment')).toBe(true);
  expect(resource.headers()['content-security-policy']).toContain('sandbox');
  const api = `/api/notes/${encodeURIComponent(filename)}/assets`;
  const duplicate = await page.request.post(api, { headers: { Origin: origin }, multipart: { sourceKind: 'file', file: { name: '架构图.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('overwrite') } } });
  expect(duplicate.status()).toBe(409);
  const traversal = await page.request.post(api, { headers: { Origin: origin }, multipart: { sourceKind: 'file', file: { name: '../escape.png', mimeType: 'image/png', buffer: await readFile(image) } } });
  expect(traversal.status()).toBe(400);
  const invalid = await page.request.post(api, { headers: { Origin: origin }, multipart: { sourceKind: 'clipboard-image', file: { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('not an image') } } });
  expect(invalid.status()).toBe(400);
  expect((await page.request.get('/api/config')).status()).toBe(200);
});

test('Markdown and real Word download include the saved revision and reject stale/pdf requests', async ({ page }) => {
  const filename = '导出 中文.md'; const origin = await create(page, filename, '# 导出测试\n\n中文正文。\n\n| 名称 | 数值 |\n| --- | --- |\n| 中文 | 42 |\n\n```go\nfmt.Println("你好")\n```\n\n$$\nE = mc^2\n$$\n'); await open(page, filename);
  await mkdir('../tests/artifacts/downloads', { recursive: true });
  const markdownDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 Markdown' }).click();
  const md = await markdownDownload; expect(md.suggestedFilename()).toBe(filename); await md.saveAs('../tests/artifacts/downloads/note.md');
  expect((await readFile('../tests/artifacts/downloads/note.md', 'utf8')).includes('中文正文')).toBe(true);
  const wordDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 Word' }).click();
  const word = await wordDownload; expect(word.suggestedFilename()).toBe('导出 中文.docx'); await word.saveAs('../tests/artifacts/downloads/note.docx');
  expect((await readFile('../tests/artifacts/downloads/note.docx')).subarray(0, 2).toString()).toBe('PK');
  const api = `/api/notes/${encodeURIComponent(filename)}/export`;
  expect((await page.request.post(api, { headers: { Origin: origin }, data: { format: 'pdf', revision: 1 } })).status()).toBe(400);
  expect((await page.request.post(api, { headers: { Origin: origin }, data: { format: 'markdown', revision: 0 } })).status()).toBe(409);
});

test('ordinary editing empty paragraphs exports real Word without rewriting saved Markdown', async ({ page }) => {
  const filename = '编辑空行导出.md';
  const origin = await create(page, filename, '# 正常编辑\n\n前文\n'); await open(page, filename);
  await page.locator('#note-editor p').first().click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.insertText('空行后的正文');
  await expect(page.getByRole('status')).toHaveText('已保存');
  const api = `/api/notes/${encodeURIComponent(filename)}`;
  const metadata = await (await page.request.get(api)).json();
  const request = { headers: { Origin: origin }, data: { format: 'markdown', revision: metadata.revision } };
  const before = await page.request.post(api + '/export', request);
  expect(before.status()).toBe(200);
  const markdown = await before.body();
  expect(markdown.toString()).not.toMatch(/<br\s*\/?\s*>/i);
  expect(markdown.toString()).toContain('空行后的正文');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 Word' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('编辑空行导出.docx');
  await mkdir('../tests/artifacts/downloads', { recursive: true });
  const path = '../tests/artifacts/downloads/editor-empty-paragraphs.docx'; await download.saveAs(path);
  expect((await readFile(path)).subarray(0, 2).toString()).toBe('PK');
  const after = await page.request.post(api + '/export', request);
  expect(after.status()).toBe(200); expect((await after.body()).equals(markdown)).toBe(true);
});

test('print uses an immutable readonly Crepe snapshot without a new collaboration connection', async ({ page, browser }) => {
  const filename = '打印快照.md'; const origin = await create(page, filename, '# 打印测试\n\n快照正文。[^sample]\n\n| 中文表格 | 值 |\n| --- | --- |\n| 测试 | 42 |\n\n```go\nfmt.Println("中文")\n```\n\n$$\nE = mc^2\n$$\n\n![打印图](static/print-image.png)\n\n[^sample]: 脚注正文。\n');
  const upload = await page.request.post(`/api/notes/${encodeURIComponent(filename)}/assets`, { headers: { Origin: origin }, multipart: { sourceKind: 'file', file: { name: 'print-image.png', mimeType: 'image/png', buffer: await readFile(image) } } }); expect(upload.status()).toBe(200);
  let sockets = 0; page.on('websocket', () => sockets++);
  await open(page, filename); expect(sockets).toBe(1);
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view').getByRole('status')).toHaveText('可打印');
  await expect(page.locator('.print-body')).toContainText('中文表格');
  await expect(page.locator('.print-body img[src]')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.print-body .milkdown-image-block')).toHaveCSS('break-inside', 'avoid');
  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('.print-body').getByRole('textbox').first()).toHaveAttribute('contenteditable', 'false');
  expect(sockets).toBe(1);
  const context = await browser.newContext({ locale: 'zh-CN' }); const other = await context.newPage();
  try {
    await other.goto(origin + '/note/' + encodeURIComponent(filename)); await other.getByLabel('服务密码').fill('p1-test-password'); await other.getByRole('button', { name: '进入工作区' }).click();
    await expect(other.getByRole('status')).toHaveText('已保存');
    await other.locator('#note-editor p').filter({ hasText: '快照正文。' }).first().click(); await other.keyboard.insertText('后续修改');
    await expect(other.getByRole('status')).toHaveText('已保存');
    await expect(page.locator('.print-body')).not.toContainText('后续修改');
    await page.getByRole('button', { name: '关闭打印预览' }).click();
    await expect(page.locator('#note-editor')).toContainText('后续修改');
  } finally { await context.close(); }
});

test('print image failure remains visible and does not enable printing', async ({ page }) => {
  const filename = '打印缺图.md';
  await create(page, filename, '# 打印缺图\n\n```md\n![示例](static/not-present.png)\n```\n\n> ![缺图][missing]\n\n[missing]: static/not-present.png\n');
  await open(page, filename);
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view').getByRole('status')).toHaveText('准备失败：图片无法加载（Markdown 第 7 行）：static/not-present.png');
  await expect(page.locator('.print-view').getByRole('button', { name: '打印', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭打印预览' }).click();
  await expect(page.locator('#note-editor')).toBeVisible();
});

test('print reports the Markdown line for an image with an empty address', async ({ page }) => {
  const filename = '打印图片空地址.md';
  await create(page, filename, '# 空地址\n\n行内图片 ![待补地址]()\n');
  await open(page, filename);
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  const print = page.getByRole('region', { name: '打印预览' });
  await expect(print.getByRole('status')).toHaveText('准备失败：图片无法加载（Markdown 第 3 行）：空地址');
  await expect(print.getByRole('button', { name: '打印', exact: true })).toBeDisabled();
});

test('actual font network failure disables printing and closing restores editing', async ({ page }) => {
  let failures = 0;
  await page.route(/\.(?:woff2?|ttf|otf)(?:\?.*)?$/, async route => {
    failures++;
    await route.abort('failed');
  });
  await create(page, '打印字体失败.md', '# 字体失败\n\n仍可编辑的中文正文。\n');
  await open(page, '打印字体失败.md');
  const font = (await readdir('../internal/webassets/dist/assets')).find(name => name.startsWith('KaTeX_Main-Regular-') && name.endsWith('.woff2'));
  expect(font).toBeTruthy();
  // Use a real embedded font on print text so the browser must load it.
  await page.addStyleTag({ content: `@font-face { font-family: "PrintFailureProbe"; src: url("/assets/${font}") format("woff2"); } .print-body p { font-family: "PrintFailureProbe" !important; }` });
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view').getByRole('status')).toContainText('字体加载失败');
  expect(failures).toBeGreaterThan(0);
  expect(await page.evaluate(() => [...document.fonts].some(face => face.status === 'error'))).toBe(true);
  await expect(page.locator('.print-view').getByRole('button', { name: '打印', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭打印预览' }).click();
  await page.locator('#note-editor p').first().click();
  await page.keyboard.insertText('失败后继续编辑');
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor')).toContainText('失败后继续编辑');
});

test('print code wraps its final marker within the visible width with readable text', async ({ page }) => {
  await create(page, '打印长代码.md', '# 长代码\n\n```text\nCODE_START ' + 'long-code-'.repeat(80) + ' CODE_END\n```\n');
  await open(page, '打印长代码.md');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view [role="status"]')).toHaveText('可打印');
  const previewWidth = await page.locator('.print-body').evaluate(element => element.getBoundingClientRect().width);
  await page.emulateMedia({ media: 'print' });
  const printedWidth = await page.locator('.print-body').evaluate(element => element.getBoundingClientRect().width);
  expect(previewWidth).toBeCloseTo((210 - 2 * 25.4) * 96 / 25.4, 0);
  expect(printedWidth).toBeCloseTo(previewWidth, 1);
  const code = page.locator('.print-body [role="textbox"]').last();
  await expect(code).toContainText('CODE_END');
  const position = await code.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf('CODE_END') ?? -1;
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 'CODE_END'.length);
      const marker = range.getBoundingClientRect(); const content = element.getBoundingClientRect();
      return { markerLeft: marker.left, markerRight: marker.right, contentLeft: content.left, contentRight: content.right, color: getComputedStyle(element).color };
    }
    throw new Error('Code end marker was not rendered');
  });
  expect(position.markerLeft).toBeGreaterThanOrEqual(position.contentLeft - 1);
  expect(position.markerRight).toBeLessThanOrEqual(position.contentRight + 1);
  const channels = position.color.match(/\d+/g)?.slice(0, 3).map(Number);
  expect(channels).toHaveLength(3);
  expect(Math.max(...channels!)).toBeLessThanOrEqual(80);
});

test('paper choices show A4 margins and continuous height while preserving the readonly snapshot', async ({ page }) => {
  await create(page, '纸张布局.md', '# A4 纸张\n\n' + Array.from({ length: 50 }, (_, i) => `段落 ${i} ` + '中文正文与纸张边距。'.repeat(5)).join('\n\n') + '\n\nLAYOUT_DOCUMENT_END\n');
  await open(page, '纸张布局.md');
  let sockets = 0; page.on('websocket', () => sockets++);
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  const preview = page.getByRole('region', { name: '打印预览' });
  const select = preview.getByLabel('纸张布局');
  await expect(select).toHaveValue('normal');
  await expect(preview.locator('.print-toolbar button')).toHaveText(['打印', '关闭']);
  for (const [mode, margin] of [['normal', 25.4], ['narrow', 12.7], ['continuous', 12.7]] as const) {
    await select.selectOption(mode);
    await expect(page.locator('.print-view').getByRole('status')).toHaveText('可打印');
    const layout = await page.locator('.print-sheet').evaluate(element => ({width:element.getBoundingClientRect().width,padding:parseFloat(getComputedStyle(element).paddingLeft)}));
    expect(layout.width).toBeCloseTo(210 * 96 / 25.4, 0);
    expect(layout.padding).toBeCloseTo(margin * 96 / 25.4, 0);
    const width = await page.locator('.print-body').evaluate(element => element.getBoundingClientRect().width);
    expect(width).toBeCloseTo((210 - 2 * margin) * 96 / 25.4, 0);
    await expect(page.locator('.print-body')).toContainText('LAYOUT_DOCUMENT_END');
    const rule = await page.locator('style[data-print-page]').textContent();
    expect(rule).toContain(`margin:${margin}mm`);
    if (mode === 'continuous') expect(Number(rule!.match(/size:210mm (\d+)mm/)![1])).toBeGreaterThan(297);
    else expect(rule).toContain('size:210mm 297mm');
    await page.emulateMedia({ media: 'print' });
    expect(await page.locator('.print-body').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(width, 1);
    expect(await page.locator('.print-sheet').evaluate(element => getComputedStyle(element).paddingLeft)).toBe('0px');
    await page.emulateMedia({ media: 'screen' });
  }
  await page.evaluate(() => { window.print = () => { document.body.dataset.nativePrintCalled = 'true'; }; });
  await preview.getByRole('button', { name: '打印', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-native-print-called', 'true');
  expect(sockets).toBe(0);
  await page.getByRole('button', { name: '关闭打印预览' }).click();
  await expect(page.locator('style[data-print-page]')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('已保存');
});

test('oversized continuous page is explicit and switching back to A4 restores printing', async ({ page }) => {
  await create(page, '长页上限.md', '# 长页上限\n\n' + Array.from({ length: 1000 }, (_, i) => `第 ${i} 段中文正文。`).join('\n\n'));
  await open(page, '长页上限.md');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view').getByRole('status')).toHaveText('可打印');
  await page.getByLabel('纸张布局').selectOption('continuous');
  await expect(page.locator('.print-view').getByRole('status')).toContainText('超过 5000 mm');
  await expect(page.locator('.print-view').getByRole('button', { name: '打印', exact: true })).toBeDisabled();
  await expect(page.locator('.print-body')).toContainText('第 999 段中文正文。');
  await page.getByLabel('纸张布局').selectOption('normal');
  await expect(page.locator('.print-view').getByRole('status')).toHaveText('可打印');
  await expect(page.locator('.print-view').getByRole('button', { name: '打印', exact: true })).toBeEnabled();
});

test('desktop sidebar divider expands the file list and remembers the size', async ({ page }) => {
  const filename = '侧栏高度.md';
  const origin = await create(page, filename);
  for (let i = 0; i < 12; i++) {
    const response = await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename: `侧栏文件${i}.md`, markdown: '# Note' } });
    expect(response.status()).toBe(201);
  }
  await open(page, filename);
  const files = page.getByRole('navigation', { name: '笔记文件' });
  const outline = page.locator('.document-outline');
  const separator = page.getByRole('separator', { name: '调整文件列表高度' });
  const height = (locator: typeof files) => locator.evaluate(element => element.clientHeight);
  const before = await height(files);
  const outlineBefore = await height(outline);
  const box = await separator.boundingBox();
  if (!box) throw new Error('Missing sidebar divider');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 110, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => height(files)).toBeGreaterThan(before + 60);
  expect(await height(outline)).toBeLessThan(outlineBefore);
  expect(await height(outline)).toBeGreaterThanOrEqual(72);
  const resized = await height(files);
  await page.reload();
  await expect.poll(() => height(files)).toBe(resized);
  await separator.focus();
  await separator.press('ArrowUp');
  await expect.poll(() => height(files)).toBeLessThan(resized);
});

test('sidebar holds document actions and a live collapsible H1-H5 outline without changing the note', async ({ page, browser }) => {
  await page.setViewportSize({width:1280,height:900});
  const filename = '侧栏目录.md';
  const origin = await create(page, filename, '# 第一章\n\n## 第二级\n\n### 第三级\n\n#### 第四级\n\n' + '用于验证目录跳转的正文段落。\n\n'.repeat(45) + '##### 第五级\n\n###### 六级不进入目录\n\n# 第二章\n\n### 跨级标题\n');
  await open(page, filename);
  const toc = page.getByRole('navigation', {name:'文章目录'});
  await expect(page.getByRole('region',{name:'工作区与文件'})).toBeVisible();
  const identity = page.locator('.identity-controls');
  await expect(identity.getByLabel('在线成员')).toHaveText('1 人在线');
  const controls = await identity.locator(':scope > *').evaluateAll(nodes => nodes.map(node => {
    const bounds = node.getBoundingClientRect();
    return bounds.top + bounds.height / 2;
  }));
  expect(new Set(controls).size).toBe(1);
  await expect(page.getByRole('button', { name: '修改用户名' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建文件', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation',{name:'笔记文件'}).getByRole('link',{name:filename,exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('aside').getByText(filename, { exact: true })).toHaveCount(1);
  await expect(page).toHaveTitle(filename);
  const masthead = page.locator('.sidebar-masthead');
  await expect(masthead.getByRole('status')).toHaveText('已保存');
  expect((await masthead.boundingBox())!.height).toBeLessThanOrEqual(32);
  await expect(page.locator('.workspace-files summary')).toHaveCount(0);
  for (const title of ['第一章','第二级','第三级','第四级','第五级','第二章','跨级标题']) await expect(toc.getByRole('button',{name:title,exact:true})).toBeVisible();
  await expect(toc.getByRole('button',{name:'六级不进入目录',exact:true})).toHaveCount(0);
  for (const label of ['预览','上传图片 / 附件','下载 Markdown','下载 Word','打印 / 保存为 PDF']) await expect(page.locator('aside').getByRole('button',{name:label,exact:true})).toBeVisible();
  const exportBoxes = await Promise.all(['下载 Markdown','下载 Word','打印 / 保存为 PDF'].map(name=>page.locator('aside').getByRole('button',{name,exact:true}).boundingBox()));
  expect(exportBoxes.every(box=>box && box.height===32 && box.y===exportBoxes[0]!.y)).toBe(true);
  await expect(page.locator('main.workspace>header')).toHaveCount(0);
  const editorTop = await page.locator('#note-editor').evaluate(e=>e.getBoundingClientRect().top);
  expect(editorTop).toBeLessThan(30);
  const api = '/api/notes/' + encodeURIComponent(filename);
  const before = await (await page.request.get(api)).json();
  await toc.getByRole('button',{name:'折叠 第二级 的子标题',exact:true}).click();
  await expect(toc.getByRole('button',{name:'第三级',exact:true})).toBeHidden();
  await expect(toc.getByRole('button',{name:'第五级',exact:true})).toBeHidden();
  await expect(toc.getByRole('button',{name:'第二章',exact:true})).toBeVisible();
  const context = await browser.newContext({ locale: 'zh-CN' }); const other = await context.newPage();
  try {
    await other.goto(origin+'/note/'+encodeURIComponent(filename));
    await other.getByLabel('服务密码').fill('p1-test-password'); await other.getByRole('button',{name:'进入工作区'}).click();
    await expect(other.getByRole('status')).toHaveText('已保存');
    await other.locator('#note-editor h5').click(); await other.keyboard.press('End'); await other.keyboard.insertText('远端更新');
    await expect(other.getByRole('status')).toHaveText('已保存');
    await expect(toc.getByRole('button',{name:'展开 第二级 的子标题',exact:true})).toHaveAttribute('aria-expanded','false');
    await toc.getByRole('button',{name:'展开 第二级 的子标题',exact:true}).click();
    await expect(toc.getByRole('button',{name:'第五级远端更新',exact:true})).toBeVisible();
    await toc.getByRole('button',{name:'第五级远端更新',exact:true}).click();
    await expect.poll(()=>page.locator('main.workspace').evaluate(e=>e.scrollTop)).toBeGreaterThan(200);
    await expect.poll(()=>page.locator('#note-editor h5').evaluate(e=>e.getBoundingClientRect().top)).toBeLessThan(850);
    expect(await page.locator('aside').evaluate(e=>e.getBoundingClientRect().top)).toBe(0);
    const after = await (await page.request.get(api)).json(); expect(after.revision).toBeGreaterThan(before.revision);
    await toc.getByRole('button',{name:'折叠 第一章 的子标题',exact:true}).click();
    await toc.getByRole('button',{name:'展开 第一章 的子标题',exact:true}).click();
    expect((await (await page.request.get(api)).json()).revision).toBe(after.revision);
    await page.setViewportSize({width:390,height:844});
    await expect(toc.getByRole('button',{name:'第一章',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await page.locator('#note-editor h1').first().evaluate(e=>e.getBoundingClientRect().width)).toBeGreaterThan(250);
  } finally { await context.close(); }
});

test('outline jumps to exact Markdown headings in source mode', async ({ page }) => {
  const filename = '源码目录跳转.md';
  const filler = '用于验证源码滚动定位。\n\n'.repeat(75);
  await create(page, filename, '# 文档\n\n## 同名\n\n第一处定位标记\n\n' + filler +
    '```markdown\n## 围栏里的假标题\n```\n\n###### 不进目录的标题\n\n## 同名\n\n第二处定位标记\n\n' +
    filler + '> 引用里的标题\n> ------------\n>\n> 引用定位标记\n');
  await open(page, filename);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const toc = page.getByRole('navigation', { name: '文章目录' });
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  const duplicates = toc.getByRole('button', { name: '同名', exact: true });
  await expect(duplicates).toHaveCount(2);
  await expect(toc.getByRole('button', { name: '围栏里的假标题' })).toHaveCount(0);
  await duplicates.nth(1).click();
  await expect(source.getByText('第二处定位标记', { exact: true })).toBeInViewport();
  await duplicates.nth(0).click();
  await expect(source.getByText('第一处定位标记', { exact: true })).toBeInViewport();
  await toc.getByRole('button', { name: '引用里的标题', exact: true }).click();
  await expect(source.getByText('> 引用定位标记', { exact: true })).toBeInViewport();
});

test('offscreen print formulas remain fully rendered after the lazy teardown interval', async ({ page }) => {
  await create(page, '离屏公式修复.md', '# 公式\n\n' + '足够长的段落用于离屏验证。\n\n'.repeat(160) + '$$\nE=mc^2\n$$\n\n```text\nCODE_END\n```\n\nFORMULA_DOCUMENT_END\n');
  await open(page, '离屏公式修复.md');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view [role="status"]')).toHaveText('可打印');
  const formula = page.locator('.print-body [data-print-math] math[display="block"]');
  await expect(formula).toHaveCount(1);
  expect(await formula.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(720);
  await page.waitForTimeout(5500);
  await expect(formula).toHaveCount(1);
  await expect(page.locator('.print-body .cm-editor')).toHaveCount(0);
  await page.emulateMedia({ media: 'print' });
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('.print-body [data-print-code] pre>code').evaluate(element => getComputedStyle(element).display)).toBe('block');
  await expect(page.locator('.print-body')).toContainText('FORMULA_DOCUMENT_END');
});

test('invalid formula disables printing and closing allows correction and another preview', async ({ page }) => {
  await create(page, '公式错误恢复.md', '# 公式错误\n\n$$\n\\frac{\n$$\n');
  await open(page, '公式错误恢复.md');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view [role="status"]')).toContainText('公式渲染失败');
  await expect(page.getByRole('button', { name: '打印', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭打印预览' }).click();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const source = page.locator('.markdown-source .cm-content');
  await source.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# 修正\n\n$$\nE=mc^2\n$$\n');
  await expect(page.getByRole('status')).toHaveText('已保存');
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await expect(page.locator('.print-view [role="status"]')).toHaveText('可打印');
  await expect(page.locator('.print-body math[display="block"]')).toHaveCount(1);
});


test('Word export embeds Mermaid PNGs and keeps the original Markdown unchanged', async ({ page }) => {
  const markdown = '# Word 图表\n\n```mermaid\nflowchart LR\nA[中文开始] --> B[完成]\n```\n\n```mermaid\nsequenceDiagram\nAlice->>Bob: 你好\n```\n\n```text\nCODE_STAYS_CODE\n```\n';
  const filename = 'Word Mermaid 图片.md', origin = await create(page, filename, markdown); await open(page, filename);
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 Word' }).click();
  const download = await downloading; expect(download.suggestedFilename()).toBe('Word Mermaid 图片.docx');
  await mkdir('../tests/artifacts/downloads', { recursive: true });
  const path = '../tests/artifacts/downloads/word-mermaid.docx'; await download.saveAs(path);
  const entries = unzip(await readFile(path));
  const images = [...entries].filter(([name]) => name.startsWith('word/media/'));
  expect(images).toHaveLength(2);
  for (const [, data] of images) {
    expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(data.readUInt32BE(16)).toBeGreaterThan(100);
  }
  const xml = entries.get('word/document.xml')!.toString('utf8');
  expect(xml.match(/<w:drawing>/g)).toHaveLength(2); expect(xml).toContain('CODE_STAYS_CODE'); expect(xml).not.toContain('flowchart LR'); expect(xml).not.toContain('Alice-&gt;');
  const api = '/api/notes/' + encodeURIComponent(filename), meta = await (await page.request.get(api)).json();
  expect(await (await page.request.post(api + '/export', { headers: { Origin: origin }, data: { format: 'markdown', revision: meta.revision } })).text()).toBe(markdown);
});

test('Word Mermaid syntax errors stay recoverable and a corrected diagram exports', async ({ page }) => {
  await create(page, 'Word图表错误恢复.md', '```mermaid\nflowchart LR\nA --> [\n```\n'); await open(page, 'Word图表错误恢复.md');
  await page.getByRole('button', { name: '下载 Word' }).click();
  await expect(page.locator('#operation-error')).toContainText('Mermaid 语法或渲染错误');
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.getByRole('button', { name: '下载 Word' })).toBeEnabled();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' }); await source.click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('```mermaid\nflowchart LR\nA[已修正] --> B[完成]\n```\n');
  await expect(page.getByRole('status')).toHaveText('已保存');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 Word' }).click();
  expect((await downloading).suggestedFilename()).toBe('Word图表错误恢复.docx');
});

test('named pasted images keep names and conflicts offer all three naming choices', async ({ page }) => {
  const filename = '命名冲突交互.md'; await create(page, filename); await open(page, filename);
  const bytes = [...await readFile(image)];
  async function paste() {
    await page.locator('#note-editor').getByRole('textbox').first().evaluate((node, bytes) => {
      const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], '保留原始名.png', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, bytes);
  }
  await paste(); await expect(page.locator('.upload-status')).toHaveText('已插入 保留原始名.png'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await paste(); await expect(page.getByRole('dialog')).toContainText('文件名已存在');
  await page.getByRole('button', { name: '自动重命名', exact: true }).click(); await expect(page.locator('.upload-status')).toHaveText('已插入 保留原始名 (1).png');
  await paste(); await page.getByRole('button', { name: '保存为时间戳', exact: true }).click(); await expect(page.locator('.upload-status')).toHaveText(/已插入 \d{17}\.png/);
  await paste(); await page.getByRole('textbox', { name: '新文件名' }).fill('手动命名结果.png'); await page.getByRole('button', { name: '使用手动文件名' }).click(); await expect(page.locator('.upload-status')).toHaveText('已插入 手动命名结果.png');
  expect((await page.request.get('/note/static/' + encodeURIComponent('保留原始名.png'))).status()).toBe(200);
  await expect(page.getByRole('alert')).toHaveCount(0);
});


test('nested quotation and list blank paragraphs are projected without touching source or code', async ({ page }) => {
 const markdown = '# 嵌套空行\n\n> 引用首段\n>\n>\n>\n> 引用末段\n\n- 列表首段\n\n\n\n  列表末段\n\n```text\nCODE_START\n\n\nCODE_END\n```\n';
 const filename='嵌套空行.md', origin=await create(page,filename,markdown);await open(page,filename);
 await expect(page.locator('#note-editor blockquote p').filter({hasText:/^$/})).toHaveCount(1);
 await expect(page.locator('#note-editor li p').filter({hasText:/^$/})).toHaveCount(1);
 const meta=await (await page.request.get('/api/notes/'+encodeURIComponent(filename))).json();
 expect(await (await page.request.post('/api/notes/'+encodeURIComponent(filename)+'/export',{headers:{Origin:origin},data:{format:'markdown',revision:meta.revision}})).text()).toBe(markdown);
});

test('leading, trailing and whitespace-only Markdown survives visual projection', async ({ page }) => {
  const origin = await create(page, '空行边界入口.md');
  for (const [index, markdown, count] of [[0, '\n\n# 正文\n\n段落\n\n\n', 2], [1, '\n\n\n\n', 2]] as const) {
    const filename = `边界空行${index}.md`;
    expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown } })).status()).toBe(201);
    await open(page, filename);
    await expect(page.locator('#note-editor p').filter({ hasText: /^$/ })).toHaveCount(count);
    await page.getByRole('button', { name: '源码', exact: true }).click();
    await page.getByRole('button', { name: '所见即所得', exact: true }).click();
    const api = '/api/notes/' + encodeURIComponent(filename), meta = await (await page.request.get(api)).json();
    expect(await (await page.request.post(api + '/export', { headers: { Origin: origin }, data: { format: 'markdown', revision: meta.revision } })).text()).toBe(markdown);
  }
});

test('pasted attachments retain their filename and cancelled collision keeps original bytes', async ({ page }) => {
  await create(page, '附件粘贴命名.md'); await open(page, '附件粘贴命名.md');
  async function paste(content: string) {
    await page.locator('#note-editor').getByRole('textbox').first().evaluate((node, content) => {
      const data = new DataTransfer(); data.items.add(new File([content], '原始 附件.txt', { type: 'text/plain' }));
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, content);
  }
  await paste('original attachment bytes');
  await expect(page.locator('.upload-status')).toHaveText('已插入 原始 附件.txt');
  await paste('must never overwrite');
  await expect(page.getByRole('dialog')).toContainText('文件名已存在');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await (await page.request.get('/note/static/' + encodeURIComponent('原始 附件.txt'))).text()).toBe('original attachment bytes');
  await expect(page.locator('#note-editor a').filter({ hasText: '原始 附件.txt' })).toHaveCount(1);
});

test('an external note conflict is reported without showing a filename collision dialog', async ({ page }) => {
  await create(page, '上传文件冲突分类.md'); await open(page, '上传文件冲突分类.md');
  await page.route('**/assets', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'file_changed', message: '文件已在外部修改' }) }));
  await page.locator('#upload-files').setInputFiles([{ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment') }]);
  await expect(page.getByRole('alert')).toContainText('文件已在外部修改');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('split view edits shared source and shows a live readonly preview while the sidebar is collapsed', async ({ page }) => {
  const filename = '分屏协作.md';
  const paragraphs = '较长的预览内容。\n\n'.repeat(40);
  const markdown = '# 分屏文档\n\n原始正文。\n\n' + paragraphs + '## 中间标题\n\n' + paragraphs + '## 末尾标题\n';
  const origin = await create(page, filename, markdown); await open(page, filename);
  let sockets = 0; page.on('websocket', () => sockets++);
  const peer = await page.context().newPage();
  try {
    await peer.goto(origin + '/note/' + encodeURIComponent(filename));
    await expect(peer.getByRole('status')).toHaveText('已保存');
    const revision = await page.getByRole('status').getAttribute('data-saved-revision');
    const split = page.getByRole('button', { name: '分屏预览' });
    await split.click(); await expect(split).toHaveAttribute('aria-pressed', 'true');
    const left = page.getByRole('region', { name: '源码编辑区' });
    const right = page.getByRole('region', { name: '实时预览' });
    const source = left.getByRole('textbox', { name: 'Markdown 源码' });
    await expect(source).toHaveAttribute('contenteditable', 'true');
    await expect(right.getByRole('textbox').first()).toHaveAttribute('contenteditable', 'false');
    const before = (await left.boundingBox())!;
    const preview = (await right.boundingBox())!;
    expect(before.x + before.width).toBeCloseTo(preview.x, 0);
    expect(before.y).toBe(preview.y);
    expect(await page.getByRole('status').getAttribute('data-saved-revision')).toBe(revision);
    await right.evaluate(pane => {
      const heading = pane.querySelector('h2')!;
      pane.scrollTop += heading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    });
    const sourceHeading = left.getByText('## 中间标题', { exact: true });
    await expect.poll(async () => Math.abs(((await sourceHeading.boundingBox({ timeout: 500 }))?.y ?? 0) - before.y)).toBeLessThan(30);
    const middle = await right.evaluate(pane => pane.scrollTop);
    await left.evaluate(pane => { pane.scrollTop += 180; });
    await expect.poll(() => right.evaluate(pane => pane.scrollTop)).toBeGreaterThan(middle + 40);
    await page.getByRole('navigation', { name: '文章目录' }).getByRole('button', { name: '末尾标题' }).click();
    await expect.poll(() => right.evaluate(node => node.scrollTop)).toBeGreaterThan(500);
    await page.getByRole('button', { name: '折叠侧栏' }).click();
    const expand = page.getByRole('button', { name: '展开侧栏' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('navigation', { name: '文章目录' })).toBeHidden();
    expect((await left.boundingBox())!.width).toBeGreaterThan(before.width + 80);
    await source.click(); await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n**本地加粗**\n');
    await expect(right.locator('strong')).toHaveText('本地加粗');
    await expect(peer.locator('#note-editor strong')).toHaveText('本地加粗');
    await peer.locator('#note-editor p').first().click();
    await peer.keyboard.press('End'); await peer.keyboard.insertText('远端补充');
    await source.press('ControlOrMeta+Home');
    await expect(source).toContainText('原始正文。远端补充');
    await expect(right).toContainText('原始正文。远端补充');
    await expand.click();
    await expect(page.getByRole('button', { name: '折叠侧栏' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('navigation', { name: '文章目录' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect(Number(await page.getByRole('status').getAttribute('data-saved-revision'))).toBeGreaterThan(Number(revision));
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await right.boundingBox())!.y).toBeGreaterThan((await left.boundingBox())!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await split.click();
    await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeVisible();
    await expect(page.locator('.markdown-visual')).toBeHidden();
    expect(sockets).toBe(0);
  } finally { await peer.close(); }
});

test('English download labels stay inside their buttons and the header icon signs out', async ({ page }) => {
  const filename = '英文按钮布局.md'; await create(page, filename); await open(page, filename);
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await expect(page.getByRole('status')).toHaveText('Saved');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const download = page.getByRole('button', { name: 'Download Markdown', exact: true });
    await expect(download).toHaveText('Download MD');
    const buttons = page.locator('.export-controls button:visible');
    await expect(buttons).toHaveCount(3);
    expect(await buttons.evaluateAll(elements => elements.every(button => {
      const box = button.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(button);
      return [...range.getClientRects()].every(text => text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom);
    }))).toBe(true);
  }
  const signOut = page.locator('.sidebar-masthead').getByRole('button', { name: 'Sign out', exact: true });
  await expect(signOut).toHaveAttribute('title', 'Sign out');
  await expect(signOut.locator('svg')).toBeVisible();
  await expect(page.locator('aside footer')).toHaveCount(0);
  await signOut.click();
  await expect(page.getByLabel('Workspace password')).toBeVisible();
  await expect(page).toHaveTitle('LanNoto');
});

test('file toolbar and drag-and-drop manage nested notes while preserving history', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto('/note/');
  await page.getByLabel('服务密码').fill('p1-test-password');
  await page.getByRole('button', { name: '进入工作区' }).click();
  const actions = page.getByRole('group', { name: '文件操作' });
  const tree = page.getByRole('navigation', { name: '笔记文件' });
  const dialog = page.getByRole('dialog');
  const origin = new URL(page.url()).origin;
  const folder = async (name: string) => {
    await actions.getByRole('button', { name: '新建文件夹' }).click();
    await dialog.getByLabel('文件夹名称').fill(name);
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(tree.getByRole('button', { name, exact: true })).toBeVisible();
  };
  await expect(actions.locator('svg')).toHaveCount(5);
  await expect(actions.getByRole('button', { name: '打包导出工作区' }).locator('svg')).toBeVisible();
  await expect(actions.getByRole('button', { name: '刷新文件列表' }).locator('svg')).toBeVisible();
  const buttonRows = await actions.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
  expect(new Set(buttonRows).size).toBe(1);
  await folder('项目甲');
  await folder('子目录');
  await tree.getByRole('button', { name: '折叠文件夹 项目甲' }).click();
  await expect(tree.getByRole('button', { name: '子目录', exact: true })).toBeHidden();
  await tree.getByRole('button', { name: '展开文件夹 项目甲' }).click();
  await tree.getByRole('button', { name: '子目录', exact: true }).click();
  await actions.getByRole('button', { name: '新建文件', exact: true }).click();
  await expect(dialog.getByLabel('所在文件夹')).toHaveValue('项目甲/子目录');
  await dialog.getByLabel('笔记文件名').fill('原名');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page).toHaveTitle('原名.md');
  await expect(tree.getByRole('link', { name: '原名.md' })).toHaveAttribute('aria-current', 'page');
  const body = page.locator('#note-editor p').first();
  await body.click(); await page.keyboard.insertText('保留这段正文');
  await page.keyboard.press('ControlOrMeta+s');
  const oldAPI = '/api/notes/' + encodeURIComponent('项目甲/子目录/原名.md');
  await expect.poll(async () => {
    const result = await (await page.request.get(oldAPI + '/history')).json();
    return result.items.some((entry: { reason: string }) => entry.reason === 'manual');
  }).toBe(true);
  await actions.getByRole('button', { name: '重命名' }).click();
  await dialog.getByLabel('笔记文件名').fill('新名.md');
  await dialog.getByRole('button', { name: '重命名' }).click();
  await expect(page).toHaveTitle('新名.md');
  await expect(page.getByRole('status')).toHaveText('已保存');
  expect((await page.request.get(oldAPI)).status()).toBe(404);
  const peerContext = await browser.newContext({ locale: 'zh-CN' });
  try {
    const peer = await peerContext.newPage();
    await peer.goto(page.url());
    await peer.getByLabel('服务密码').fill('p1-test-password');
    await peer.getByRole('button', { name: '进入工作区' }).click();
    await expect(peer.getByRole('status')).toHaveText('已保存');
    await tree.getByRole('button', { name: '项目甲', exact: true }).click();
    await actions.getByRole('button', { name: '重命名' }).click();
    await dialog.getByLabel('文件夹名称').fill('项目乙');
    await dialog.getByRole('button', { name: '重命名' }).click();
    await expect(dialog.getByRole('alert')).toContainText('其他页面正在打开此笔记');
  } finally { await peerContext.close(); }
  await expect.poll(async () => (await page.getByLabel('在线成员').textContent())?.includes('1 人在线')).toBe(true);
  await dialog.getByRole('button', { name: '重命名' }).click();
  await expect(page).toHaveURL(origin + '/note/' + encodeURIComponent('项目乙/子目录/新名.md'));
  await expect(page).toHaveTitle('新名.md');
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor')).toContainText('保留这段正文');
  const newAPI = '/api/notes/' + encodeURIComponent('项目乙/子目录/新名.md');
  const history = await (await page.request.get(newAPI + '/history')).json();
  expect(history.items.some((entry: { reason: string }) => entry.reason === 'manual')).toBe(true);

  expect((await page.request.post('/api/workspace/folders', { headers: { Origin: origin }, data: { path: '收件箱' } })).status()).toBe(201);
  await actions.getByRole('button', { name: '刷新文件列表' }).click();
  await tree.getByRole('link', { name: '新名.md' }).dragTo(tree.getByRole('button', { name: '收件箱', exact: true }));
  await expect(page).toHaveURL(origin + '/note/' + encodeURIComponent('收件箱/新名.md'));
  await expect(page.getByRole('status')).toHaveText('已保存');
  await tree.getByRole('button', { name: '收件箱', exact: true }).dragTo(tree.getByRole('button', { name: '项目乙', exact: true }));
  await expect(page).toHaveURL(origin + '/note/' + encodeURIComponent('项目乙/收件箱/新名.md'));
  await expect(page.getByRole('status')).toHaveText('已保存');
  await tree.getByRole('link', { name: '新名.md' }).dragTo(page.locator('.sidebar-section-heading'));
  await expect(page).toHaveURL(origin + '/note/' + encodeURIComponent('新名.md'));
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor')).toContainText('保留这段正文');
  const movedHistory = await (await page.request.get('/api/notes/' + encodeURIComponent('新名.md') + '/history')).json();
  expect(movedHistory.items).toEqual(history.items.map((entry: Record<string, unknown>) => ({ ...entry, filename: '新名.md' })));
});
