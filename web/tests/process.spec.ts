import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, rename, mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { boot, workspace, availablePort } from './process-fixture';
import * as Y from 'yjs';

test('unsupported development snapshots are rejected without migrating or changing source', async ({ page }) => {
  const cwd = await workspace();
  const filename = '恢复测试.md', disk = await readFile(join(cwd, 'note', filename), 'utf8');
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText();
  paragraph.insert(0, [text]); text.insert(0, '旧状态尚未投影😀'); doc.getXmlFragment('prosemirror').insert(0, [paragraph]);
  const original = { filename, initialized: true, revision: 2, crdt: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), markdownRevision: 1, markdown: disk, diskHash: createHash('sha256').update(disk).digest('hex') };
  doc.destroy();
  const directory = join(cwd, '.lannoto', 'state'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename + '.json'), JSON.stringify(original));
  expect(await rejectedStartup(cwd)).toContain('unknown document format');
  expect(JSON.parse(await readFile(join(directory,filename+'.json'),'utf8'))).toEqual(original);
  expect(await readFile(join(cwd,'note',filename),'utf8')).toBe(disk);
});

async function login(page: Page, url: string, password = 'process-test-password') {
  await page.goto(`${url}/note/${encodeURIComponent('恢复测试.md')}`);
  await page.getByLabel('服务密码').fill(password);
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
}

test('existing Git repository remains untouched while saving and restarting without Git on PATH', async ({ page }) => {
  const cwd = await workspace();
  // Only a sentinel is committed in this disposable fixture, never note content.
  execFileSync('git', ['init', '--quiet'], { cwd, windowsHide: true });
  await writeFile(join(cwd, 'repository.txt'), 'Existing repository sentinel\n');
  execFileSync('git', ['add', 'repository.txt'], { cwd, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=LanNoto fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Fixture baseline'], { cwd, windowsHide: true });
  async function gitFiles(directory: string, prefix = ''): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); const name = prefix + entry.name;
      if (entry.isDirectory()) Object.assign(result, await gitFiles(path, name + '/'));
      else result[name] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
    return result;
  }
  const originalGit = await gitFiles(join(cwd, '.git'));
  const pandoc = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['pandoc'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  const systemPath = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '';
  const env = { ...process.env, PATH: systemPath, Path: systemPath };
  let unavailable = false;
  try { execFileSync('git', ['--version'], { cwd, env, windowsHide: true, stdio: 'pipe' }); }
  catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ENOENT'); unavailable = true; }
  expect(unavailable).toBe(true);
  let service = await boot(cwd, 'process-test-password', undefined, { env, path: pandoc });
  try {
    await login(page, service.url);
    await page.locator('#note-editor p').first().click();
    await page.keyboard.press('Home'); await page.keyboard.insertText('无需Git也能保存😀');
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect(await readFile(join(cwd, 'note/恢复测试.md'), 'utf8')).toContain('无需Git也能保存😀');
    await page.keyboard.press('Control+s'); await expect(page.getByRole('status')).toHaveText('已保存');
    const historyAPI='/api/notes/'+encodeURIComponent('恢复测试.md')+'/history';
    await expect.poll(async()=> (await (await page.request.get(service.url+historyAPI)).json()).items.some((item:{reason:string})=>item.reason==='manual')).toBe(true);
    const checkpoint=(await (await page.request.get(service.url+historyAPI)).json()).items[0].id;
    await service.stop();
    service = await boot(cwd, 'process-test-password', service.port, { env, path: pandoc });
    await login(page, service.url);
    await expect(page.locator('#note-editor')).toContainText('无需Git也能保存😀');
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect((await (await page.request.get(service.url+historyAPI+'/'+checkpoint)).json()).markdown).toContain('无需Git也能保存😀');
  } finally { await service.stop(); }
  expect(await gitFiles(join(cwd, '.git'))).toEqual(originalGit);
  expect(await readFile(join(cwd, 'repository.txt'), 'utf8')).toBe('Existing repository sentinel\n');
});

test('real process restart restores a persisted CRDT ahead of Markdown', async ({ page }) => {
  const cwd = await workspace();
  let service = await boot(cwd);
  try {
    await login(page, service.url);
    await page.locator('#note-editor p').filter({ hasText: '初始正文。' }).first().click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('已确认😀');
    const snapshot = join(cwd, '.lannoto', 'state', '恢复测试.md.json');
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(snapshot, 'utf8'));
      return state.revision > state.markdownRevision;
    }, { intervals: [5, 10, 20, 30] }).toBe(true);
    await service.stop();
    service = await boot(cwd, 'process-test-password', service.port);
    await login(page, service.url);
    await expect(page.locator('#note-editor')).toContainText('已确认😀');
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect((await readFile(join(cwd, 'note', '恢复测试.md'), 'utf8')).includes('已确认😀')).toBe(true);
  } finally { await service.stop(); }
});

test('actual snapshot replacement failure exits nonzero and never reports saved', async ({ page }) => {
  const cwd = await workspace();
  const service = await boot(cwd);
  try {
    await login(page, service.url);
    const snapshot = join(cwd, '.lannoto', 'state', '恢复测试.md.json');
    await rename(snapshot, `${snapshot}.backup`);
    await mkdir(snapshot);
    await page.locator('#note-editor p').filter({ hasText: '初始正文。' }).first().click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('不能确认');
    await expect.poll(() => service.child.exitCode).not.toBeNull();
    expect(await service.exited).not.toBe(0);
    expect((await readFile(join(cwd, 'note', '恢复测试.md'), 'utf8')).includes('不能确认')).toBe(false);
    expect(service.logs().includes('generated_password')).toBe(false);
    expect(service.logs().includes('process-test-password')).toBe(false);
    await expect(page.getByRole('status')).not.toHaveText('已保存');
  } finally { await service.stop(); }
});

test('generated startup passwords are unique, usable and absent from config', async ({ page }) => {
  const cwd = await workspace();
  const first = await boot(cwd, null);
  let second: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    const matches = [...first.logs().matchAll(/generated_password=([^\s]+)/g)];
    expect(matches.length).toBe(1);
    const password = matches[0][1];
    expect(password.length >= 26).toBe(true);
    await login(page, first.url, password);
    const config = await page.request.get(`${first.url}/api/config`);
    expect((await config.text()).includes(password)).toBe(false);
    await first.stop();
    second = await boot(cwd, '', first.port);
    const next = [...second.logs().matchAll(/generated_password=([^\s]+)/g)];
    expect(next.length).toBe(1);
    expect(next[0][1] === password).toBe(false);
    expect((await page.request.get(`${second.url}/api/session`)).status()).toBe(401);
    const rejected = await page.request.post(`${second.url}/api/session`, { headers: { Origin: second.url }, data: { password } });
    expect(rejected.status()).toBe(401);
    await login(page, second.url, next[0][1]);
  } finally { await first.stop(); if (second) await second.stop(); }
});

test('external online overwrite stops the room and restart uses actual disk content', async ({ page }) => {
  const cwd = await workspace(); let service = await boot(cwd);
  try {
    await login(page, service.url);
    const path = join(cwd, 'note', '恢复测试.md');
    await writeFile(path, '# 外部修改\n\n新正文不应丢失。\n');
    const metadata = await page.request.get(service.url + '/api/notes/' + encodeURIComponent('恢复测试.md'));
    expect(metadata.status()).toBe(409);
    await expect(page.getByRole('status')).toContainText('文件已在外部修改');
    expect(await readFile(path, 'utf8')).toContain('新正文不应丢失');
    expect(service.child.exitCode).toBeNull();
    await service.stop(); service = await boot(cwd, 'process-test-password', service.port);
    await login(page, service.url);
    await expect(page.locator('#note-editor')).toContainText('新正文不应丢失');
    await expect(page.locator('#note-editor')).not.toContainText('初始正文');
  } finally { await service.stop(); }
});

test('renaming a live file exposes only its new name without resurrecting the old note', async ({ page }) => {
  const cwd = await workspace(); const service = await boot(cwd);
  try {
    await login(page, service.url);
    await rename(join(cwd, 'note', '恢复测试.md'), join(cwd, 'note', '更名后的笔记.md'));
    expect((await page.request.get(service.url + '/api/notes/' + encodeURIComponent('恢复测试.md'))).status()).toBe(404);
    await expect(page.getByRole('status')).toContainText('文件已不存在');
    const list = await (await page.request.get(service.url + '/api/notes')).json();
    expect(list).toContain('更名后的笔记.md'); expect(list).not.toContain('恢复测试.md');
    await page.goto(service.url + '/note/' + encodeURIComponent('更名后的笔记.md'));
    await expect(page.getByRole('status')).toHaveText('已保存');
    await expect(page.locator('#note-editor')).toContainText('初始正文');
    expect((await page.request.get(service.url + '/note/' + encodeURIComponent('恢复测试.md'))).status()).toBe(404);
    await expect(stat(join(cwd, 'note', '恢复测试.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await service.stop(); }
});

async function rejectedStartup(cwd: string) {
  const port = await availablePort(); let logs = '';
  const child = spawn(resolve('../dist/lannoto' + (process.platform === 'win32' ? '.exe' : '')), ['--host', '127.0.0.1', '--port', String(port), '--password', 'startup-test-password'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data.toString(); }); child.stderr.on('data', data => { logs += data.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    await expect.poll(() => child.exitCode).not.toBeNull();
    expect(await exited).not.toBe(0); expect(logs).not.toContain('LanNoto started'); expect(logs).not.toContain('startup-test-password');
    return logs;
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
}

test('a second real process cannot acquire the same workspace lock', async () => {
  const cwd = await workspace(); const service = await boot(cwd);
  try { expect(await rejectedStartup(cwd)).toContain('workspace is already in use'); expect(service.child.exitCode).toBeNull(); }
  finally { await service.stop(); }
});

test('corrupt authoritative snapshot rejects real startup without replacing note or snapshot', async ({ page }) => {
  const cwd = await workspace(); const service = await boot(cwd);
  try { await login(page, service.url); } finally { await service.stop(); }
  const note = join(cwd, 'note', '恢复测试.md'); const snapshot = join(cwd, '.lannoto/state/恢复测试.md.json');
  const before = await readFile(note); await writeFile(snapshot, '{broken snapshot');
  expect(await rejectedStartup(cwd)).toContain('snapshot');
  expect((await readFile(note)).equals(before)).toBe(true); expect(await readFile(snapshot, 'utf8')).toBe('{broken snapshot');
});

test('editing Markdown while the real process is stopped replaces old recovery state on restart', async ({ page }) => {
  const cwd = await workspace(); let service = await boot(cwd);
  try {
    await login(page, service.url); await service.stop();
    await writeFile(join(cwd, 'note/恢复测试.md'), '# 停机期间修改\n\n实际新正文😀。\n');
    service = await boot(cwd, 'process-test-password', service.port);
    await login(page, service.url);
    await expect(page.locator('#note-editor')).toContainText('实际新正文😀');
    await expect(page.locator('#note-editor')).not.toContainText('初始正文');
    const state = JSON.parse(await readFile(join(cwd, '.lannoto/state/恢复测试.md.json'), 'utf8'));
    expect(state.markdown).toContain('实际新正文😀');
    expect(await readFile(join(cwd, 'note/恢复测试.md'), 'utf8')).toContain('实际新正文😀');
  } finally { await service.stop(); }
});

test('real projection replacement failure preserves its first committed snapshot and recovers on restart', async ({ page }) => {
  test.skip(process.platform !== 'win32', 'Uses Windows file sharing to stop the exact Markdown replacement stage');
  const holderPath = resolve('../tests/artifacts/hold-file.exe');
  execFileSync('go', ['build', '-o', holderPath, './tests/fixtures/holdfile'], { cwd: '..', windowsHide: true });
  const cwd = await workspace(); let service = await boot(cwd);
  let holder: ReturnType<typeof spawn> | undefined; let holderExited: Promise<number | null> | undefined;
  try {
    await login(page, service.url);
    const path = join(cwd, 'note/恢复测试.md'); const original = await readFile(path);
    holder = spawn(holderPath, [path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; holder.stdout!.on('data', data => { output += data.toString(); });
    holderExited = new Promise((resolve, reject) => { holder!.once('error', reject); holder!.once('exit', resolve); });
    await expect.poll(() => output).toContain('locked');
    await page.locator('#note-editor p').first().click(); await page.keyboard.press('Home'); await page.keyboard.insertText('快照已提交😀');
    await expect.poll(() => service.child.exitCode).not.toBeNull(); expect(await service.exited).not.toBe(0);
    expect(service.logs()).toContain('replace');
    const snapshot = JSON.parse(await readFile(join(cwd, '.lannoto/state/恢复测试.md.json'), 'utf8'));
    expect(snapshot.markdown).toContain('快照已提交😀');
    expect(snapshot.markdownRevision).toBe(snapshot.revision);
    expect(snapshot.diskHash).toBe(createHash('sha256').update(original).digest('hex'));
    expect((await readFile(path)).equals(original)).toBe(true);
    await expect(page.getByRole('status')).not.toHaveText('已保存');
    holder.stdin!.end(); expect(await holderExited).toBe(0); holder = undefined;
    service = await boot(cwd, 'process-test-password', service.port);
    await login(page, service.url); await expect(page.locator('#note-editor')).toContainText('快照已提交😀');
    const recovered = await readFile(path, 'utf8'); expect(recovered).toContain('快照已提交😀');
    expect(recovered.split('快照已提交😀').length - 1).toBe(1);
    const final = JSON.parse(await readFile(join(cwd, '.lannoto/state/恢复测试.md.json'), 'utf8'));
    expect(final.diskHash).toBe(createHash('sha256').update(recovered).digest('hex'));
  } finally {
    if (holder) { holder.stdin!.end(); if (holderExited) await holderExited; }
    await service.stop();
  }
});

test('filesystem-rejected long names are input errors and do not terminate the service', async ({ page }) => {
  const cwd = await workspace(); const service = await boot(cwd);
  try {
    await login(page, service.url);
    const filename = 'a'.repeat(300) + '.md';
    const response = await page.request.post(service.url + '/api/notes', { headers: { Origin: service.url }, data: { filename, markdown: '# 长文件名\n' } });
    expect(response.status(), service.logs()).toBe(400);
    expect((await response.json()).code).toBe('invalid_filename');
    const snapshotName = 'c'.repeat(248) + '.md';
    const snapshotRejection = await page.request.post(service.url + '/api/notes', { headers: { Origin: service.url }, data: { filename: snapshotName, markdown: '正文' } });
    expect(snapshotRejection.status(), service.logs()).toBe(400);
    expect((await (await page.request.get(service.url + '/api/notes')).json())).not.toContain(filename);
    const upload = await page.request.post(service.url + '/api/notes/' + encodeURIComponent('恢复测试.md') + '/assets', {
      headers: { Origin: service.url }, multipart: { sourceKind: 'file', file: { name: 'b'.repeat(300) + '.txt', mimeType: 'text/plain', buffer: Buffer.from('test') } },
    });
    expect(upload.status(), service.logs()).toBe(400); expect((await upload.json()).code).toBe('invalid_filename');
    expect((await page.request.get(service.url + '/api/session')).status()).toBe(200);
    expect(service.child.exitCode).toBeNull();
    await expect(page.getByRole('status')).toHaveText('已保存');
    if (process.platform === 'win32') {
      // Native Windows accepts this UTF-16 name despite exceeding 255 UTF-8
      // bytes. Do not invent a global byte cap that rejects valid Chinese names.
      const validName = '界'.repeat(100) + '.md';
      expect((await page.request.post(service.url + '/api/notes', { headers: { Origin: service.url }, data: { filename: validName, markdown: '合法中文文件名' } })).status()).toBe(201);
      expect((await page.request.get(service.url + '/api/notes/' + encodeURIComponent(validName))).status()).toBe(200);
    }
  } finally { await service.stop(); }
});

test('missing Pandoc does not block startup or editing and Word explains platform installation', async ({ page }) => {
  const cwd = await workspace(); const service = await boot(cwd, 'process-test-password', undefined, { path: join(cwd, 'pandoc-not-installed') });
  try {
    await login(page, service.url);
    await page.locator('#note-editor p').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText('无 Pandoc 仍可保存');
    await expect(page.getByRole('status')).toHaveText('已保存');
    await page.getByRole('button', { name: '下载 Word' }).click();
    await expect(page.getByRole('alert')).toContainText('Word 导出需要 Pandoc');
    await expect(page.getByRole('alert')).toContainText('https://pandoc.org/installing.html');
    await expect(page.getByRole('alert')).toContainText(process.platform === 'win32' ? 'winget install' : process.platform === 'darwin' ? 'brew install pandoc' : 'Linux');
    expect(service.child.exitCode).toBeNull();
    const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 Markdown' }).click(); expect((await downloading).suggestedFilename()).toBe('恢复测试.md');
    await expect(page.getByRole('status')).toHaveText('已保存');
  } finally { await service.stop(); }
});
