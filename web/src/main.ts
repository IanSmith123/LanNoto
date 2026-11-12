import { t } from './i18n';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './app.css';
import { APIError, fileEntries, request } from './api';
import { FileTree } from './file-tree';
import { labelIcon } from './icons';
import { Connection } from './sync';
import type { EditingMode } from './markdown-editor';
import { UploadController } from './upload';
import { ExportController } from './export';
import { DocumentOutline } from './outline';
import { sidebarResize } from './sidebar-resize';
import { HistoryController } from './history';
import { download } from './download';
import { username, rename, dark, toggleTheme, language, remember } from './preferences';

function applicationRoot(): HTMLDivElement {
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLDivElement)) throw new Error('Missing application root');
  return root;
}
const app = applicationRoot();
const appName = 'LanNoto';
let connection: Connection | undefined;
let generation = 0;
let exportsController: ExportController | undefined;
let outline: DocumentOutline | undefined;
let historyController: HistoryController | undefined;
let saving: Promise<unknown> | undefined;
window.addEventListener('beforeunload', event => { if (connection?.hasUnsaved() || saving) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (!connection || saving) return;
  saving = connection.checkpoint(username).catch(showError).finally(() => { saving = undefined; });
}, { capture: true });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function action(label: string, handler: () => Promise<void> | void): HTMLButtonElement {
  const button = element('button', label);
  button.addEventListener('click', () => { void Promise.resolve().then(handler).catch(showError); });
  return button;
}
function showError(error: unknown): void {
  if (error instanceof APIError) {
    if (error.status === 401) { if (connection) connection.authenticationExpired(); else void loginPage().catch(fatal); return; }
    banner(error.message); return;
  }
  fatal(error);
}
function banner(message: string): void {
  let node = document.getElementById('operation-error');
  if (!node) { node = element('p', '', 'error'); node.id = 'operation-error'; node.setAttribute('role', 'alert'); app.prepend(node); }
  node.textContent = message;
}
function fatal(error: unknown): void {
  connection?.abort(t('不可恢复内部错误，编辑已停止'));
  banner(`${t('不可恢复内部错误')}：${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
}
window.addEventListener('error', (event) => fatal(event.error));
window.addEventListener('unhandledrejection', (event) => fatal(event.reason));

function reauthenticate(): void {
  if (document.getElementById('reauthentication')) return;
  const active = connection;
  if (!active) { void loginPage().catch(fatal); return; }
  const dialog = element('dialog', '', 'upload-source'); dialog.id = 'reauthentication';
  dialog.setAttribute('aria-label', t('重新登录'));
  const form = element('form');
  const label = element('label', t('服务密码'));
  const input = element('input'); input.type = 'password'; input.autocomplete = 'current-password'; input.required = true; label.append(input);
  const submit = element('button', t('重新登录')); submit.type = 'submit';
  const cancel = element('button', t('取消')); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
  const error = element('p', '', 'error'); error.setAttribute('role', 'alert');
  form.append(label, submit, cancel, error);
  dialog.append(element('h2', t('重新登录')), element('p', t('当前文稿和未同步改动保留在本页，登录后自动同步。')), form);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault(); submit.disabled = true; error.textContent = '';
    void request('/api/session', 'POST', { password: input.value }).then(() => {
      dialog.close();
      if (connection === active) active.reconnect();
    }).catch((reason: unknown) => {
      if (reason instanceof APIError) error.textContent = reason.message;
      else if (reason instanceof TypeError) error.textContent = t('连接中断，请恢复连接后重试');
      else fatal(reason);
    }).finally(() => { submit.disabled = false; });
  });
  document.body.append(dialog); dialog.showModal(); input.focus();
}

async function loginPage(): Promise<void> {
  generation++;
  historyController?.destroy(); historyController = undefined;
  outline?.destroy(); outline = undefined;
  if (exportsController) { await exportsController.destroy(); exportsController = undefined; }
  if (connection) { const previous = connection; connection = undefined; await previous.destroy(); }
  document.title = appName;
  app.replaceChildren();
  const main = element('main', '', 'login');
  main.append(element('strong', appName, 'brand'), element('h1', t('一起写下想法')), element('p', t('输入主机提供的共享密码，进入团队笔记。')));
  const form = element('form');
  const label = element('label', t('服务密码'));
  const input = element('input'); input.type = 'password'; input.autocomplete = 'current-password'; input.required = true; label.append(input);
  const submit = element('button', t('进入工作区')); submit.type = 'submit';
  const error = element('p', '', 'error'); error.setAttribute('role', 'alert');
  form.append(label, submit, error); main.append(form); app.append(main);
  form.addEventListener('submit', (event) => {
    event.preventDefault(); submit.disabled = true; error.textContent = '';
    void request('/api/session', 'POST', { password: input.value }).then(workspacePage).catch((reason: unknown) => {
      if (reason instanceof APIError) error.textContent = reason.message; else fatal(reason);
    }).finally(() => { submit.disabled = false; });
  });
  input.focus();
}

async function workspacePage(): Promise<void> {
  const current = ++generation;
  historyController?.destroy(); historyController = undefined;
  outline?.destroy(); outline = undefined;
  if (exportsController) { await exportsController.destroy(); exportsController = undefined; }
  if (connection) { const previous = connection; connection = undefined; await previous.destroy(); }
  const entries = await fileEntries();
  if (current !== generation) return;
  app.replaceChildren();
  const sidebar = element('aside');
  const masthead = element('div', '', 'sidebar-masthead'); sidebar.append(masthead);
  const sidebarTop = element('div', '', 'sidebar-top'); sidebar.append(sidebarTop);
  sidebarTop.id = 'sidebar-content';
  const path = location.pathname;
  const noteName = path === '/note/' || path === '/' ? '' : decodeURIComponent(path.slice('/note/'.length));
  const logo = element('a', appName, 'brand'); logo.href = '/note/';
  const signOut = action('', async () => { await request('/api/session', 'DELETE'); await loginPage(); });
  signOut.className = 'sidebar-icon sidebar-sign-out';
  labelIcon(signOut, t('退出登录'), 'M10 4H5v16h5 M10 12h11 m-4-4 4 4-4 4');
  const setCollapsed = (collapsed: boolean) => {
    sidebar.toggleAttribute('data-collapsed', collapsed);
    collapse.setAttribute('aria-expanded', String(!collapsed));
    labelIcon(collapse, t(collapsed ? '展开侧栏' : '折叠侧栏'), collapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6');
  };
  const collapse = action('', () => setCollapsed(!sidebar.hasAttribute('data-collapsed')));
  collapse.className = 'sidebar-icon sidebar-collapse';
  collapse.setAttribute('aria-controls', 'sidebar-content');
  setCollapsed(false);
  masthead.append(collapse, logo, signOut);
  const files = element('section', '', 'workspace-files'); files.setAttribute('aria-label', t('工作区与文件')); sidebarTop.append(files);
  const identity = element('div', '', 'identity-controls');
  const nameButton = action(username, () => {
    const input = element('input'); input.value = username; input.maxLength = 30; input.setAttribute('aria-label', t('用户名'));
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return; finished = true;
      if (save) { rename(input.value); connection?.rename(username); }
      nameButton.textContent = nameButton.title = username; input.replaceWith(nameButton);
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Enter'); nameButton.focus(); } });
    nameButton.replaceWith(input); input.focus(); input.select();
  });
  nameButton.setAttribute('aria-label', t('修改用户名')); nameButton.className = 'username'; nameButton.title = username;
  const theme = action(dark ? '☀' : '☾', () => { toggleTheme(); theme.textContent = dark ? '☀' : '☾'; theme.setAttribute('aria-pressed', String(dark)); });
  theme.setAttribute('aria-label', t('切换夜间模式')); theme.setAttribute('aria-pressed', String(dark));
  const languages = element('select'); languages.setAttribute('aria-label', language === 'zh-CN' ? '语言' : 'Language');
  for (const [value, text] of [['zh-CN', '中文'], ['en', 'English']]) { const option = element('option', text); option.value = value; languages.append(option); }
  languages.value = language;
  languages.addEventListener('change', () => {
    languages.disabled = true;
    void (async () => {
      if (saving) await saving;
      if (connection) await connection.readyRevision(new AbortController().signal);
      remember('lannoto-language', languages.value); location.reload();
    })().catch(showError).finally(() => { languages.disabled = false; languages.value = language; });
  });
  identity.append(nameButton, theme, languages); files.append(identity);
  const tree = new FileTree(entries, noteName, async from => {
    const active = connection;
    if (!active || noteName !== from && !noteName.startsWith(from + '/')) return 0;
    try { await active.readyRevision(AbortSignal.timeout(10000)); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new APIError(409, 'relocation_unsaved', t('当前笔记尚未同步，请保存后重试'));
      throw error;
    }
    return active.editor.doc.clientID;
  }, showError);
  const filesHeading = element('div', '', 'sidebar-section-heading');
  tree.bindRootDropTarget(filesHeading);
  const refreshFiles = async () => {
    try { await tree.refresh(); }
    catch (error) { if (error instanceof TypeError) throw new APIError(0, 'network', t('连接中断，请恢复连接后重试')); throw error; }
  };
  const refresh = action(t('刷新'), async () => {
    refresh.disabled = true;
    try { await refreshFiles(); }
    finally { refresh.disabled = false; }
  });
  refresh.className = 'sidebar-icon';
  labelIcon(refresh, t('刷新文件列表'), 'M20 7v5h-5 M20 12a8 8 0 1 0-2 5');
  const archive = action(t('工作区 ZIP'), async () => {
    archive.disabled = true;
    try { if (connection) await connection.readyRevision(new AbortController().signal); await download(await fetch('/api/workspace/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 'workspace.zip'); }
    catch (error) { if (error instanceof TypeError) throw new APIError(0, 'network', t('连接中断，请恢复连接后重试')); throw error; }
    finally { archive.disabled = false; }
  });
  archive.className = 'sidebar-icon workspace-archive';
  labelIcon(archive, t('打包导出工作区'), 'M4 3h16v5H4z M5 8v13h14V8 M12 11v6 m-3-3 3 3 3-3');
  filesHeading.append(element('h2', t('笔记文件')));
  tree.toolbar.append(archive, refresh);
  files.append(filesHeading, tree.toolbar, tree.root);
  const main = element('main', '', 'workspace');
  app.append(sidebar, main);
  if (!noteName) {
    document.title = appName;
    main.append(element('h1', t('你的团队笔记')), element('p', entries.some(entry => !entry.folder) ? t('从左侧选择一个文件，开始共同编辑。') : t('此工作区还没有笔记。按文件名创建，或将 Markdown 放入 note 文件夹。'), 'muted'));
    return;
  }
  document.title = noteName.slice(noteName.lastIndexOf('/') + 1);
  main.setAttribute('aria-label', noteName);
  const header = element('header', '', 'note-tools');
  const toolbar = element('div', '', 'toolbar');
  const status = element('span', t('正在连接'), 'save-status'); status.setAttribute('role', 'status');
  masthead.insertBefore(status, signOut);
  const members = element('span', '', 'members'); members.setAttribute('aria-label', t('在线成员'));
  nameButton.after(members);
  const memberCount = element('span');
  const memberList = element('span', '', 'member-list');
  const memberControls = new Map<number, HTMLButtonElement>();
  members.append(memberCount, memberList);
  let mode: EditingMode = 'rich';
  const setMode = (next: EditingMode) => {
    mode = next; connection?.setMode(mode);
    toggle.textContent = t(mode === 'preview' ? '编辑' : '预览');
    sourceToggle.textContent = t(mode === 'source' ? '所见即所得' : '源码');
    splitToggle.setAttribute('aria-pressed', String(mode === 'split'));
  };
  const sourceToggle = action(t('源码'), () => setMode(mode === 'source' ? 'rich' : 'source'));
  const toggle = action(t('预览'), () => setMode(mode === 'preview' ? 'rich' : 'preview'));
  const splitToggle = action(t('分屏预览'), () => setMode(mode === 'split' ? 'source' : 'split'));
  splitToggle.setAttribute('aria-pressed', 'false');
  const reconnect = action(t('重新连接'), () => connection?.reconnect()); reconnect.hidden = true;
  const modes = element('div', '', 'editor-modes');
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', t('编辑模式'));
  modes.append(toggle, sourceToggle, splitToggle);
  toolbar.append(modes, reconnect); header.append(toolbar);
  const editorRoot = element('div', '', 'editor-surface'); editorRoot.id = 'note-editor';
  let activeConnection: Connection;
  const uploads = new UploadController(noteName, () => activeConnection?.canEdit() ?? false, (markdown) => activeConnection.insertMarkdown(markdown), showError, () => { void refreshFiles().catch(showError); });
  uploads.attach(editorRoot);
  toolbar.append(uploads.button, uploads.input);
  filesHeading.append(uploads.status);
  sidebarTop.append(header); main.append(editorRoot);
  outline = new DocumentOutline(editorRoot, heading => connection?.editor.scrollToHeading(heading)); outline.root.id = 'sidebar-outline';
  sidebar.append(sidebarResize(sidebarTop, tree.root, outline.root), outline.root);
  collapse.setAttribute('aria-controls', 'sidebar-content sidebar-outline');
  const colors = ['#2563eb', '#a855f7', '#059669', '#dc2626', '#d97706'];
  const color = colors[crypto.getRandomValues(new Uint8Array(1))[0] % colors.length];
  activeConnection = new Connection(noteName, editorRoot, { name: username, color }, (state) => {
    if (status.textContent !== state.status) status.textContent = state.status;
    status.title = state.status;
    status.dataset.revision = String(state.revision); status.dataset.savedRevision = String(state.savedRevision);
    status.classList.toggle('error', state.terminal);
    reconnect.hidden = !state.manualReconnect;
  }, (online) => {
    const count = language === 'zh-CN' ? `${online.length} 人在线` : `${online.length} online`;
    if (memberCount.textContent !== count) memberCount.textContent = count;
    const peers = online.filter(member => !member.self);
    const ids = new Set(peers.map(member => member.id));
    for (const [id, control] of memberControls) {
      if (ids.has(id)) continue;
      control.remove();
      memberControls.delete(id);
    }
    for (const member of peers) {
      let control = memberControls.get(member.id);
      if (!control) {
        control = action(member.name, () => activeConnection.editor.scrollToPeer(member.id));
        control.type = 'button';
        control.addEventListener('mousedown', event => {
          if (event.button === 0) event.preventDefault();
        });
        memberControls.set(member.id, control);
        memberList.append(control);
      }
      if (control.textContent !== member.name) control.textContent = member.name;
      control.disabled = !member.hasCursor;
      control.title = t(member.hasCursor ? '跳转到编辑位置' : '暂时没有可跳转的编辑位置');
    }
  }, reauthenticate, fatal, uploads.image);
  connection = activeConnection;
  historyController = new HistoryController(activeConnection, showError); toolbar.append(historyController.button);
  exportsController = new ExportController(activeConnection, showError); toolbar.append(exportsController.root);
  await activeConnection.connect();
}

async function start(): Promise<void> {
  try { await request('/api/session'); await workspacePage(); }
  catch (error) { if (error instanceof APIError && error.status === 401) await loginPage(); else throw error; }
}
void start().catch(fatal);
