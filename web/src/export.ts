import { t } from './i18n';
import { APIError, noteAPI } from './api';
import { PrintView } from './print';
import type { Connection } from './sync';
import { download } from './download';
import { checked } from './download';
import { wordDiagrams } from './word-diagrams';

export class ExportController {
  readonly root = document.createElement('span');
  private readonly status = document.createElement('span');
  private readonly cancel = document.createElement('button');
  private readonly buttons: HTMLButtonElement[] = [];
  private active?: AbortController;
  private preview?: PrintView;

  constructor(private readonly connection: Connection, private readonly error: (error: unknown) => void) {
    this.root.className = 'export-controls'; this.status.className = 'export-status'; this.status.setAttribute('aria-live', 'polite');
    for (const [format, label] of [['bundle', t('下载 Markdown')], ['docx', t('下载 Word')], ['print', t('打印 / 保存为 PDF')]]) {
      const button = document.createElement('button'); button.textContent = format === 'bundle' ? t('下载 MD') : format === 'docx' ? t('下载 Word') : t('打印 / PDF'); button.setAttribute('aria-label', label); button.title = format === 'bundle' ? t('导出 Markdown，引用资源会一起打包为 ZIP') : label; button.type = 'button';
      button.addEventListener('click', () => { void this.export(format).catch(error); }); this.buttons.push(button); this.root.append(button);
    }
    this.cancel.textContent = t('取消导出'); this.cancel.className = 'export-cancel'; this.cancel.hidden = true; this.cancel.addEventListener('click', () => this.active?.abort());
    this.root.append(this.cancel, this.status);
  }

  private async export(format: string): Promise<void> {
    if (this.active) return;
    const controller = new AbortController(); this.active = controller;
    this.cancel.hidden = false; this.buttons.forEach((button) => { button.disabled = true; });
    try {
      this.status.textContent = t('正在等待当前内容保存');
      const revision = await this.connection.readyRevision(controller.signal);
      let diagrams: { source: string; png: string }[] | undefined;
      if (format === 'docx') {
        const snapshot = await checked(await fetch(`${noteAPI(this.connection.filename)}/export/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ revision }) })).then(response => response.json()) as { filename: string; revision: number; markdown: string };
        if (snapshot.filename !== this.connection.filename || snapshot.revision !== revision || typeof snapshot.markdown !== 'string') throw new Error('Invalid Word snapshot');
        this.status.textContent = t('正在准备 Word 图表');
        diagrams = await wordDiagrams(this.connection, snapshot.markdown, controller.signal);
      }
      this.status.textContent = format === 'docx' ? t('正在转换 Word') : t('正在获取导出快照');
      const response = await fetch(`${noteAPI(this.connection.filename)}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ format, revision, diagrams }),
      });
      if (!response.ok) {
        const value: unknown = await response.json();
        if (typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' && 'message' in value && typeof value.message === 'string') throw new APIError(response.status, value.code, value.message);
        throw new Error('Invalid export error response');
      }
      if (format === 'print') {
        const value: unknown = await response.json();
        if (typeof value !== 'object' || value === null || !('filename' in value) || value.filename !== this.connection.filename || !('revision' in value) || value.revision !== revision || !('markdown' in value) || typeof value.markdown !== 'string') throw new Error('Invalid print snapshot');
        if (this.preview) await this.preview.close();
        this.preview = new PrintView({ filename: value.filename, revision: value.revision, markdown: value.markdown }, this.error);
        this.status.textContent = t('打印预览已打开');
      } else {
        if (format === 'docx' && !response.headers.get('Content-Type')?.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) throw new Error('Invalid Word content type');
        await download(response, format === 'bundle' ? this.connection.filename : this.connection.filename.slice(0, -3) + '.docx');
        this.status.textContent = t('文件已准备，请查看浏览器下载列表。');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') this.status.textContent = t('已取消导出');
      else {
        this.status.textContent = t('导出失败');
        if (error instanceof TypeError) throw new APIError(0, 'network', t('导出连接中断，请恢复连接后重试。'));
        throw error;
      }
    } finally {
      this.active = undefined; this.cancel.hidden = true; this.buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async destroy(): Promise<void> { this.active?.abort(); if (this.preview) await this.preview.close(); }
}
