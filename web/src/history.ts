import { diffLines } from 'diff';
import { APIError, noteAPI, request } from './api';
import { checked } from './download';
import { t } from './i18n';
import { language, username } from './preferences';
import type { Connection } from './sync';

interface Version { id: string; filename: string; createdAt: string; revision: number; reason: string; author: string; bytes: number; hash: string }
interface Entry extends Version { markdown: string }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function version(value: unknown): Version {
  if (!object(value) || typeof value.id !== 'string' || typeof value.filename !== 'string' || typeof value.createdAt !== 'string' || typeof value.revision !== 'number' || typeof value.reason !== 'string' || typeof value.author !== 'string' || typeof value.bytes !== 'number' || typeof value.hash !== 'string') throw new Error('Invalid history metadata');
  return { id: value.id, filename: value.filename, createdAt: value.createdAt, revision: value.revision, reason: value.reason, author: value.author, bytes: value.bytes, hash: value.hash };
}
const reasons: Record<string, string> = { initial: '初始记录', manual: '手动保存', interval: '定时记录', block: '大区块变更', 'restore-before': '恢复前记录', restore: '恢复版本' };
function label(item: Version): string { return `#${item.id.split('-')[0].replace(/^0+/, '') || '0'} · ${new Date(item.createdAt).toLocaleString(language)} · ${t(reasons[item.reason] || item.reason)}${item.author ? ` · ${item.author}` : ''}`; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] { const element = document.createElement(tag); element.textContent = text; return element; }

function renderDiff(container: Element, current: string, historical: string): void {
  if (current === historical) {
    container.textContent = t('此版本与当前正文相同');
    return;
  }
  const changes = document.createDocumentFragment();
  for (const change of diffLines(current, historical)) {
    const prefix = change.added ? '+ ' : change.removed ? '− ' : '  ';
    const endsWithNewline = change.value.endsWith('\n');
    const lines = endsWithNewline ? change.value.slice(0, -1) : change.value;
    const chunk = node('span', lines.split('\n').map(line => prefix + line).join('\n'));
    chunk.className = change.added ? 'diff-added' : change.removed ? 'diff-removed' : '';
    if (!endsWithNewline && (change.added || change.removed)) {
      const marker = node('span', '\n\\ ' + t('文件末尾无换行'));
      marker.className = 'diff-note';
      chunk.append(marker);
    }
    changes.append(chunk);
  }
  container.replaceChildren(changes);
}

export class HistoryController {
  readonly button = node('button', t('历史记录'));
  private dialog?: HTMLDialogElement;
  private list?: HTMLElement;
  private detail?: HTMLElement;
  private next = '';
  private selected?: Entry;
  private comparedRevision = 0;
  private generation = 0;
  private loading = false;
  private restoring = false;
  private unobserve?: () => void;
  private comparedMarkdown = '';
  private readonly changed = () => this.compare();
  private readonly report = (error: unknown) => {
    const reason = error instanceof TypeError ? new APIError(0, 'network', t('连接中断，请恢复连接后重试')) : error;
    if (reason instanceof APIError && this.detail) { const message = node('p', reason.message); message.className = 'error'; message.setAttribute('role', 'alert'); this.detail.prepend(message); }
    this.error(reason);
  };
  private readonly recorded = () => { if (this.dialog?.open) void this.load().catch(this.report); };

  constructor(private readonly connection: Connection, private readonly error: (error: unknown) => void) {
    this.button.type = 'button'; this.button.addEventListener('click', () => { void this.open().catch(this.report); });
    window.addEventListener('lannoto-history-recorded', this.recorded);
  }
  private async open(): Promise<void> {
    if (this.dialog) return;
    const dialog = node('dialog'); dialog.className = 'history-dialog'; dialog.setAttribute('aria-label', t('历史记录'));
    const header = node('header'), close = node('button', t('关闭历史记录')), refresh = node('button', t('刷新历史记录'));
    close.addEventListener('click', () => dialog.close()); refresh.addEventListener('click', () => { void this.load().catch(this.report); });
    header.append(node('h2', `${t('历史记录')} · ${this.connection.filename}`), refresh, close);
    const body = node('div'); body.className = 'history-body';
    this.list = node('nav'); this.list.setAttribute('aria-label', t('历史版本')); this.detail = node('section'); this.detail.setAttribute('aria-label', t('版本比较'));
    body.append(this.list, this.detail); dialog.append(header, node('p', t('Ctrl+S 立即留档；大区块变更停止编辑后留档；其他变更每 60 秒留档。正文相同不会重复记录。')), body); document.body.append(dialog); this.dialog = dialog;
    dialog.addEventListener('close', () => { this.connection.editor.doc.off('update', this.changed); this.unobserve?.(); this.generation++; this.selected = undefined; this.dialog = undefined; this.list = undefined; this.detail = undefined; dialog.remove(); }, { once: true });
    this.connection.editor.doc.on('update', this.changed); this.unobserve = this.connection.observe(this.changed); dialog.showModal();
    await this.load();
  }
  private async load(more = false): Promise<void> {
    if (!this.dialog || this.loading) return;
    this.loading = true;
    try {
      const response = await request(`${noteAPI(this.connection.filename)}/history${more && this.next ? `?before=${encodeURIComponent(this.next)}` : ''}`);
      if (!object(response) || !Array.isArray(response.items) || typeof response.next !== 'string') throw new Error('Invalid history list');
      const items = response.items.map(version); if (!this.list) return;
      if (!more) this.list.replaceChildren(); else this.list.querySelector('.history-more')?.remove();
      this.next = response.next;
      for (const item of items) {
        const button = node('button', label(item)); button.dataset.historyId = item.id;
        button.setAttribute('aria-current', String(this.selected?.id === item.id));
        button.addEventListener('click', () => { void this.select(item.id).catch(this.report); }); this.list.append(button);
      }
      if (this.next) { const next = node('button', t('加载更早记录')); next.className = 'history-more'; next.addEventListener('click', () => { void this.load(true).catch(this.report); }); this.list.append(next); }
      if (!this.selected && items.length) await this.select(items[0].id);
    } finally { this.loading = false; }
  }
  private async select(id: string): Promise<void> {
    const generation = ++this.generation;
    const value = await request(`${noteAPI(this.connection.filename)}/history/${encodeURIComponent(id)}`);
    if (!object(value) || typeof value.markdown !== 'string') throw new Error('Invalid history entry');
    const entry = { ...version(value), markdown: value.markdown };
    if (generation !== this.generation || !this.dialog) return;
    this.selected = entry; this.compare();
    for (const button of this.list?.querySelectorAll<HTMLButtonElement>('button[data-history-id]') || []) button.setAttribute('aria-current', String(button.dataset.historyId === id));
  }
  private compare(): void {
    if (!this.detail || !this.selected) return;
    const current = this.connection.editor.markdown(), entry = this.selected;
    this.comparedRevision = this.connection.revision;
    const existingRestore = this.detail.querySelector<HTMLButtonElement>('[data-history-restore]');
    if (this.detail.dataset.historyId === entry.id && existingRestore) {
      existingRestore.disabled = current === entry.markdown || this.restoring;
      if (this.comparedMarkdown === current) return;
      const diff = this.detail.querySelector('.history-diff');
      if (diff) renderDiff(diff, current, entry.markdown);
      this.comparedMarkdown = current; return;
    }
    this.detail.dataset.historyId = entry.id; this.comparedMarkdown = current;
    const description = node('p', label(entry));
    const diff = node('pre'); diff.className = 'history-diff'; diff.setAttribute('aria-label', t('相对当前正文的变化'));
    renderDiff(diff, current, entry.markdown);
    const restore = node('button', t('恢复此版本')); restore.disabled = current === entry.markdown || this.restoring;
    restore.dataset.historyRestore = '';
    restore.addEventListener('click', () => {
      const expected = this.comparedRevision; restore.disabled = true; this.restoring = true;
      void (async () => {
        const revision = await this.connection.readyRevision(new AbortController().signal);
        if (revision !== expected) throw new APIError(409, 'revision_conflict', t('正文已变化，请检查最新比较后重试'));
        await checked(await fetch(`${noteAPI(this.connection.filename)}/history/${encodeURIComponent(entry.id)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, author: username }) }));
        this.restoring = false; this.dialog?.close();
      })().catch(error => { this.restoring = false; this.compare(); this.report(error); });
    });
    this.detail.replaceChildren(description, node('p', t('恢复此版本时，+ 表示加入，− 表示移除。当前正文会自动留档，恢复结果会同步给在线成员。')), restore, node('h3', t('版本比较')), diff);
  }
  destroy(): void { this.dialog?.close(); window.removeEventListener('lannoto-history-recorded', this.recorded); }
}
