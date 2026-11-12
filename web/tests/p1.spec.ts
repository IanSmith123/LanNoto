import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function login(page: Page, path = '/note/%E4%BC%9A%E8%AE%AE%E7%BA%AA%E8%A6%81.md'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('服务密码').fill('p1-test-password');
  await page.getByRole('button', { name: '进入工作区' }).click();
}

async function paragraphText(page: Page): Promise<string> {
  return await page.locator('#note-editor p').first().evaluate(paragraph => {
    const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('.ProseMirror-yjs-cursor') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const parts: string[] = []; while (text.nextNode()) parts.push(text.currentNode.textContent ?? '');
    return parts.join('');
  });
}

test('two authenticated isolated browsers edit an existing Chinese note and save', async ({ browser, page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const context = await browser.newContext({ locale: 'zh-CN' });
  const other = await context.newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  try {
    await Promise.all([login(page), login(other)]);
    await expect(page.locator('#note-editor')).toContainText('待办正文。');
    await expect(other.locator('#note-editor')).toContainText('待办正文。');
    await expect(page.getByLabel('在线成员')).toContainText('2 人在线');
    await page.locator('#note-editor p').filter({ hasText: '待办正文。' }).first().click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('甲方😀');
    await other.locator('#note-editor p').filter({ hasText: '待办正文。' }).first().click();
    await other.keyboard.press('End');
    await other.keyboard.insertText('乙方📝');
    await expect(page.locator('#note-editor')).toContainText('甲方😀');
    await expect(page.locator('#note-editor')).toContainText('乙方📝');
    await expect(other.locator('#note-editor')).toContainText('甲方😀');
    await expect(other.locator('#note-editor')).toContainText('乙方📝');
    await expect(page.getByRole('status')).toHaveText('已保存');
    await expect(other.getByRole('status')).toHaveText('已保存');
    // Blur both editors through the public readonly controls before comparing
    // rendered text: each peer otherwise contains a different remote cursor
    // decoration and member label, which is not document content.
    await Promise.all([
      page.getByRole('button', { name: '预览', exact: true }).click(),
      other.getByRole('button', { name: '预览', exact: true }).click(),
    ]);
    await expect(page.locator('#note-editor').getByRole('textbox').first()).toHaveAttribute('contenteditable', 'false');
    await expect.poll(async () => (await page.locator('#note-editor').innerText()) === (await other.locator('#note-editor').innerText())).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('original filename URLs, explicit create conflicts, authentication and stale builds', async ({ page }) => {
  expect((await page.request.get('/api/notes')).status()).toBe(401);
  await login(page, '/note/Project%20Notes.md');
  await expect(page.locator('#note-editor')).toContainText('Existing content.');
  await expect(page.getByRole('status')).toHaveText('已保存');
  const origin = new URL(page.url()).origin;
  const conflict = await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename: 'Project Notes.md', markdown: 'must not overwrite' } });
  expect(conflict.status()).toBe(409);
  const mismatch = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/api/notes/Project%20Notes.md/ws`);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'join', buildId: 'stale-build', clientId: 123, name: 'test', color: '#2563eb' }));
    socket.onmessage = (event) => { const message = JSON.parse(String(event.data)); socket.close(); resolve(message.code); };
    socket.onerror = () => reject(new Error('test WebSocket failed'));
  }));
  expect(mismatch).toBe('build_mismatch');
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByLabel('笔记文件名', { exact: true }).fill('新建 中文.md');
  await page.getByRole('dialog').getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/%E6%96%B0%E5%BB%BA%20%E4%B8%AD%E6%96%87.md$/);
  await expect(page.getByRole('status')).toHaveText('已保存');
});

test('a delayed saved acknowledgement cannot strand a newer projection', async ({ page }) => {
  let delaying = false;
  let accepted: (() => void) | undefined;
  const firstSave = new Promise<void>((resolve) => { accepted = resolve; });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  await page.routeWebSocket('**/ws', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (delaying && message.type === 'saved') {
        accepted?.();
        const timer = setTimeout(() => { timers.delete(timer); socket.send(data); }, 700);
        timers.add(timer);
      } else socket.send(data);
    });
  });
  try {
    await login(page);
    await expect(page.getByRole('status')).toHaveText('已保存');
    delaying = true;
    await page.locator('#note-editor p').filter({ hasText: '待办正文。' }).first().click();
    await page.keyboard.press('Home'); await page.keyboard.insertText('旧确认');
    await firstSave;
    await page.keyboard.insertText('新修改');
    await expect(page.getByRole('status')).toHaveText('已保存', { timeout: 10000 });
    await expect(page.locator('#note-editor')).toContainText('新修改');
  } finally { for (const timer of timers) clearTimeout(timer); }
});

test('lost update acknowledgement reconnects and resends without duplicate content', async ({ page }) => {
  let dropNext = false;
  await page.routeWebSocket('**/ws', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (dropNext && message.type === 'update') {
        dropNext = false;
        socket.close({ code: 1012, reason: 'test transport interruption' });
        server.close({ code: 1012, reason: 'test transport interruption' });
      } else socket.send(data);
    });
  });
  await login(page);
  await expect(page.getByRole('status')).toHaveText('已保存');
  dropNext = true;
  await page.locator('#note-editor p').filter({ hasText: '待办正文。' }).first().click();
  await page.keyboard.press('Home'); await page.keyboard.insertText('仅一次');
  await expect(page.getByRole('status')).toContainText('连接中断');
  await expect(page.locator('#note-editor').getByRole('textbox').first()).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('status')).toHaveText('已保存', { timeout: 10000 });
  expect((await page.locator('#note-editor').innerText()).split('仅一次').length - 1).toBe(1);
});

test('lost initialization acknowledgement reconnects without reseeding the template', async ({ page }) => {
  let dropped = false;
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer();
    server.onMessage(data => {
      const message = JSON.parse(String(data));
      if (!dropped && message.type === 'init') {
        dropped = true; socket.close({ code: 1012, reason: 'lost initialization acknowledgement' }); server.close();
      } else socket.send(data);
    });
  });
  await login(page, '/note/');
  await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  const response = await page.request.post('/api/notes', { headers: { Origin: new URL(page.url()).origin }, data: { filename: '初始化重连.md', markdown: '# 只初始化一次\n\n原始内容。\n' } });
  expect(response.status()).toBe(201);
  await page.goto('/note/' + encodeURIComponent('初始化重连.md'));
  await expect(page.getByRole('status')).toHaveText('已保存', { timeout: 15000 });
  expect(dropped).toBe(true);
  expect((await page.locator('#note-editor').innerText()).split('只初始化一次').length - 1).toBe(1);
});

test('another initializer cannot merge a disconnected provisional template', async ({ page, browser }) => {
  let interrupted = false; let otherReady = false;
  await page.routeWebSocket('**/ws', socket => {
    if (interrupted && !otherReady) { socket.close(); return; }
    const server = socket.connectToServer();
    socket.onMessage(data => {
      if (!interrupted && JSON.parse(String(data)).type === 'initialize') {
        interrupted = true; socket.close({ code: 1012, reason: 'initializer disconnected before commit' }); server.close();
      } else server.send(data);
    });
  });
  await login(page, '/note/');
  await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  expect((await page.request.post('/api/notes', { headers: { Origin: new URL(page.url()).origin }, data: { filename: '初始化转交.md', markdown: '# 独立初始化\n\n不应重复。\n' } })).status()).toBe(201);
  await page.goto('/note/' + encodeURIComponent('初始化转交.md'));
  await expect(page.getByRole('status')).toHaveText('已断开，等待连接');
  const context = await browser.newContext({ locale: 'zh-CN' });
  try {
    const other = await context.newPage(); await login(other, '/note/' + encodeURIComponent('初始化转交.md'));
    await expect(other.getByRole('status')).toHaveText('已保存'); otherReady = true;
    await expect(page.getByRole('status')).toHaveText('初始化已由其他成员完成，请重新打开此笔记', { timeout: 15000 });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存');
    expect((await page.locator('#note-editor').innerText()).split('独立初始化').length - 1).toBe(1);
  } finally { await context.close(); }
});

test('same-paragraph Chinese deletion and emoji insertion converge, undo stays local and departed cursor disappears', async ({ page, browser }) => {
  await login(page, '/note/');
  await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const filename = `同段删除与插入${test.info().repeatEachIndex}.md`;
  expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown: '# 同段并发\n\n甲乙丙丁😀\n' } })).status()).toBe(201);
  const path = '/note/' + encodeURIComponent(filename);
  await page.goto(path); await expect(page.getByRole('status')).toHaveText('已保存');
  const context = await browser.newContext({ locale: 'zh-CN' }); const other = await context.newPage();
  try {
    await login(other, path); await expect(other.getByRole('status')).toHaveText('已保存');
    await expect(page.getByLabel('在线成员')).toContainText('2 人在线');
    await page.locator('#note-editor p').first().click();
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight');
    await other.locator('#note-editor p').first().click(); await other.keyboard.press('End');
    await expect(page.locator('.ProseMirror-yjs-cursor')).toHaveCount(1);
    await Promise.all([page.keyboard.press('Backspace'), other.keyboard.insertText('协作📝')]);
    for (const peer of [page, other]) {
      await expect.poll(() => paragraphText(peer)).toBe('乙丙丁😀协作📝');
      await expect(peer.locator('#note-editor')).not.toContainText('甲');
      await expect(peer.getByRole('status')).toHaveText('已保存');
    }
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    for (const peer of [page, other]) await expect.poll(() => paragraphText(peer)).toBe('甲乙丙丁😀协作📝');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Shift+Z');
    for (const peer of [page, other]) {
      await expect.poll(() => paragraphText(peer)).toBe('乙丙丁😀协作📝');
      await expect(peer.locator('#note-editor')).not.toContainText('甲');
      await expect(peer.getByRole('status')).toHaveText('已保存');
    }
    await context.close();
    await expect(page.getByLabel('在线成员')).toContainText('1 人在线');
    await expect(page.locator('.ProseMirror-yjs-cursor')).toHaveCount(0);
  } finally { await context.close(); }
});

test('Chromium composition pipeline commits Chinese while another browser edits the same paragraph', async ({ page, browser }) => {
  await login(page, '/note/'); await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  const origin = new URL(page.url()).origin; const filename = '组合输入.md';
  expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown: '# 组合输入\n\n原始正文。\n' } })).status()).toBe(201);
  const path = '/note/' + encodeURIComponent(filename); await page.goto(path); await expect(page.getByRole('status')).toHaveText('已保存');
  const context = await browser.newContext({ locale: 'zh-CN' }); const other = await context.newPage();
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const state = window as typeof window & { compositionEvents: { type: string; text: string; trusted: boolean }[] };
    state.compositionEvents = [];
    for (const kind of ['compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(kind, event => {
      state.compositionEvents.push({ type: event.type, text: (event as CompositionEvent).data, trusted: event.isTrusted });
    }, { capture: true });
  });
  try {
    await login(other, path); await expect(other.getByRole('status')).toHaveText('已保存');
    await other.locator('#note-editor p').first().click(); await other.keyboard.press('End');
    await page.locator('#note-editor p').first().click(); await page.keyboard.press('Home');
    await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await other.keyboard.insertText('远端😀');
    await cdp.send('Input.insertText', { text: '中文' });
    for (const peer of [page, other]) {
      await expect.poll(() => paragraphText(peer)).toBe('中文原始正文。远端😀');
      await expect(peer.getByRole('status')).toHaveText('已保存');
    }
    const events = await page.evaluate(() => (window as typeof window & { compositionEvents: { type: string; text: string; trusted: boolean }[] }).compositionEvents);
    expect(events.some(event => event.type === 'compositionstart' && event.trusted)).toBe(true);
    expect(events.some(event => event.type === 'compositionupdate' && event.text === '中文' && event.trusted)).toBe(true);
    expect(events.some(event => event.type === 'compositionend' && event.text === '中文')).toBe(true);
  } finally {
    const events = await page.evaluate(() => (window as typeof window & { compositionEvents: unknown[] }).compositionEvents);
    await test.info().attach('browser-composition-events', { body: JSON.stringify(events), contentType: 'application/json' });
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir('../tests/artifacts', { recursive: true });
    await writeFile('../tests/artifacts/composition-events.json', JSON.stringify(events, null, 2));
    await cdp.detach(); await context.close();
  }
});

test('refreshing the file list preserves the active editor without a disconnected socket error', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page.getByRole('status')).toHaveText('已保存');
  let connections = 0; page.on('websocket', () => connections++);
  await page.locator('#note-editor').evaluate(element => element.dataset.refreshSentinel = 'kept');
  for (let index = 0; index < 3; index++) {
    await page.getByRole('button', { name: '刷新文件列表' }).click();
    await expect(page.getByRole('status')).toHaveText('已保存');
    await expect(page.locator('#note-editor')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('#note-editor')).toHaveAttribute('data-refresh-sentinel', 'kept');
  }
  expect(connections).toBe(0);
  await page.locator('#note-editor p').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText('刷新后仍可编辑');
  await expect(page.getByRole('status')).toHaveText('已保存');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor')).toContainText('刷新后仍可编辑');
  expect(errors).toEqual([]);
});

test('offline rich edits merge automatically with another online editor', async ({ page, browser }) => {
  let blocked = false; let disconnect: (() => void) | undefined;
  await page.routeWebSocket('**/ws', socket => {
    if (blocked) { socket.close({ code: 1012 }); return; }
    const server = socket.connectToServer(); disconnect = () => { socket.close({ code: 1012 }); server.close({ code: 1012 }); };
  });
  await login(page, '/note/'); await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  const filename = '离线协作合并.md', origin = new URL(page.url()).origin;
  expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown: '# 离线协作\n\n共同正文。\n' } })).status()).toBe(201);
  await page.goto('/note/' + encodeURIComponent(filename)); await expect(page.getByRole('status')).toHaveText('已保存');
  const context = await browser.newContext({ locale: 'zh-CN' }); const peer = await context.newPage();
  try {
    await login(peer, origin + '/note/' + encodeURIComponent(filename)); await expect(peer.getByRole('status')).toHaveText('已保存');
    blocked = true; disconnect?.();
    await expect(page.getByRole('status')).toContainText('连接中断');
    await expect(page.locator('#note-editor').getByRole('textbox').first()).toHaveAttribute('contenteditable', 'true');
    await page.locator('#note-editor p').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText('离线修改😀');
    await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: '刷新文件列表' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await peer.locator('#note-editor p').first().click(); await peer.keyboard.press('Home'); await peer.keyboard.insertText('在线修改🌿');
    await expect(peer.getByRole('status')).toHaveText('已保存');
    await expect(page.locator('#note-editor')).toContainText('离线修改😀');
    blocked = false;
    await expect(page.getByRole('status')).toHaveText('已保存', { timeout: 20000 });
    await expect(peer.locator('#note-editor')).toContainText('离线修改😀');
    await expect(page.locator('#note-editor')).toContainText('在线修改🌿');
    expect(await paragraphText(page)).toBe(await paragraphText(peer));
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存');
    await expect(page.locator('#note-editor')).toContainText('离线修改😀');
    await expect(page.locator('#note-editor')).toContainText('在线修改🌿');
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await context.close(); }
});

test('HTML gateway failures during reconnect preserve offline edits and retry automatically', async ({ page }) => {
  let disconnect: (() => void) | undefined;
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer();
    disconnect = () => { socket.close({ code: 1012 }); server.close({ code: 1012 }); };
  });
  await login(page);
  await expect(page.getByRole('status')).toHaveText('已保存');
  let failures = 0;
  await page.route('**/api/session', route => {
    failures++;
    return route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Service Unavailable</h1>' });
  });
  disconnect?.();
  await expect.poll(() => failures).toBeGreaterThan(0);
  await expect(page.getByRole('status')).toContainText('连接中断');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('#note-editor p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('代理恢复后保留');
  await page.unroute('**/api/session');
  await expect(page.getByRole('status')).toHaveText('已保存', { timeout: 20000 });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor')).toContainText('代理恢复后保留');
});

test('plain text download errors remain recoverable without stopping the editor', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('status')).toHaveText('已保存');
  await page.route('**/api/workspace/export', route => route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }));
  await page.getByRole('button', { name: '打包导出工作区' }).click();
  await expect(page.getByRole('alert')).toContainText('502');
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor').getByRole('textbox').first()).toHaveAttribute('contenteditable', 'true');
  await page.unroute('**/api/workspace/export');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '打包导出工作区' }).click();
  expect((await download).suggestedFilename()).toBe('workspace.zip');
});

for (const trigger of ['reconnect', 'file-list']) test(`session expiry from ${trigger} keeps unconfirmed edits through password retry and reauthentication`, async ({ page }) => {
  let holdUpdates = false;
  let disconnect: (() => void) | undefined;
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer();
    socket.onMessage(data => { if (!holdUpdates) server.send(data); });
    disconnect = () => { socket.close({ code: 1012 }); server.close({ code: 1012 }); };
  });
  await login(page);
  await expect(page.getByRole('status')).toHaveText('已保存');
  holdUpdates = true;
  await page.locator('#note-editor p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('过期会话未确认的改动😀');
  await page.keyboard.press('Control+s');
  await page.context().clearCookies();
  if (trigger === 'reconnect') disconnect?.();
  else await page.getByRole('button', { name: '刷新文件列表', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重新登录', exact: true });
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#note-editor')).toContainText('过期会话未确认的改动😀');
  await dialog.getByLabel('服务密码').fill('wrong-password');
  await dialog.getByRole('button', { name: '重新登录', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('密码错误');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#note-editor').getByRole('textbox').first()).toHaveAttribute('contenteditable', 'true');
  await page.locator('#note-editor p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('取消后继续写');
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('服务密码').fill('p1-test-password');
  holdUpdates = false;
  await dialog.getByRole('button', { name: '重新登录', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存');
  await expect(page.locator('#note-editor')).toContainText('过期会话未确认的改动😀取消后继续写');
});

test('blank paragraphs survive synchronization and remote edits retain the local caret', async ({ page, browser }) => {
  await login(page, '/note/'); await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  const filename = '空行光标协作.md', origin = new URL(page.url()).origin;
  expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown: '# 测试\n\n第一段\n\n\n\n中间光标\n\n末段\n' } })).status()).toBe(201);
  await page.goto('/note/' + encodeURIComponent(filename)); await expect(page.getByRole('status')).toHaveText('已保存');
  const context = await browser.newContext({ locale: 'zh-CN' }); const peer = await context.newPage();
  try {
    await login(peer, origin + '/note/' + encodeURIComponent(filename)); await expect(peer.getByRole('status')).toHaveText('已保存');
    await expect(peer.locator('#note-editor p').filter({ hasText: /^$/ })).toHaveCount(1);
    await peer.locator('#note-editor p').filter({ hasText: '中间光标' }).click(); await peer.keyboard.press('End');
    await page.locator('#note-editor p').filter({ hasText: '第一段' }).click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.insertText('新增段');
    await expect(peer.locator('#note-editor p').filter({ hasText: /^$/ })).toHaveCount(2);
    await page.locator('#note-editor p').filter({ hasText: '第一段' }).click(); await page.keyboard.press('Home'); await page.keyboard.insertText('远端新增');
    await expect(peer.locator('#note-editor')).toContainText('远端新增');
    await peer.keyboard.insertText('光标留在这里'); await expect(peer.getByRole('status')).toHaveText('已保存');
    await expect(peer.locator('#note-editor p').filter({ hasText: '中间光标' })).toHaveText('中间光标光标留在这里');
    await expect(peer.locator('#note-editor p').filter({ hasText: /^$/ })).toHaveCount(2);
  } finally { await context.close(); }
});

test('remote changes retain a long-document selection and scroll position', async ({ page, browser }) => {
  await login(page, '/note/'); await expect(page.getByRole('heading', { name: '你的团队笔记' })).toBeVisible();
  const filename = '长文选区.md', origin = new URL(page.url()).origin;
  const markdown = '# 长文\n\n起始段\n\n' + '滚动内容。\n\n'.repeat(80) + '保留目标选区位置\n\n末尾段\n';
  expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown } })).status()).toBe(201);
  const path = '/note/' + encodeURIComponent(filename);
  await page.goto(path); await expect(page.getByRole('status')).toHaveText('已保存');
  const context = await browser.newContext({ locale: 'zh-CN' }); const peer = await context.newPage();
  try {
    await login(peer, origin + path); await expect(peer.getByRole('status')).toHaveText('已保存');
    const target = peer.locator('#note-editor p').filter({ hasText: '保留目标选区位置' });
    await target.click();
    await target.evaluate(paragraph => {
      const text = paragraph.firstChild;
      if (!(text instanceof Text)) throw new Error('Expected a text node for the test selection');
      getSelection()?.setBaseAndExtent(text, 2, text, 6);
    });
    expect(await peer.evaluate(() => getSelection()?.toString())).toBe('目标选区');
    const before = await peer.locator('main.workspace').evaluate(element => element.scrollTop);
    expect(before).toBeGreaterThan(1000);
    await page.locator('#note-editor p').filter({ hasText: '起始段' }).click();
    await page.keyboard.press('Home'); await page.keyboard.insertText('远端开头变化');
    await expect(peer.locator('#note-editor')).toContainText('远端开头变化');
    expect(await peer.evaluate(() => getSelection()?.toString())).toBe('目标选区');
    expect(Math.abs(await peer.locator('main.workspace').evaluate(element => element.scrollTop) - before)).toBeLessThan(100);
    await peer.keyboard.insertText('替换成功');
    await expect(peer.locator('#note-editor p').filter({ hasText: '保留替换成功位置' })).toHaveText('保留替换成功位置');
    await expect(peer.getByRole('status')).toHaveText('已保存');
  } finally { await context.close(); }
});

test('clicking an online member reveals their caret without moving the local selection', async ({ page, browser }) => {
  await login(page, '/note/');
  const filename = '成员位置跳转.md', origin = new URL(page.url()).origin;
  const markdown = '# 成员位置\n\n本地编辑段\n\n' + '较长的正文。\n\n'.repeat(80) + '## 远端章节\n\n远端编辑目标\n';
  expect((await page.request.post('/api/notes', { headers: { Origin: origin }, data: { filename, markdown } })).status()).toBe(201);
  const path = '/note/' + encodeURIComponent(filename);
  await page.goto(path); await expect(page.getByRole('status')).toHaveText('已保存');
  const context = await browser.newContext({ locale: 'zh-CN' });
  const peer = await context.newPage();
  try {
    await login(peer, origin + path); await expect(peer.getByRole('status')).toHaveText('已保存');
    await peer.getByRole('button', { name: '修改用户名' }).click();
    const name = peer.getByRole('textbox', { name: '用户名', exact: true });
    await name.fill('远端成员'); await name.press('Enter');
    const member = page.getByLabel('在线成员').getByRole('button', { name: '远端成员' });
    await expect(member).toBeDisabled();
    const target = page.locator('.markdown-visual p').filter({ hasText: '远端编辑目标' });
    await peer.locator('#note-editor p').filter({ hasText: '远端编辑目标' }).click();
    await peer.keyboard.press('End');
    await expect(member).toBeEnabled();
    await page.locator('#note-editor p').first().click(); await page.keyboard.press('End');
    await expect(target).not.toBeInViewport();
    await member.click();
    await expect(target).toBeInViewport();
    expect(await page.evaluate(() => getSelection()?.anchorNode?.textContent)).toBe('本地编辑段');

    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.locator('main.workspace').evaluate(pane => { pane.scrollTop = 0; });
    await member.click(); await expect(target).toBeInViewport();

    await page.getByRole('button', { name: '源码', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Markdown 源码' });
    const sourceTarget = source.getByText('远端编辑目标', { exact: true });
    await page.locator('main.workspace').evaluate(pane => { pane.scrollTop = 0; });
    await member.click(); await expect(sourceTarget).toBeInViewport();

    await page.getByRole('button', { name: '分屏预览' }).click();
    const sourcePane = page.getByRole('region', { name: '源码编辑区' });
    await sourcePane.evaluate(pane => { pane.scrollTop = 0; });
    await member.click();
    await expect(sourceTarget).toBeInViewport();
    await expect(target).toBeInViewport();
    await context.close();
    await expect(member).toHaveCount(0);
  } finally { await context.close(); }
});
