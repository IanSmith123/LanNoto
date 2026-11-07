import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { boot, workspace } from './process-fixture';

const converter = resolve('../tests/artifacts/pandoc-fixture' + (process.platform === 'win32' ? '.exe' : ''));
let pandoc: string;
test.beforeAll(() => {
  execFileSync('go', ['build', '-o', converter, './tests/fixtures/pandoc'], { cwd: '..', windowsHide: true });
  pandoc = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['pandoc'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
});
async function start(mode: string) {
  const cwd = await workspace(); const markers = join(cwd, 'markers'); await mkdir(markers);
  const service = await boot(cwd, 'process-test-password', undefined, { path: converter, env: { LANNOTO_TEST_PANDOC: pandoc, LANNOTO_TEST_CONVERTER: mode, LANNOTO_TEST_MARKERS: markers } });
  return { service, markers };
}
async function open(page: Page, url: string) {
  await page.goto(url + '/note/' + encodeURIComponent('恢复测试.md'));
  await page.getByLabel('服务密码').fill('process-test-password');
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
}
function alive(pid: string) { try { process.kill(Number(pid), 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }

test('actual converter failure preserves exit code and stderr and stays visible in UI', async ({ page }) => {
  const { service } = await start('failure');
  try {
    await open(page, service.url);
    const response = page.waitForResponse(response => response.url().endsWith('/export'));
    await page.getByRole('button', { name: '下载 Word' }).click();
    expect((await response).status()).toBe(422);
    await expect(page.getByRole('alert')).toContainText('Word 转换失败');
    expect(service.logs()).toContain('exit_code=17');
    expect(service.logs()).toContain('intentional conversion failure');
    await expect(page.getByRole('status')).toHaveText('已保存');
  } finally { await service.stop(); }
});

test('two running converter processes reject a third and UI cancellation kills both', async ({ page, browser }) => {
  const { service, markers } = await start('slow');
  const contexts = await Promise.all([browser.newContext({ locale: 'zh-CN' }), browser.newContext({ locale: 'zh-CN' })]);
  try {
    const peers = [page, ...await Promise.all(contexts.map(context => context.newPage()))];
    await Promise.all(peers.map(peer => open(peer, service.url)));
    await peers[0].getByRole('button', { name: '下载 Word' }).click();
    await peers[1].getByRole('button', { name: '下载 Word' }).click();
    await expect.poll(async () => (await readdir(markers)).length).toBe(2);
    const response = peers[2].waitForResponse(response => response.url().endsWith('/export'));
    await peers[2].getByRole('button', { name: '下载 Word' }).click();
    expect((await response).status()).toBe(503);
    await expect(peers[2].getByRole('alert')).toContainText('已有两个 Word 转换任务');
    for (const peer of peers.slice(0, 2)) {
      await peer.getByRole('button', { name: '取消导出' }).click();
      await expect(peer.locator('.export-status')).toHaveText('已取消导出');
      await expect(peer.getByRole('status')).toHaveText('已保存');
    }
    for (const pid of await readdir(markers)) await expect.poll(() => alive(pid)).toBe(false);
    expect(service.child.exitCode).toBeNull();
  } finally { await service.stop(); await Promise.all(contexts.map(context => context.close())); }
});

test('real 60 second converter deadline returns 504 and leaves editing available', async ({ page }) => {
  test.setTimeout(90000);
  const { service, markers } = await start('slow');
  try {
    await open(page, service.url);
    const response = page.waitForResponse(response => response.url().endsWith('/export'), { timeout: 75000 });
    const start = performance.now(); await page.getByRole('button', { name: '下载 Word' }).click();
    expect((await response).status()).toBe(504);
    expect(performance.now() - start).toBeGreaterThanOrEqual(59000);
    await expect(page.getByRole('alert')).toContainText('Word 转换超过 60 秒');
    for (const pid of await readdir(markers)) await expect.poll(() => alive(pid)).toBe(false);
    await expect(page.getByRole('status')).toHaveText('已保存');
  } finally { await service.stop(); }
});
