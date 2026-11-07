import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzip } from './zip';

async function login(page: Page): Promise<string> {
  await page.goto('/note/'); await page.getByLabel('服务密码').fill('p1-test-password'); await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible(); return new URL(page.url()).origin;
}
async function create(page: Page, name: string, markdown: string): Promise<string> {
  const origin = await login(page); expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename: name, markdown } })).status()).toBe(201);
  await page.goto('/note/' + encodeURIComponent(name)); await expect(page.getByRole('status')).toHaveText('已保存'); return origin;
}
async function source(page: Page, value: string): Promise<void> {
  if (await page.getByRole('button', { name: '源码', exact: true }).count()) await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 源码' }).click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(value); await expect(page.getByRole('status')).toHaveText('已保存');
}

test('single-note and workspace downloads contain notes and assets without hidden state', async ({ page }) => {
  const filename = '单篇资源导出.md', origin = await create(page, filename, '# 导出\n\n原文。\n');
  const image = await readFile('tests/fixtures/image.png');
  for (const [name, content] of [['图片 中文.png', image], ['关联附件.txt', Buffer.from('linked attachment')], ['未引用.txt', Buffer.from('unused attachment')]] satisfies [string, Buffer][]) {
    expect((await page.request.post(`/api/notes/${encodeURIComponent(filename)}/assets`, { headers: { Origin: origin }, multipart: { sourceKind: 'file', file: { name, mimeType: name.endsWith('.png') ? 'image/png' : 'text/plain', buffer: content } } })).ok()).toBe(true);
  }
  const markdown = '# 导出\n\n![图片](<static/图片%20中文.png>)\n\n[附件][data]\n\n[data]: static/关联附件.txt\n'; await source(page, markdown);
  await page.keyboard.press('Control+s'); await expect(page.getByRole('status')).toHaveText('已保存');
  let downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const single = await downloading; expect(single.suggestedFilename()).toBe('单篇资源导出.zip');
  const singlePath = test.info().outputPath('single.zip'); await single.saveAs(singlePath); const note = unzip(await readFile(singlePath));
  expect([...note.keys()].sort()).toEqual([filename, 'static/图片 中文.png', 'static/关联附件.txt'].sort()); expect(note.get('static/图片 中文.png')?.equals(image)).toBe(true);
  expect(note.get('static/关联附件.txt')?.toString()).toBe('linked attachment'); expect(note.get(filename)?.toString()).toContain('static/');
  downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '打包导出工作区' }).click();
  const whole = await downloading; expect(whole.suggestedFilename()).toBe('workspace.zip'); const wholePath = test.info().outputPath('workspace.zip'); await whole.saveAs(wholePath);
  const workspace = unzip(await readFile(wholePath)); expect(workspace.get('note/' + filename)?.toString()).toBe(markdown); expect(workspace.has('note/static/未引用.txt')).toBe(true);
  expect([...workspace.keys()].some(name => name.startsWith('.lannoto/'))).toBe(false);
  expect([...workspace.keys()].every(name => name.startsWith('note/'))).toBe(true);
});

test('Ctrl+S checkpoints, large block snapshots, comparison and restore synchronize to another editor', async ({ page }) => {
  const filename = '历史协作.md', origin = await create(page, filename, '# 历史\n\n原文😀\n');
  await page.getByRole('button', { name: '修改用户名' }).click(); await page.getByRole('textbox', { name: '用户名', exact: true }).fill('Tim'); await page.getByRole('textbox', { name: '用户名', exact: true }).press('Enter');
  const api = `/api/notes/${encodeURIComponent(filename)}`;
  const manual = '# 历史\n\n第一版😀\t手动保存\n'; await source(page, manual); await page.keyboard.press('Control+s'); await expect(page.getByRole('status')).toHaveText('已保存');
  const versions = async () => (await (await page.request.get(api + '/history')).json()).items;
  await expect.poll(async () => (await versions()).filter((item: { reason: string }) => item.reason === 'manual').length).toBe(1);
  const manualEntry = (await versions()).find((item: { reason: string }) => item.reason === 'manual'); expect(manualEntry.author).toBe('Tim');
  const large = '# 历史\n\n```text\n' + '大区块变化😀\n'.repeat(80) + '```\n'; await source(page, large);
  await expect.poll(async () => (await versions())[0].reason, { timeout: 10000 }).toBe('block');
  const peer = await page.context().newPage();
  try {
    await peer.goto(origin + '/note/' + encodeURIComponent(filename)); await expect(peer.getByRole('status')).toHaveText('已保存');
    await page.getByRole('button', { name: '历史记录', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '历史记录', exact: true });
    await dialog.locator(`button[data-history-id="${manualEntry.id}"]`).click();
    const diff = dialog.getByLabel('相对当前正文的变化');
    await expect(dialog.locator('pre')).toHaveCount(1);
    await expect(diff.locator('.diff-added')).toContainText('+ 第一版😀');
    await expect(diff.locator('.diff-removed')).toContainText('− 大区块变化😀');
    await dialog.getByRole('button', { name: '恢复此版本' }).click(); await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('status')).toHaveText('已保存'); await expect(peer.locator('#note-editor')).toContainText('第一版😀');
    const revision = Number(await page.getByRole('status').getAttribute('data-saved-revision'));
    const exported = await page.request.post(api + '/export', { headers: { Origin: origin }, data: { format: 'markdown', revision } }); expect(await exported.text()).toBe(manual);
    const after = await versions(); expect(after[0].reason).toBe('restore');
    expect((await (await page.request.get(api + '/history/' + after[1].id)).json()).markdown).toBe(large);
    expect((await page.request.post(api + '/history/' + manualEntry.id + '/restore', { headers: { Origin: origin }, data: { revision: revision - 1, author: 'Tim' } })).status()).toBe(409);
    await page.getByRole('button', { name: '历史记录', exact: true }).click();
    await expect(dialog.getByLabel('相对当前正文的变化')).toHaveText('此版本与当前正文相同');
    await expect(dialog.getByRole('button', { name: '恢复此版本' })).toBeDisabled();
    await page.getByRole('button', { name: '关闭历史记录' }).click();
  } finally { await peer.close(); }
});

test('a real server timer records small edits after sixty seconds without a browser save request', async ({ page }) => {
  test.setTimeout(80000);
  const filename = '定时历史.md'; await create(page, filename, '# 计时\n\n短文\n'); await source(page, '# 计时\n\n短文计时变更\n');
  const api = `/api/notes/${encodeURIComponent(filename)}/history`;
  await expect.poll(async () => (await (await page.request.get(api)).json()).items.some((item: { reason: string }) => item.reason === 'interval'), { timeout: 70000, intervals: [1000] }).toBe(true);
  const items = (await (await page.request.get(api)).json()).items; const entry = await (await page.request.get(api + '/' + items[0].id)).json(); expect(entry.markdown).toBe('# 计时\n\n短文计时变更\n');
});
