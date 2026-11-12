import { t } from './i18n';
import { language } from './preferences';
import { APIError, checked, noteAPI } from './api';

type SourceKind = 'file' | 'clipboard-image';
type UploadSource = SourceKind | 'prompt';
interface PendingUpload { file: File; source: UploadSource }
interface Asset { filename: string; url: string; kind: 'image' | 'attachment' }

function canIdentifyFileEntries(): boolean {
  if (typeof DataTransfer !== 'function' || typeof DataTransferItem !== 'function'
      || !DataTransferItem.prototype.webkitGetAsEntry) return false;
  // Firefox can wrap an in-memory File in an entry too. Check the browser's
  // behavior with an empty local probe before using entries as source evidence.
  const item = new DataTransfer().items.add(new File([], 'clipboard-probe.png'));
  return item !== null && item.webkitGetAsEntry() === null;
}

function markdown(asset: Asset): string {
  const label = asset.filename.replace(/[\\`*_[\]()!<>]/g, '\\$&');
  return `${asset.kind === 'image' ? '!' : ''}[${label}](<${asset.url}>)`;
}

async function chooseSource(file: File): Promise<SourceKind | null> {
  const dialog = document.createElement('dialog'); dialog.className = 'upload-source';
  const title = document.createElement('h2'); title.textContent = t('如何保存粘贴的文件？');
  const explanation = document.createElement('p');
  explanation.textContent = language === 'zh-CN' ? `浏览器提供的名称是“${file.name || '无文件名'}”，无法确认是截图还是已有文件。请选择保存方式。` : `The browser supplied “${file.name || 'unnamed'}”. Choose whether to keep this filename or name it by screenshot time.`;
  dialog.append(title, explanation);
  let answer: SourceKind | null = null;
  for (const [label, kind] of [[t('按截图时间命名'), 'clipboard-image'], [t('保留文件名'), 'file']] satisfies [string, SourceKind][]) {
    const button = document.createElement('button'); button.textContent = label; button.type = 'button';
    button.addEventListener('click', () => { answer = kind; dialog.close(); }); dialog.append(button);
  }
  const cancel = document.createElement('button'); cancel.textContent = t('取消'); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close()); dialog.append(cancel);
  document.body.append(dialog);
  const result = new Promise<SourceKind | null>((resolve) => dialog.addEventListener('close', () => { dialog.remove(); resolve(answer); }, { once: true }));
  dialog.showModal();
  return result;
}

async function resolveConflict(file: File, attempt: number): Promise<File> {
  const dialog = document.createElement('dialog'); dialog.className = 'upload-source';
  const title = document.createElement('h2'); title.textContent = t('文件名已存在');
  const description = document.createElement('p'); description.textContent = file.name;
  const input = document.createElement('input'); input.value = file.name; input.setAttribute('aria-label', t('新文件名'));
  dialog.append(title, description, input);
  let name: string | undefined;
  const split = file.name.lastIndexOf('.'), stem = split > 0 ? file.name.slice(0, split) : file.name, extension = split > 0 ? file.name.slice(split) : '';
  const now = new Date(), stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}${String(now.getMilliseconds()).padStart(3,'0')}`;
  for (const [label, value] of [
    ['自动重命名', () => `${stem} (${attempt})${extension}`],
    ['保存为时间戳', () => stamp + extension],
    ['使用手动文件名', () => input.value.trim()],
  ] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = t(label);
    button.addEventListener('click', () => { const candidate = value(); if (!candidate || /[\\/\x00]/.test(candidate)) { input.setCustomValidity(t('请输入有效文件名')); input.reportValidity(); return; } name = candidate; dialog.close(); }); dialog.append(button);
  }
  input.addEventListener('input', () => input.setCustomValidity(''));
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('取消'); cancel.addEventListener('click', () => dialog.close()); dialog.append(cancel);
  const closed = new Promise<void>(resolve => dialog.addEventListener('close', () => { dialog.remove(); resolve(); }, { once: true }));
  document.body.append(dialog); dialog.showModal(); await closed;
  if (name === undefined) throw new DOMException('Upload cancelled', 'AbortError');
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

export class UploadController {
  readonly button = document.createElement('button');
  readonly input = document.createElement('input');
  readonly status = document.createElement('span');
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly canEdit: () => boolean,
    private readonly insert: (markdown: string) => void,
    private readonly error: (error: unknown) => void,
    private readonly assetStored: () => void,
  ) {
    this.button.textContent = t('上传图片 / 附件'); this.button.type = 'button';
    this.input.type = 'file'; this.input.multiple = true; this.input.hidden = true; this.input.id = 'upload-files';
    this.input.setAttribute('aria-label', t('上传图片或附件')); this.status.className = 'upload-status';
    this.status.setAttribute('aria-live', 'polite');
    this.button.addEventListener('click', () => this.input.click());
    this.input.addEventListener('change', () => {
      if (this.input.files) this.enqueue([...this.input.files].map(file => ({ file, source: 'file' })));
      this.input.value = '';
    });
  }

  readonly image = async (file: File): Promise<string> => {
    try {
      const asset = await this.store(file, 'file');
      if (asset.kind !== 'image') throw new APIError(400, 'not_image', '这不是可预览的位图。请通过“上传图片 / 附件”作为附件插入。');
      return asset.url;
    } catch (error) { this.error(error); throw error; }
  };

  attach(root: HTMLElement): void {
    const identifiesFileEntries = canIdentifyFileEntries();
    const inPreview = (event: Event) => event.target instanceof Element && event.target.closest('[data-readonly-preview]');
    root.addEventListener('paste', (event) => {
      const data = event.clipboardData;
      if (!data) return;
      const uploads: PendingUpload[] = [];
      for (const item of data.items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        let source: UploadSource = 'prompt';
        if (identifiesFileEntries) {
          const entry = item.webkitGetAsEntry();
          if (entry?.isFile) source = 'file';
          // Chromium wraps native clipboard pixels in an entryless image.png.
          // Keep asking when the paste does not match that payload.
          else if (entry === null && event.isTrusted && file.type === 'image/png' && file.name === 'image.png') {
            source = 'clipboard-image';
          }
        }
        uploads.push({ file, source });
      }
      if (uploads.length === 0) {
        for (const file of data.files) uploads.push({ file, source: 'prompt' });
      }
      if (uploads.length === 0) return;
      event.preventDefault(); event.stopPropagation();
      if (!inPreview(event)) this.enqueue(uploads);
    }, { capture: true });
    root.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
    root.addEventListener('drop', (event) => {
      const files = event.dataTransfer ? [...event.dataTransfer.files] : [];
      if (files.length === 0) return;
      event.preventDefault(); event.stopPropagation();
      if (!inPreview(event)) this.enqueue(files.map(file => ({ file, source: 'file' })));
    }, { capture: true });
  }

  private async source(file: File, mode: UploadSource): Promise<SourceKind> {
    if (mode !== 'prompt') return mode;
    if (!file.type.startsWith('image/')) return 'file';
    if (!file.name) return 'clipboard-image';
    if (!/^(?:image|图片|圖片)\.(png|jpe?g|gif|webp)$/i.test(file.name)) return 'file';
    const source = await chooseSource(file);
    if (source === null) throw new DOMException('Upload cancelled', 'AbortError');
    return source;
  }
  private enqueue(uploads: PendingUpload[]): void {
    const task = this.queue.then(async () => {
      const assets: Asset[] = [];
      try {
        for (const { file, source } of uploads) {
          this.setStatus(language === 'zh-CN' ? `正在上传 ${file.name || '剪贴板图片'}` : `Uploading ${file.name || 'clipboard image'}`);
          assets.push(await this.store(file, await this.source(file, source)));
        }
      } finally {
        if (assets.length > 0) {
          // Insert the batch once. In the visual editor an image insertion can
          // select the image, so a later insertion would replace it.
          if (!this.canEdit()) throw new APIError(409, 'readonly', `资源已保存至 ${assets.map(asset => asset.url).join(', ')}，但当前为只读，尚未插入正文。`);
          this.insert(assets.map(markdown).join('\n\n'));
          const filenames = assets.map(asset => asset.filename).join(', ');
          this.setStatus(language === 'zh-CN' ? `已插入 ${filenames}` : `Inserted ${filenames}`);
        }
      }
    });
    this.queue = task.catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') { this.setStatus(t('已取消上传')); return; }
      this.setStatus(t('上传或插入失败')); this.error(error);
    });
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
    this.status.title = message;
  }

  private async store(file: File, sourceKind: SourceKind): Promise<Asset> {
    if (!this.canEdit()) throw new APIError(409, 'readonly', '当前为只读，连接恢复并进入编辑状态后才能上传。');
    if (file.size > 50 * 1024 * 1024) throw new APIError(413, 'too_large', '文件超过 50 MiB');
    if (sourceKind === 'file' && !file.name) throw new APIError(400, 'missing_filename', '浏览器没有提供原文件名，请通过文件选择上传。');
    let attempt = 0;
    for (;;) {
      const form = new FormData(); form.append('sourceKind', sourceKind); form.append('file', file, file.name);
      let response: Response;
      try { response = await fetch(`${noteAPI(this.filename)}/assets`, { method: 'POST', body: form }); }
      catch (error) { if (error instanceof TypeError) throw new APIError(0, 'network_error', '上传失败，连接已中断。'); throw error; }
      try { await checked(response); }
      catch (error) {
        if (error instanceof APIError && error.status === 409 && error.code === 'already_exists') { file = await resolveConflict(file, ++attempt); sourceKind = 'file'; continue; }
        throw error;
      }
      const value: unknown = await response.json();
      if (typeof value !== 'object' || value === null || !('filename' in value) || typeof value.filename !== 'string' || !('url' in value) || typeof value.url !== 'string' || !value.url.startsWith('static/') || !('kind' in value) || (value.kind !== 'image' && value.kind !== 'attachment')) throw new Error('Invalid uploaded asset response');
      this.assetStored();
      return { filename: value.filename, url: value.url, kind: value.kind };
    }
  }
}
