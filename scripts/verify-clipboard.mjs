// Trusted paste events from Chromium's isolated headless clipboard. The application
// stays on insecure LAN HTTP; a separate localhost page writes test pixels.
import { chromium } from '../web/node_modules/playwright/index.mjs';
import { expect } from '../web/node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.argv[2] ?? 'chrome';
if (channel !== 'chrome' && channel !== 'msedge') throw new Error('Use chrome or msedge');
const local = Object.values(networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address));
if (!local) throw new Error('No private LAN IPv4 interface available; do not substitute loopback for this acceptance test');
const artifacts = join(root, 'tests/artifacts'); await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, 'native-clipboard-')); await mkdir(join(directory, 'note'));
await writeFile(join(directory, 'note/剪贴板验收.md'), '# 局域网原生剪贴板\n\n在这里粘贴测试图片。\n');
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '0.0.0.0', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://${local.address}:${port}`; const helperOrigin = `http://127.0.0.1:${port}`;
const child = spawn(join(root, 'dist', process.platform === 'win32' ? 'lannoto.exe' : 'lannoto'), ['--host', '0.0.0.0', '--port', String(port), '--password', 'clipboard-test-password'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = ''; child.stderr.on('data', data => { logs += data.toString(); });
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
let context;
try {
  await expect.poll(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(helperOrigin + '/api/config')).status; } catch (error) { if (error instanceof TypeError) return 0; throw error; } }).toBe(200);
  context = await chromium.launchPersistentContext(join(directory, 'profile'), { channel, headless: true });
  await context.grantPermissions(['clipboard-write'], { origin: helperOrigin });
  const helper = context.pages()[0]; await helper.goto(helperOrigin + '/note/');
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.clipboardObservations = [];
    document.addEventListener('paste', event => {
      window.clipboardObservations.push({ trusted: event.isTrusted, types: [...event.clipboardData.types], files: [...event.clipboardData.files].map(file => ({ name: file.name, type: file.type, size: file.size })) });
    }, { capture: true });
  });
  await page.goto(origin + '/note/' + encodeURIComponent('剪贴板验收.md'));
  await page.getByLabel('服务密码').fill('clipboard-test-password'); await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
  const environment = await page.evaluate(() => ({ secureContext: isSecureContext, asyncClipboardAvailable: navigator.clipboard !== undefined }));
  assert.equal(environment.secureContext, false); assert.equal(environment.asyncClipboardAvailable, false);
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/assets')) uploads++; });
  const imagePath = join(root, 'web/tests/fixtures/image.png');
  const image = [...await readFile(imagePath)];
  async function separateInsertion() {
    await page.locator('#note-editor').getByRole('textbox').first().click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
    await page.keyboard.press('Enter');
  }
  async function nativePaste() {
    await helper.bringToFront();
    await helper.evaluate(async bytes => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]); }, image);
    await page.bringToFront(); await separateInsertion();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  }
  await nativePaste();
  await expect(page.locator('.upload-status')).toHaveText(/已插入 \d{14}\.png/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('已保存'); assert.equal(uploads, 1);
  await page.screenshot({ path: join(directory, 'native-paste-timestamp.png'), fullPage: true });
  const timestampFile = (await readdir(join(directory, 'note/static'))).find(name => /^\d{14}\.png$/.test(name)); assert.ok(timestampFile);
  assert.equal(await page.locator('#note-editor img').evaluate(image => image.naturalWidth), 96);
  // A genuine named file input is independent of native clipboard pixels.
  await separateInsertion();
  await page.locator('#upload-files').setInputFiles(imagePath);
  await expect(page.locator('.upload-status')).toHaveText('已插入 image.png');
  await expect(page.getByRole('status')).toHaveText('已保存'); assert.equal(uploads, 2);
  assert.equal(Buffer.compare(await readFile(join(directory, 'note/static/image.png')), Buffer.from(image)), 0);
  const observations = await page.evaluate(() => window.clipboardObservations);
  assert.equal(observations.length, 1); assert.ok(observations[0].trusted);
  assert.equal(observations[0].files.length, 1);
  assert.equal(observations[0].files[0].type, 'image/png');
  const markdown = await readFile(join(directory, 'note/剪贴板验收.md'), 'utf8'); assert.ok(markdown.includes(timestampFile)); assert.ok(markdown.includes('static/image.png'));
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ platform: process.platform, channel, browserVersion: context.browser().version(), origin, environment, observations, uploads, timestampFile, namedFile: 'image.png', scope: 'Browser-written pixels on an isolated headless clipboard pasted with a trusted keyboard event on LAN HTTP' }, null, 2));
  console.log(`Native clipboard acceptance passed: ${directory}`);
} finally {
  try { if (context) await context.close(); }
  finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
}
