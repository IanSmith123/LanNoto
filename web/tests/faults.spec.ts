import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { boot, workspace } from './process-fixture';

const executable = resolve('../dist/lannoto-fault-test' + (process.platform === 'win32' ? '.exe' : ''));
test.beforeAll(() => { execFileSync('go', ['build', '-tags=lannoto_fault_test', '-o', executable, './cmd/lannoto'], { cwd: '..', windowsHide: true }); });
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
async function login(page: Page, url: string) {
  await page.goto(url + '/note/' + encodeURIComponent('恢复测试.md')); await page.getByLabel('服务密码').fill('process-test-password');
  await page.getByRole('button', { name: '进入工作区' }).click(); await expect(page.getByRole('status')).toHaveText('已保存');
}
async function setup(page: Page, tagged = true) {
  const cwd = await workspace(); const directory = join(cwd, '.lannoto/test-fault');
  await mkdir(directory, { recursive: true });
  const service = await boot(cwd, 'process-test-password', undefined, { executable: tagged ? executable : undefined, env: { LANNOTO_TEST_FAULT_DIR: directory } });
  await login(page, service.url);
  return { cwd, directory, service, markdown: join(cwd, 'note/恢复测试.md'), snapshot: join(cwd, '.lannoto/state/恢复测试.md.json') };
}
async function edit(page: Page, text: string) { await page.locator('#note-editor p').first().click(); await page.keyboard.press('Home'); await page.keyboard.insertText(text); }

for (const stage of ['before-write', 'before-sync']) {
  test(`${stage} error exits the real service without advancing authoritative snapshot or acknowledging save`, async ({ page }) => {
    const fixture = await setup(page); const { service, directory, snapshot, markdown } = fixture;
    try {
      const originalState = await readFile(snapshot); const originalMarkdown = await readFile(markdown);
      await writeFile(join(directory, 'control.json'), JSON.stringify({ stage, file: '恢复测试.md.json', action: 'fail' }));
      await edit(page, '不能确认😀');
      await expect.poll(() => service.child.exitCode).not.toBeNull(); expect(await service.exited).toBe(1);
      expect(service.logs()).toContain(`injected ${stage} failure`);
      expect((await readFile(snapshot)).equals(originalState)).toBe(true);
      expect((await readFile(markdown)).equals(originalMarkdown)).toBe(true);
      await expect(page.getByRole('status')).not.toHaveText('已保存');
    } finally { await service.stop(); }
  });
}

for (const stage of ['projection-snapshot', 'markdown']) {
  test(`kill after real ${stage} replacement recovers the interrupted projection on ordinary restart`, async ({ page }) => {
    const fixture = await setup(page); let service = fixture.service;
    try {
      const original = await readFile(fixture.markdown);
      const file = stage === 'markdown' ? '恢复测试.md' : '恢复测试.md.json';
      await writeFile(join(fixture.directory, 'control.json'), JSON.stringify({ stage: 'after-replace', file, action: 'pause', projection: stage === 'projection-snapshot' }));
      await edit(page, '中断后恢复😀');
      await expect.poll(async () => { try { return JSON.parse(await readFile(join(fixture.directory, 'ready.json'), 'utf8')).file; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }).toBe(file);
      expect(service.child.exitCode).toBeNull();
      const interrupted = JSON.parse(await readFile(fixture.snapshot, 'utf8'));
      expect(interrupted.markdown).toContain('中断后恢复😀');
      expect(interrupted.markdownRevision).toBe(interrupted.revision);
      expect(interrupted.diskHash).toBe(hash(original));
      const disk = await readFile(fixture.markdown);
      if (stage === 'markdown') expect(disk.toString()).toContain('中断后恢复😀'); else expect(disk.equals(original)).toBe(true);
      await expect(page.getByRole('status')).not.toHaveText('已保存');
      const port = service.port; await service.stop();
      service = await boot(fixture.cwd, 'process-test-password', port);
      await login(page, service.url); await expect(page.locator('#note-editor')).toContainText('中断后恢复😀');
      const recovered = await readFile(fixture.markdown, 'utf8');
      expect(recovered.split('中断后恢复😀').length - 1).toBe(1);
      const state = JSON.parse(await readFile(fixture.snapshot, 'utf8'));
      expect(state.diskHash).toBe(hash(recovered)); expect(state.markdown).toBe(recovered);
      expect(state.revision).toBe(interrupted.revision);
    } finally { await service.stop(); }
  });
}

test('ordinary release binary contains no fault controls and ignores test control files', async ({ page }) => {
  const binary = await readFile(resolve('../dist/lannoto' + (process.platform === 'win32' ? '.exe' : '')));
  expect(binary.includes(Buffer.from('LANNOTO_TEST_FAULT_DIR'))).toBe(false);
  const fixture = await setup(page, false);
  try {
    await writeFile(join(fixture.directory, 'control.json'), JSON.stringify({ stage: 'before-write', file: '恢复测试.md.json', action: 'fail' }));
    await edit(page, '普通构建继续保存😀');
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect(await readFile(fixture.markdown, 'utf8')).toContain('普通构建继续保存😀');
    expect(fixture.service.logs()).not.toContain('injected');
  } finally { await fixture.service.stop(); }
});
