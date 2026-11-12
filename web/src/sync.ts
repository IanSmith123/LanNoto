import { t } from './i18n';
import * as Y from 'yjs';
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { NoteEditor, remoteOrigin } from './markdown-editor';
import type { EditingMode } from './markdown-editor';
import { encodeBase64, decodeBase64, fullUpdate } from './collab';
import { APIError, noteAPI, request } from './api';

type ServerMessage =
  | { type: 'bootstrap'; peerId: string; markdown: string; revision: number }
  | { type: 'waiting'; peerId: string }
  | { type: 'init'; peerId: string; data: string; awareness: string; revision: number; markdownRevision: number }
  | { type: 'update'; peerId: string; messageId: string; data: string; revision: number; restored: boolean }
  | { type: 'awareness'; data: string }
  | { type: 'saved'; revision: number; requestId: string }
  | { type: 'closing' }
  | { type: 'error'; code: string; message: string; revision: number; requestId: string };

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function text(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string') throw new Error(`Invalid server ${field}`);
  return value[field];
}
function revision(value: Record<string, unknown>, field = 'revision'): number {
  const number = value[field];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid server ${field}`);
  return number;
}
function parse(data: unknown): ServerMessage {
  if (typeof data !== 'string') throw new Error('Expected JSON text message');
  const value: unknown = JSON.parse(data);
  if (!record(value)) throw new Error('Expected server message object');
  switch (value.type) {
    case 'bootstrap': return { type: 'bootstrap', peerId: text(value, 'peerId'), markdown: text(value, 'markdown'), revision: revision(value) };
    case 'waiting': return { type: 'waiting', peerId: text(value, 'peerId') };
    case 'init': return { type: 'init', peerId: text(value, 'peerId'), data: text(value, 'data'), awareness: text(value, 'awareness'), revision: revision(value), markdownRevision: revision(value, 'markdownRevision') };
    case 'update': return { type: 'update', peerId: text(value, 'peerId'), messageId: text(value, 'messageId'), data: text(value, 'data'), revision: revision(value), restored: value.restored === true };
    case 'awareness': return { type: 'awareness', data: text(value, 'data') };
    case 'saved': return { type: 'saved', revision: revision(value), requestId: typeof value.requestId === 'string' ? value.requestId : '' };
    case 'closing': return { type: 'closing' };
    case 'error': return { type: 'error', code: text(value, 'code'), message: text(value, 'message'), revision: revision(value), requestId: typeof value.requestId === 'string' ? value.requestId : '' };
    default: throw new Error('Unknown server message type');
  }
}

export interface SyncState {
  status: string;
  revision: number;
  savedRevision: number;
  pending: number;
  connected: boolean;
  terminal: boolean;
  manualReconnect: boolean;
}

export class Connection {
  readonly editor: NoteEditor;
  private socket?: WebSocket;
  private incoming: Promise<void> = Promise.resolve();
  private mounted = false;
  private seeding = false;
  private seeded = false;
  private online = false;
  private initialized = false;
  private stopped = false;
  private closed = false;
  private closing = false;
  private preview = false;
  private recording = false;
  private recovering = true;
  private peerId = '';
  private applied = 0;
  private saved = 0;
  private pending = new Map<string, Uint8Array>();
  private sequence = 0;
  private readonly prefix = [...crypto.getRandomValues(new Uint8Array(12))].map((value) => value.toString(16).padStart(2, '0')).join('');
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private awaitingAuthentication = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushRequest?: string;
  private status = t('正在连接');
  private waiters = new Set<() => void>();
  private observers = new Set<() => void>();

  constructor(
    readonly filename: string,
    root: HTMLElement,
    private readonly user: { name: string; color: string },
    private readonly changed: (state: SyncState) => void,
    private readonly presenceChanged: (members: { id: number; name: string; self: boolean; hasCursor: boolean }[]) => void,
    private readonly authExpired: () => void,
    private readonly fatal: (error: unknown) => void,
    uploadImage?: (file: File) => Promise<string>,
  ) {
    this.editor = new NoteEditor(root, uploadImage);
    this.editor.awareness.setLocalStateField('user', user);
    this.editor.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === remoteOrigin || this.seeding || this.closed) return;
      const id = this.id();
      this.pending.set(id, update);
      if (this.online) this.send({ type: 'update', messageId: id, data: encodeBase64(update) });
      this.emit();
    });
    this.editor.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      if (this.closed) return;
      if (this.online && [...added, ...updated, ...removed].includes(this.editor.doc.clientID)) this.sendAwareness();
      this.presence();
    });
    this.presence();
  }

  private id(): string { return `${this.prefix}-${++this.sequence}`; }
  private send(value: unknown): void {
    if (this.closed || this.stopped) return;
    const socket = this.socket;
    // readyState can change before the browser delivers its close event.
    // Pending document updates stay queued for the next connection.
    if (!socket || socket.readyState !== WebSocket.OPEN) { this.disconnected(); return; }
    try { socket.send(JSON.stringify(value)); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'InvalidStateError') { this.disconnected(); return; }
      throw error;
    }
  }
  private sendAwareness(): void {
    this.send({ type: 'awareness', data: encodeBase64(encodeAwarenessUpdate(this.editor.awareness, [this.editor.doc.clientID])) });
  }
  private presence(): void {
    if (this.closed) return;
    const members = [];
    for (const [id, state] of this.editor.awareness.getStates()) {
      const value: unknown = state;
      if (!record(value) || !record(value.user) || typeof value.user.name !== 'string') continue;
      members.push({
        id,
        name: value.user.name || t('匿名成员'),
        self: id === this.editor.doc.clientID,
        hasCursor: record(value.cursor) && value.cursor.head != null,
      });
    }
    this.presenceChanged(members);
  }
  private emit(): void {
    if (this.online && !this.stopped) {
      this.status = this.closing ? t('服务正在关闭，保存中') : this.recovering ? t('正在恢复') : this.pending.size > 0 ? t('编辑中，尚有本地未确认更新') : this.saved < this.applied ? t('协作更新已持久化，Markdown 投影待完成') : this.recording ? t('正在保存历史记录') : t('已保存');
    }
    this.changed({ status: this.status, revision: this.applied, savedRevision: this.saved, pending: this.pending.size, connected: this.online, terminal: this.stopped, manualReconnect: !this.online && !this.stopped && (this.awaitingAuthentication || this.attempts >= 10) });
    for (const waiter of [...this.waiters]) waiter();
    for (const observer of this.observers) observer();
  }
  private readonly(): void {
    if (this.mounted) this.editor.setReadonly(!this.initialized || this.closed || this.closing || this.stopped);
  }

  async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try { await this.openConnection(); } finally { this.connecting = false; }
  }
  private async openConnection(): Promise<void> {
    if (this.closed || this.stopped || this.awaitingAuthentication) return;
    try {
      await request('/api/session');
      await request(noteAPI(this.filename));
    } catch (error) {
      if (error instanceof APIError && error.status === 401) { this.authenticationExpired(); return; }
      if (error instanceof APIError && [400, 404, 409].includes(error.status)) { this.stop(error.message); return; }
      if (error instanceof TypeError || (error instanceof APIError && [502, 503, 504].includes(error.status))) { this.disconnected(); return; }
      throw error;
    }
    if (this.closed || this.stopped || this.awaitingAuthentication) return;
    this.status = this.mounted ? t('正在恢复') : t('正在连接'); this.emit();
    const url = new URL(`${noteAPI(this.filename)}/ws`, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => { if (this.socket === socket && !this.closed && !this.stopped) this.send({ type: 'join', buildId: __BUILD_ID__, clientId: this.editor.doc.clientID, name: this.user.name, color: this.user.color }); };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      this.incoming = this.incoming.then(() => { if (this.socket === socket && !this.closed && !this.stopped && socket.readyState === WebSocket.OPEN) return this.receive(parse(event.data)); }).catch((error: unknown) => { if (this.closed) return; this.stop(t('不可恢复内部错误，编辑已停止')); this.fatal(error); });
    };
    socket.onclose = () => { if (this.socket === socket) this.disconnected(); };
    socket.onerror = () => { this.status = t('连接失败，等待恢复'); this.emit(); };
  }

  private disconnected(): void {
    this.online = false; this.closing = false; this.flushRequest = undefined;
    this.readonly();
    if (this.closed || this.stopped) return;
    const ids = [...this.editor.awareness.getStates().keys()].filter((id) => id !== this.editor.doc.clientID);
    removeAwarenessStates(this.editor.awareness, ids, remoteOrigin);
    this.status = this.awaitingAuthentication ? t('会话已过期，请重新登录') : this.initialized ? t('连接中断，可本地编辑，恢复后自动同步') : t('已断开，等待连接'); this.emit();
    if (!this.awaitingAuthentication && !this.reconnectTimer) {
      this.attempts++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.connect().catch(this.fatal);
      }, Math.min(this.attempts, 10) * 1000);
    }
  }

  private async receive(message: ServerMessage): Promise<void> {
    if (this.closed || this.stopped) return;
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    switch (message.type) {
      case 'waiting': this.peerId = message.peerId; this.status = t('等待初始化'); this.emit(); return;
      case 'bootstrap': {
        if ((this.mounted && !this.seeded) || this.pending.size > 0) { this.stop(t('文档初始化状态已变化，请重新打开')); return; }
        this.peerId = message.peerId; this.status = t('正在初始化'); this.emit();
        this.seeding = true;
        try { if (!this.mounted) { await this.editor.create(message.markdown); this.mounted = true; this.seeded = true; } }
        finally { this.seeding = false; }
        this.readonly();
        if (this.closed || this.stopped || this.socket !== socket || socket?.readyState !== WebSocket.OPEN) return;
        this.send({ type: 'initialize', requestId: this.id(), revision: message.revision, data: encodeBase64(fullUpdate(this.editor.doc)), markdown: this.editor.markdown() });
        return;
      }
      case 'init': {
        this.recovering = true;
        this.peerId = message.peerId;
        if (this.seeded) {
          // A different initializer may have committed while this connection
          // was interrupted. Never merge two independently seeded templates.
          const authoritative = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(authoritative, decodeBase64(message.data), remoteOrigin);
            const localVector = Y.decodeStateVector(Y.encodeStateVector(this.editor.doc));
            const serverVector = Y.decodeStateVector(Y.encodeStateVector(authoritative));
            if ([...localVector].some(([client, clock]) => (serverVector.get(client) ?? 0) < clock)) {
              this.stop(t('初始化已由其他成员完成，请重新打开此笔记')); return;
            }
          } finally { authoritative.destroy(); }
          this.seeded = false;
        }
        if (!this.mounted) { await this.editor.create(undefined, decodeBase64(message.data)); this.mounted = true; }
        else Y.applyUpdate(this.editor.doc, decodeBase64(message.data), remoteOrigin);
        if (this.closed || this.stopped || this.socket !== socket || socket?.readyState !== WebSocket.OPEN) return;
        this.applied = message.revision; this.saved = message.markdownRevision;
        applyAwarenessUpdate(this.editor.awareness, decodeBase64(message.awareness), remoteOrigin);
        this.initialized = true; this.online = true; this.attempts = 0;
        for (const [id, data] of this.pending) this.send({ type: 'update', messageId: id, data: encodeBase64(data) });
        this.editor.awareness.setLocalStateField('user', this.user);
        this.settled(); return;
      }
      case 'update': {
        if (!this.online || message.revision !== this.applied + 1) throw new Error('Nonsequential server revision');
        Y.applyUpdate(this.editor.doc, decodeBase64(message.data), remoteOrigin);
        if (message.restored) this.editor.undo.clear();
        this.applied = message.revision;
        if (message.peerId === this.peerId) this.pending.delete(message.messageId);
        this.settled(); return;
      }
      case 'awareness': applyAwarenessUpdate(this.editor.awareness, decodeBase64(message.data), remoteOrigin); return;
      case 'saved':
        if (message.revision > this.applied) throw new Error('Saved revision is ahead of applied state');
        this.saved = Math.max(this.saved, message.revision);
        if (message.requestId === this.flushRequest) this.flushRequest = undefined;
        if (this.saved < this.applied && this.pending.size === 0) this.scheduleFlush();
        this.emit(); return;
      case 'closing':
        this.closing = true; this.readonly(); this.flushRequest = undefined;
        this.flush(); this.emit(); return;
      case 'error':
        if (message.code === 'revision_conflict') { this.flushRequest = undefined; this.scheduleFlush(); return; }
        this.stop(t(message.message)); return;
    }
  }

  private settled(): void {
    if (this.pending.size === 0) { this.recovering = false; this.readonly(); this.scheduleFlush(); }
    this.emit();
  }
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, this.closing ? 0 : 300);
  }
  private flush(): void {
    if (!this.online || this.pending.size > 0 || this.flushRequest || !this.mounted || this.stopped) return;
    if (this.saved === this.applied && !this.closing) return;
    this.flushRequest = this.id();
    this.send({ type: 'flush', requestId: this.flushRequest, revision: this.applied, markdown: this.editor.markdown(), closing: this.closing });
  }
  hasUnsaved(): boolean { return this.pending.size > 0 || this.saved < this.applied; }
  get revision(): number { return this.applied; }
  observe(callback: () => void): () => void { this.observers.add(callback); return () => this.observers.delete(callback); }
  async checkpoint(author: string): Promise<void> {
    this.recording = true; this.emit();
    try {
      const revision = await this.readyRevision(new AbortController().signal);
      await request(`${noteAPI(this.filename)}/history`, 'POST', { revision, author });
      window.dispatchEvent(new Event('lannoto-history-recorded'));
    } catch (error) { if (error instanceof TypeError) throw new APIError(0, 'network', t('连接中断，请恢复连接后重试')); throw error; }
    finally { this.recording = false; this.emit(); }
  }
  setMode(mode: EditingMode): void { this.preview = mode === 'preview'; this.editor.setMode(mode); this.readonly(); }
  rename(name: string): void {
    this.user.name = name;
    this.editor.awareness.setLocalStateField('user', { ...this.user });
  }
  canEdit(): boolean { return this.mounted && this.initialized && !this.closed && !this.stopped && !this.preview && !this.closing; }
  insertMarkdown(markdown: string): void {
    if (!this.canEdit()) throw new APIError(409, 'readonly', t('当前为只读，无法插入内容。'));
    this.editor.insert(markdown);
  }
  readyRevision(signal: AbortSignal): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const cleanup = () => { this.waiters.delete(check); signal.removeEventListener('abort', aborted); };
      const aborted = () => { cleanup(); reject(new DOMException('Export cancelled', 'AbortError')); };
      const check = () => {
        if (signal.aborted) { aborted(); return; }
        if (this.closed || this.stopped || this.closing) { cleanup(); reject(new APIError(409, 'not_ready', t('当前未连接或无法继续编辑，请恢复连接后重新导出。'))); return; }
        if (this.online && !this.recovering && this.pending.size === 0 && this.saved === this.applied) { cleanup(); resolve(this.applied); }
      };
      this.waiters.add(check); signal.addEventListener('abort', aborted, { once: true });
      this.flush(); check();
    });
  }
  abort(message: string): void { this.stop(message); }
  authenticationExpired(): void {
    if (this.closed || this.stopped) return;
    this.awaitingAuthentication = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.socket?.close();
    this.disconnected();
    this.authExpired();
  }
  reconnect(): void { this.awaitingAuthentication = false; this.attempts = 0; if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; } void this.connect().catch(this.fatal); }
  private stop(message: string): void {
    this.stopped = true; this.status = message;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.online = false; this.readonly(); this.emit();
    this.socket?.close();
  }
  async destroy(): Promise<void> {
    this.closed = true; this.online = false;
    this.readonly();
    for (const waiter of [...this.waiters]) waiter();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.socket?.close();
    await this.incoming;
    if (this.mounted) await this.editor.destroy();
    else { this.editor.awareness.destroy(); this.editor.doc.destroy(); }
  }
}
