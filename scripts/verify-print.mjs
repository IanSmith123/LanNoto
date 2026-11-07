// Windows/Chrome acceptance test. Only the browser is automated. Chrome's real
// print preview and Save-as-PDF destination are used; never Page.printToPDF.
import { chromium } from '../web/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('This acceptance script records Windows Chrome only');
const paper = process.argv[2] ?? 'normal';
const mermaidFixture = process.argv.includes('--mermaid');
assert.ok(['normal', 'narrow', 'continuous'].includes(paper), 'Paper must be normal, narrow or continuous');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'tests/artifacts'); await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, 'native-print-'));
const output = join(directory, 'output'); const profile = join(directory, 'profile');
await mkdir(join(directory, 'note/static'), { recursive: true }); await mkdir(join(profile, 'Default'), { recursive: true }); await mkdir(output);
function chunk(name, data) {
  const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, crc]);
}
const width = 1600, height = 1000; const pixels = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; pixels[at] = x * 255 / width; pixels[at + 1] = y * 255 / height; pixels[at + 2] = 150; }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
await writeFile(join(directory, 'note/static/大图.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
const markdown = mermaidFixture ? '# Mermaid 打印验收\n\n```mermaid\nflowchart LR\n  A[MERMAID_START 开始] --> B[MERMAID_END 完成]\n```\n\n'
  + '用于验证离屏图表的正文。\n\n'.repeat(75)
  + '```mermaid\nsequenceDiagram\n  Alice->>Bob: MERMAID_OFFSCREEN 你好\n```\n\nMERMAID_DOCUMENT_END\n'
  : '# 中文打印验收\n\n中文正文：协作笔记，中文不应缺字。\n\n'
  + '| 中文列一 | 中文列二 | 中文列三 | 中文列四 |\n| --- | --- | --- | --- |\n| TABLE_START ' + '宽表格内容'.repeat(12) + ' | 数据二 | 数据三 | TABLE_END |\n\n'
  + '```text\n' + Array.from({ length: 90 }, (_, index) => `CODE_${String(index).padStart(3, '0')}_START ` + 'long-code-'.repeat(18) + ` CODE_${String(index).padStart(3, '0')}_END`).join('\n') + '\n```\n\n'
  + '$$\nE=mc^2\n$$\n\n![大图](static/大图.png)\n\n'
  + Array.from({ length: 30 }, (_, index) => `## 正文第 ${index + 1} 节\n\n第 ${index + 1} 段中文正文。` + '这是用于验证多页打印的连续正文，段落不能消失。'.repeat(5)).join('\n\n') + '\n\nDOCUMENT_END_验收完成\n';
await writeFile(join(directory, 'note/打印验收.md'), markdown);
const preferences = { printing: { print_preview_sticky_settings: { appState: JSON.stringify({ recentDestinations: [{ id: 'Save as PDF', origin: 'local', account: '' }], selectedDestinationId: 'Save as PDF', version: 2, isHeaderFooterEnabled: false, isCssBackgroundEnabled: true }) } }, savefile: { default_directory: output } };
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify(preferences));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(root, 'dist/lannoto.exe'), ['--host', '127.0.0.1', '--port', String(port), '--password', 'print-test-password'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = ''; child.stderr.on('data', data => { logs += data.toString(); });
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
async function until(check, timeout = 20000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Acceptance condition did not become true');
}
async function open(context) {
  const page = context.pages()[0]; await page.goto(origin + '/note/' + encodeURIComponent('打印验收.md'));
  if (await page.getByLabel('服务密码').count()) { await page.getByLabel('服务密码').fill('print-test-password'); await page.getByRole('button', { name: '进入工作区' }).click(); }
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await page.getByRole('button', { name: '打印 / 保存为 PDF' }).click();
  await page.getByLabel('纸张布局').selectOption(paper);
  await page.locator('.print-view [role="status"]').filter({ hasText: '可打印' }).waitFor(); return page;
}
const walk = `(function walk(root){return [...root.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?walk(e.shadowRoot):[])])})(document)`;
let context;
try {
  await until(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(origin + '/api/config')).ok; } catch (error) { if (error instanceof TypeError) return false; throw error; } });
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, locale: 'zh-CN' });
  let page = await open(context); const version = context.browser().version();
  await writeFile(join(directory, 'paper-layout.txt'), `${paper}\n${await page.locator('.print-dimensions').textContent()}\n`);
  await writeFile(join(directory, 'prepared-body.html'), await page.locator('.print-body').innerHTML());
  const preparedBlockMath = await page.locator('.print-body math[display="block"]').count();
  if (mermaidFixture) assert.equal(await page.locator('.print-body img[src^="blob:"]').count(), 2);
  console.log('Prepared block mathematical elements:', preparedBlockMath);
  const printing = page.getByRole('button', { name: '打印', exact: true }).click({ timeout: 20000 });
  void printing.catch(() => {}); // Awaited below; prevent a cleanup race from masking the original failure.
  const cdp = await context.browser().newBrowserCDPSession();
  const target = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url === 'chrome://print/'));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let sequence = 0; const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => { if (event.sessionId === sessionId) { const message = JSON.parse(event.message); const promise = pending.get(message.id); if (promise) { pending.delete(message.id); clearTimeout(promise.timer); message.error ? promise.reject(new Error(JSON.stringify(message.error))) : promise.resolve(message.result); } } });
  async function command(method, params = {}) {
    const id = ++sequence;
    const response = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('Print preview protocol timed out')); }, 10000); pending.set(id, { resolve, reject, timer }); });
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }); return await response;
  }
  async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  const destination = await until(() => evaluate(`${walk}.find(e=>e.tagName==='SELECT'&&e.value==='Save as PDF/local/')?.value`));
  assert.equal(destination, 'Save as PDF/local/');
  await until(() => evaluate(`${walk}.some(e=>e.tagName==='CR-BUTTON'&&/^(保存|Save)$/.test(e.textContent.trim())&&!e.hasAttribute('disabled'))`));
  const screenshot = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(directory, 'chrome-print-preview.png'), Buffer.from(screenshot.data, 'base64'));
  assert.equal(await evaluate(`(()=>{const button=${walk}.find(e=>e.tagName==='CR-BUTTON'&&/^(取消|Cancel)$/.test(e.textContent.trim()));if(!button)return false;setTimeout(()=>button.click(),0);return true;})()`), true);
  await printing;
  await page.getByRole('button', { name: '关闭打印预览' }).click();
  await page.locator('#note-editor p').first().click(); await page.keyboard.press('Home'); await page.keyboard.insertText('取消打印后继续编辑。');
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal((await readdir(output)).filter(file => file.endsWith('.pdf')).length, 0);
  await writeFile(join(directory, 'cancel-verification.json'), JSON.stringify({ platform: process.platform, chrome: version, destination, cancelledWithoutFile: true, editingAfterCancel: true, pdfVerified: false }, null, 2));
  await context.close(); context = undefined;
  const persisted = JSON.parse(await readFile(join(profile, 'Default/Preferences'), 'utf8'));
  const sticky = JSON.parse(persisted.printing.print_preview_sticky_settings.appState);
  assert.equal(sticky.recentDestinations.length, 1);
  assert.equal(sticky.recentDestinations[0].id, 'Save as PDF');
  // Only this isolated, already verified PDF destination is automated. There
  // is no call to any OS printer or any production headless PDF dependency.
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, locale: 'zh-CN', args: ['--kiosk-printing'] });
  page = await open(context);
  const savedBlockMath = await page.locator('.print-body math[display="block"]').count();
  const savedMermaid = await page.locator('.print-body img[src^="blob:"]').count();
  if (mermaidFixture) assert.equal(savedMermaid, 2);
  const saving = page.getByRole('button', { name: '打印', exact: true }).click({ timeout: 20000 });
  void saving.catch(() => {}); // Still propagated by the explicit await below.
  const generated = await until(async () => {
    for (const name of await readdir(output)) {
      if (!name.endsWith('.pdf')) continue;
      const data = await readFile(join(output, name)); if (data.subarray(0, 5).toString() === '%PDF-' && data.subarray(-20).toString().includes('%%EOF')) return name;
    }
  }, 30000);
  await saving; await copyFile(join(output, generated), join(directory, 'native-print.pdf'));
  await page.getByRole('button', { name: '关闭打印预览' }).click();
  assert.equal(await page.getByRole('status').textContent(), '已保存');
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ platform: process.platform, chrome: version, destination, cancelledWithoutFile: true, editingAfterCancel: true, preparedBlockMath, savedBlockMath, fixture: mermaidFixture ? 'mermaid' : 'full', mermaidDiagramCount: savedMermaid, renderedFormulaPassed: mermaidFixture ? null : preparedBlockMath === 1 && savedBlockMath === 1, method: 'headed Chrome real print preview; second run uses isolated kiosk-printing Save-as-PDF destination, not CDP printToPDF', pdf: join(directory, 'native-print.pdf') }, null, 2));
  console.log(`Native Chrome PDF and preview: ${directory}`);
  if (!mermaidFixture) {
    assert.equal(preparedBlockMath, 1, 'Official Crepe left the offscreen formula as a source placeholder; native PDF acceptance failed');
    assert.equal(savedBlockMath, 1, 'Saved print snapshot lacks its rendered formula');
  }
} finally {
  try { if (context) await context.close(); }
  finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
}
