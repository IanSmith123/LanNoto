import { APIError, fileEntries, request } from './api';
import type { TreeEntry } from './api';
import { labelIcon } from './icons';
import { t } from './i18n';

const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const within = (path: string, folder: string) => path === folder || path.startsWith(folder + '/');
const inStatic = (path: string) => within(path, 'static');
const noteURL = (path: string) => '/note/' + encodeURIComponent(path);

function iconButton(label: string, path: string, click: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sidebar-icon';
  labelIcon(button, label, path);
  button.addEventListener('click', click);
  return button;
}

export class FileTree {
  readonly toolbar = document.createElement('div');
  readonly root = document.createElement('nav');
  private entries: TreeEntry[] = [];
  private selected: string;
  private readonly expanded = new Set<string>();
  private readonly folders = new Map<string, HTMLButtonElement>();
  private readonly renameButton: HTMLButtonElement;
  private dragged?: TreeEntry;
  private dropTarget?: HTMLElement;
  private refreshId = 0;

  constructor(
    entries: TreeEntry[],
    private readonly active: string,
    private readonly prepareRelocation: (path: string) => Promise<number>,
    private readonly error: (error: unknown) => void,
  ) {
    this.selected = active;
    this.expandParents(active);
    this.toolbar.className = 'file-toolbar';
    this.toolbar.setAttribute('role', 'group');
    this.toolbar.setAttribute('aria-label', t('文件操作'));
    this.root.className = 'file-tree';
    this.root.setAttribute('aria-label', t('笔记文件'));
    this.renameButton = iconButton(t('重命名'), 'm4 16 12-12 4 4L8 20H4v-4z M14 6l4 4', () => this.openForm('rename'));
    this.toolbar.append(
      iconButton(t('新建文件'), 'M5 3h9l5 5v13H5z M14 3v5h5 M9 14h6 M12 11v6', () => this.openForm('file')),
      iconButton(t('新建文件夹'), 'M3 6h7l2 2h9v12H3z M9 14h6 M12 11v6', () => this.openForm('folder')),
      this.renameButton,
    );
    this.render(entries);
  }

  async refresh(): Promise<void> {
    const id = ++this.refreshId;
    const entries = await fileEntries();
    if (id === this.refreshId) this.render(entries);
  }

  private async openAsset(path: string): Promise<void> {
    const filename = leaf(path);
    const url = '/note/' + path.split('/').map(encodeURIComponent).join('/');
    const previewURL = url + '?preview=1';
    const response = await fetch(previewURL, { method: 'HEAD' }).catch(error => {
      if (error instanceof TypeError) throw new APIError(0, 'network', '连接中断，请恢复连接后重试');
      throw error;
    });
    if (!response.ok) throw new APIError(response.status, 'asset_unavailable', '无法打开文件');
    const contentType = response.headers.get('Content-Type') ?? '';
    const preview = response.headers.get('Content-Disposition')?.startsWith('inline') &&
      (contentType !== 'application/pdf' || navigator.pdfViewerEnabled);

    const dialog = document.createElement('dialog');
    dialog.className = preview ? 'file-dialog asset-preview' : 'file-dialog';
    const title = document.createElement('h2');
    title.textContent = preview ? filename : t('是否下载此文件？');
    dialog.setAttribute('aria-label', title.textContent);
    dialog.append(title);
    if (preview && contentType.startsWith('image/')) {
      const stage = document.createElement('div');
      stage.className = 'asset-image-stage';
      const image = document.createElement('img');
      image.alt = filename;
      image.src = previewURL;
      stage.append(image);
      stage.addEventListener('click', event => { if (event.target === stage) dialog.close(); });
      dialog.append(stage);
    } else if (preview) {
      const frame = document.createElement('iframe');
      frame.title = filename;
      frame.src = previewURL;
      dialog.append(frame);
    } else {
      const name = document.createElement('p');
      name.textContent = filename;
      dialog.append(name);
    }
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = t('下载文件');
    download.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = url + '?download=1';
      link.download = filename;
      dialog.append(link);
      link.click();
      link.remove();
      if (!preview) dialog.close();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = t(preview ? '关闭' : '取消');
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.append(download, close);
    this.toolbar.append(dialog);
    dialog.showModal();
  }

  bindRootDropTarget(heading: HTMLElement): void {
    heading.title = t('移动到根目录');
    this.bindDropTarget(heading, '');
  }

  private clearDrag(): void {
    this.dragged = undefined;
    this.root.removeAttribute('data-dragging');
    this.dropTarget?.classList.remove('file-drop-active');
    this.dropTarget = undefined;
  }

  private bindDrag(source: HTMLElement, entry: TreeEntry): void {
    source.draggable = true;
    source.addEventListener('dragstart', event => {
      if (!event.dataTransfer) return;
      this.dragged = entry;
      this.root.setAttribute('data-dragging', '');
      event.dataTransfer.clearData();
      event.dataTransfer.setData('application/x-lannoto-entry', entry.path);
      event.dataTransfer.effectAllowed = 'move';
    });
    source.addEventListener('dragend', () => this.clearDrag());
  }

  private bindDropTarget(target: HTMLElement, directory: string): void {
    const canDrop = (event: DragEvent) => {
      const entry = this.dragged;
      if (!entry || !event.dataTransfer?.types.includes('application/x-lannoto-entry') ||
          directory === parent(entry.path) || within(directory, entry.path)) return false;
      // Crossing static/ would change whether a Markdown file is editable.
      return (!entry.folder && !entry.path.endsWith('.md')) || inStatic(directory) === inStatic(entry.path);
    };
    target.addEventListener('dragover', event => {
      const data = event.dataTransfer;
      if (!data || !canDrop(event)) return;
      event.preventDefault();
      data.dropEffect = 'move';
      if (this.dropTarget !== target) this.dropTarget?.classList.remove('file-drop-active');
      target.classList.add('file-drop-active');
      this.dropTarget = target;
    });
    target.addEventListener('dragleave', event => {
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      target.classList.remove('file-drop-active');
      if (this.dropTarget === target) this.dropTarget = undefined;
    });
    target.addEventListener('drop', event => {
      const from = this.dragged?.path;
      if (!from || !canDrop(event) || event.dataTransfer?.getData('application/x-lannoto-entry') !== from) return;
      event.preventDefault();
      this.clearDrag();
      void this.move(from, directory).catch(this.error);
    });
  }

  private async move(from: string, directory: string): Promise<void> {
    const dialog = document.createElement('dialog');
    dialog.className = 'file-dialog';
    dialog.textContent = t('正在移动文件');
    dialog.setAttribute('aria-label', dialog.textContent);
    dialog.addEventListener('cancel', event => event.preventDefault());
    this.toolbar.append(dialog);
    dialog.showModal();
    try {
      if (!await this.relocate(from, 'move', { directory })) await this.refresh();
    } catch (error) {
      if (error instanceof TypeError) throw new APIError(0, 'network', t('连接中断，请恢复连接后重试'));
      throw error;
    } finally {
      dialog.remove();
    }
  }

  private async relocate(from: string, operation: 'rename' | 'move', destination: { name: string } | { directory: string }): Promise<boolean> {
    const clientId = await this.prepareRelocation(from);
    const result = await request('/api/workspace/' + operation, 'POST', { path: from, ...destination, clientId });
    if (typeof result !== 'object' || !result || !('path' in result) || typeof result.path !== 'string') throw new Error('Invalid relocation response');
    if (this.active && within(this.active, from) && from !== result.path) {
      location.replace(noteURL(result.path + this.active.slice(from.length)));
      return true;
    }
    this.selected = result.path;
    this.expandParents(result.path);
    for (const folder of [...this.expanded]) {
      if (!within(folder, from)) continue;
      this.expanded.delete(folder);
      this.expanded.add(result.path + folder.slice(from.length));
    }
    return false;
  }

  private expandParents(path: string): void {
    for (let directory = parent(path); directory; directory = parent(directory)) this.expanded.add(directory);
  }

  private select(path: string): void {
    this.selected = path;
    this.renameButton.disabled = !this.entries.some(entry => entry.path === path && (!entry.asset || entry.folder && path !== 'static'));
    for (const [folder, button] of this.folders) button.setAttribute('aria-pressed', String(folder === path));
  }

  private render(entries: TreeEntry[]): void {
    this.entries = entries;
    this.folders.clear();
    const children = new Map<string, TreeEntry[]>();
    for (const entry of entries) {
      const directory = parent(entry.path);
      const group = children.get(directory) ?? [];
      group.push(entry);
      children.set(directory, group);
    }
    const branch = (directory: string): HTMLElement => {
      const group = document.createElement('ul');
      const items = children.get(directory) ?? [];
      items.sort((a, b) => Number(b.folder) - Number(a.folder) || leaf(a.path).localeCompare(leaf(b.path)));
      for (const entry of items) {
        const item = document.createElement('li');
        if (entry.asset && !entry.folder) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'asset-file';
          button.textContent = leaf(entry.path);
          button.title = entry.path;
          button.addEventListener('click', () => {
            button.disabled = true;
            void this.openAsset(entry.path).catch(this.error).finally(() => { button.disabled = false; });
          });
          this.bindDrag(button, entry);
          item.append(button);
        } else if (!entry.folder) {
          const link = document.createElement('a');
          link.href = noteURL(entry.path);
          link.textContent = leaf(entry.path);
          link.title = entry.path;
          if (entry.path === this.active) link.setAttribute('aria-current', 'page');
          this.bindDrag(link, entry);
          item.append(link);
        } else {
          const row = document.createElement('div');
          row.className = 'file-folder';
          const nested = branch(entry.path);
          const toggle = iconButton('', '', () => setOpen(nested.hidden === true));
          const setOpen = (open: boolean) => {
            if (open) this.expanded.add(entry.path);
            else this.expanded.delete(entry.path);
            nested.hidden = !open;
            const label = t(open ? '折叠文件夹' : '展开文件夹') + ' ' + leaf(entry.path);
            labelIcon(toggle, label, open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6');
            toggle.setAttribute('aria-expanded', String(open));
          };
          const name = document.createElement('button');
          name.type = 'button';
          name.textContent = leaf(entry.path);
          name.title = entry.path;
          name.addEventListener('click', () => {
            this.select(entry.path);
            setOpen(true);
          });
          this.folders.set(entry.path, name);
          if (entry.path !== 'static') this.bindDrag(name, entry);
          this.bindDropTarget(row, entry.path);
          setOpen(this.expanded.has(entry.path));
          row.append(toggle, name);
          item.append(row, nested);
        }
        group.append(item);
      }
      return group;
    };
    this.root.replaceChildren(branch(''));
    this.select(entries.some(entry => entry.path === this.selected) ? this.selected : this.active);
  }

  private openForm(mode: 'file' | 'folder' | 'rename'): void {
    const selected = this.entries.find(entry => entry.path === this.selected);
    if (mode === 'rename' && !selected) return;
    const label = t(mode === 'rename' ? '重命名' : mode === 'folder' ? '新建文件夹' : '新建文件');
    const isFolder = mode === 'folder' || mode === 'rename' && selected?.folder;
    const dialog = document.createElement('dialog');
    dialog.className = 'file-dialog';
    dialog.setAttribute('aria-label', label);
    const form = document.createElement('form');
    const title = document.createElement('h2');
    title.textContent = label;
    const inputLabel = document.createElement('label');
    inputLabel.textContent = t(isFolder ? '文件夹名称' : '笔记文件名');
    const input = document.createElement('input');
    input.required = true;
    input.value = mode === 'rename' && selected ? leaf(selected.path) : '';
    inputLabel.append(input);
    form.append(title, inputLabel);
    const directory = document.createElement('select');
    if (mode !== 'rename') {
      const parentLabel = document.createElement('label');
      parentLabel.textContent = t('所在文件夹');
      directory.add(new Option(t('根目录'), ''));
      for (const entry of this.entries) {
        if (entry.folder && (mode === 'folder' || !entry.asset)) directory.add(new Option(entry.path, entry.path));
      }
      const initialDirectory = selected?.folder ? selected.path : parent(selected?.path ?? '');
      directory.value = mode === 'file' && inStatic(initialDirectory) ? '' : initialDirectory;
      parentLabel.append(directory);
      form.append(parentLabel);
    }
    const message = document.createElement('p');
    message.className = 'error';
    message.setAttribute('role', 'alert');
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t(mode === 'rename' ? '重命名' : '创建');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = t('取消');
    cancel.addEventListener('click', () => dialog.close());
    form.append(message, submit, cancel);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (submit.disabled) return;
      let name = input.value.trim();
      if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
        message.textContent = t('请输入有效的名称');
        return;
      }
      if (!isFolder && !name.endsWith('.md')) name = name.replace(/\.md$/i, '') + '.md';
      message.textContent = '';
      submit.disabled = cancel.disabled = true;
      void (async () => {
        if (mode === 'rename' && selected) {
          if (await this.relocate(selected.path, 'rename', { name })) return;
        } else {
          const path = directory.value ? directory.value + '/' + name : name;
          if (mode === 'file') {
            await request('/api/notes', 'POST', { filename: path, markdown: '' });
            location.href = noteURL(path);
            return;
          }
          await request('/api/workspace/folders', 'POST', { path });
          this.selected = path;
          this.expandParents(path);
          this.expanded.add(path);
        }
        dialog.close();
        await this.refresh();
      })().catch(error => {
        if (error instanceof APIError && error.status !== 401 && dialog.open) message.textContent = error.message;
        else if (error instanceof TypeError && dialog.open) message.textContent = t('连接中断，请恢复连接后重试');
        else {
          dialog.close();
          this.error(error);
        }
      }).finally(() => { submit.disabled = cancel.disabled = false; });
    });
    dialog.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.append(form);
    this.toolbar.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  }
}
