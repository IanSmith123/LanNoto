import { t } from './i18n';
import { Crepe } from '@milkdown/crepe';
import { headingIdGenerator, codeBlockSchema, imageSchema } from '@milkdown/kit/preset/commonmark';
import { editorViewCtx, parserCtx, remarkCtx } from '@milkdown/kit/core';
import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { DOMSerializer } from '@milkdown/kit/prose/model';
import type { Image, ImageReference, Nodes } from 'mdast';
import { EditorView } from '@codemirror/view';
import { setCodeMirrorTheme } from '@milkdown/crepe/feature/code-mirror';
import { codeTheme } from './code-theme';
import { diagramSVG } from './mermaid';

export interface PrintSnapshot { filename: string; revision: number; markdown: string }
class ResourceError extends Error {}
type PaperMode = 'normal' | 'narrow' | 'continuous';
const mmPerPixel = 25.4 / 96;

function imageLines(tree: Nodes): Map<string, number[]> {
  const definitions = new Map<string, string>();
  const references: (Image | ImageReference)[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === 'image' || node.type === 'imageReference') references.push(node);
    else if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    else if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  const lines = new Map<string, number[]>();
  // Consume repeated references in source order with pop().
  for (const node of references.reverse()) {
    const url = node.type === 'image' ? node.url : definitions.get(node.identifier);
    const line = node.position?.start.line;
    if (url === undefined || line === undefined) continue;
    const locations = lines.get(url);
    if (locations) locations.push(line); else lines.set(url, [line]);
  }
  return lines;
}

export class PrintView {
  private readonly root = document.createElement('section');
  private readonly body = document.createElement('div');
  private readonly sheet = document.createElement('div');
  private readonly paper = document.createElement('select');
  private readonly pageStyle = document.createElement('style');
  private readonly dimensions = document.createElement('p');
  private readonly resize = new ResizeObserver(() => { if (this.ready && !this.layoutPending) this.updatePage(); });
  private ready = false;
  private layoutPending = true;
  private layoutVersion = 0;
  private readonly status = document.createElement('p');
  private readonly print = document.createElement('button');
  private readonly controller = new AbortController();
  private readonly crepe: Crepe;
  private readonly creating: Promise<void>;
  private created = false;
  private resourceError?: Error;
  private closing?: Promise<void>;
  private readonly previousTitle = document.title;
  private readonly diagramURLs: string[] = [];

  constructor(snapshot: PrintSnapshot, private readonly fatal: (error: unknown) => void) {
    this.root.className = 'print-view'; this.root.setAttribute('aria-label', t('打印预览'));
    this.body.className = 'editor-surface print-body';
    const header = document.createElement('header'); header.className = 'print-controls';
    const title = document.createElement('h1'); title.textContent = snapshot.filename;
    const toolbar = document.createElement('div'); toolbar.className = 'print-toolbar';
    const details = document.createElement('div'); details.className = 'print-details';
    this.status.textContent = t('准备打印中'); this.status.setAttribute('role', 'status');
    this.print.textContent = t('打印'); this.print.disabled = true;
    this.print.addEventListener('click', () => { if (this.updatePage()) window.print(); });
    const close = document.createElement('button'); close.textContent = t('关闭');
    close.setAttribute('aria-label', t('关闭打印预览'));
    close.addEventListener('click', () => { void this.close().catch(fatal); });
    const paperLabel = document.createElement('label'); paperLabel.textContent = t('纸张布局');
    for (const [value, label] of [['normal', t('正常 A4')], ['narrow', t('窄边距 A4')], ['continuous', t('连续长页 PDF')]]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; this.paper.append(option);
    }
    paperLabel.append(this.paper); this.paper.addEventListener('change', () => { void this.layout().catch(fatal); });
    this.dimensions.className = 'print-dimensions';
    toolbar.append(title, paperLabel, this.print, close);
    details.append(this.dimensions, this.status);
    header.append(toolbar, details);
    this.sheet.className = 'print-sheet'; this.sheet.append(this.body); this.root.append(header, this.sheet);
    this.pageStyle.dataset.printPage = ''; document.head.append(this.pageStyle); this.applyPaper();
    document.body.append(this.root); document.body.classList.add('print-preview-active');
    document.title = snapshot.filename;
    this.crepe = new Crepe({ root: this.body, defaultValue: snapshot.markdown, features: {
      [Crepe.Feature.AI]: false, [Crepe.Feature.Toolbar]: false, [Crepe.Feature.BlockEdit]: false,
      [Crepe.Feature.TopBar]: false, [Crepe.Feature.Cursor]: false, [Crepe.Feature.Placeholder]: false,
      [Crepe.Feature.LinkTooltip]: false,
    }, featureConfigs: {
      [Crepe.Feature.CodeMirror]: { previewOnlyByDefault: true, extensions: [EditorView.lineWrapping] },
    } });
    this.crepe.editor.config((ctx) => ctx.set(headingIdGenerator.key, () => ''));
    // This standalone readonly editor never creates a Y.Doc or WebSocket.
    this.creating = this.crepe.create().then(() => {
      this.created = true; this.crepe.setReadonly(true);
      this.crepe.editor.action(setCodeMirrorTheme(codeTheme));
      this.crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        // The immutable print editor uses the official schema DOM and the
        // configured official preview renderer. No virtualized code editor is
        // needed here: every block must exist even outside the viewport.
        view.setProps({ nodeViews: { ...view.props.nodeViews,
          [codeBlockSchema.type(ctx).name]: node => {
            const rendered = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node));
            if (rendered.contentDOM) rendered.contentDOM.textContent = node.textContent;
            const dom = document.createElement('div'); dom.dataset.printCode = '';
            if (String(node.attrs.language).toLowerCase() === 'latex' && node.textContent) {
              const preview = ctx.get(codeBlockConfig.key).renderPreview('latex', node.textContent, () => {});
              if (typeof preview === 'string') dom.innerHTML = preview;
              else if (preview instanceof HTMLElement) dom.append(preview);
              else this.resourceError = new ResourceError(t('官方公式预览不可用'));
              if (dom.querySelector('.katex-error')) this.resourceError = new ResourceError(t('公式渲染失败'));
              dom.dataset.printMath = '';
            } else dom.append(rendered.dom);
            return { dom };
          },
        } });
      });
    });
    this.resize.observe(this.body);
    void this.prepare(snapshot.markdown).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.failed(error);
      if (!(error instanceof ResourceError)) this.fatal(error);
    });
  }

  private failed(error: unknown): void {
    if (this.controller.signal.aborted) return;
    this.print.disabled = true;
    this.status.textContent = `${t('准备失败')}：${error instanceof Error ? error.message : String(error)}`;
    this.status.className = 'error'; console.error(error);
  }
  private async prepare(markdown: string): Promise<void> {
    await this.creating;
    if (this.controller.signal.aborted) return;
    await this.prepareDiagrams();
    if (this.controller.signal.aborted) return;
    const images = this.crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const lines = imageLines(ctx.get(remarkCtx).parse(markdown));
      const inlineImage = imageSchema.type(ctx), blockImage = imageBlockSchema.type(ctx);
      const resources: { image: HTMLImageElement | null; src: string; line?: number }[] = [];
      // ProseMirror can use address-less IMG elements as cursor separators.
      // Validate only images represented by nodes in the print document.
      view.state.doc.descendants((node, position) => {
        if (node.type !== inlineImage && node.type !== blockImage) return;
        const dom = view.nodeDOM(position);
        const image = dom instanceof HTMLImageElement ? dom : dom instanceof Element ? dom.querySelector('img') : null;
        const src = String(node.attrs.src);
        resources.push({ image, src, line: lines.get(src)?.pop() });
      });
      return resources;
    });
    await Promise.all(images.map(({ image, src, line }) => this.imageReady(image, src, line)));
    await document.fonts.ready;
    document.fonts.forEach((face) => { if (face.status === 'error') throw new ResourceError(`${t('字体加载失败')}：${face.family}`); });
    if (this.resourceError) throw this.resourceError;
    if (this.controller.signal.aborted) return;
    this.ready = true;
    await this.layout();
  }

  private async prepareDiagrams(): Promise<void> {
    const blocks: { position: number; size: number; code: string }[] = [];
    this.crepe.editor.action(ctx => ctx.get(editorViewCtx).state.doc.descendants((node, position) => {
      if (node.type === codeBlockSchema.type(ctx) && String(node.attrs.language).trim().toLowerCase() === 'mermaid') blocks.push({ position, size: node.nodeSize, code: node.textContent });
    }));
    if (!blocks.length) return;
    const images: { position: number; size: number; url: string }[] = [];
    for (const block of blocks) {
      if (this.controller.signal.aborted) return;
      let svg: string;
      try { svg = await diagramSVG(block.code); }
      catch (error) { throw new ResourceError(`${t('Mermaid 语法或渲染错误')}\n${error instanceof Error ? error.message : String(error)}`); }
      if (this.controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      this.diagramURLs.push(url); images.push({ ...block, url });
    }
    // Change only this immutable print document via public editor APIs. This
    // eagerly handles offscreen diagrams without touching lazy NodeView internals.
    this.crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx), transaction = view.state.tr;
      for (const image of images.reverse()) {
        const parsed = ctx.get(parserCtx)(`![Mermaid](<${image.url}>)`);
        if (!parsed) throw new Error('Official parser rejected the diagram image');
        transaction.replaceWith(image.position, image.position + image.size, parsed.content);
      }
      view.dispatch(transaction.setMeta('addToHistory', false));
    });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }
  private get mode(): PaperMode { return this.paper.value as PaperMode; }
  private get margin(): number { return this.mode === 'normal' ? 25.4 : 12.7; }
  private applyPaper(): void {
    this.root.dataset.paper = this.mode;
    this.root.style.setProperty('--print-margin', `${this.margin}mm`);
    this.root.style.setProperty('--print-content-width', `${210 - 2 * this.margin}mm`);
    this.pageStyle.textContent = `@page{size:A4;margin:${this.margin}mm}`;
  }
  private async layout(): Promise<void> {
    const version = ++this.layoutVersion;
    this.layoutPending = true;
    this.print.disabled = true; this.applyPaper();
    if (!this.ready || this.controller.signal.aborted) return;
    this.status.className = ''; this.status.textContent = t('准备中：调整纸张布局');
    // Let the browser and CodeMirror measure the selected content width.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await document.fonts.ready;
    if (version !== this.layoutVersion || this.controller.signal.aborted || this.resourceError) return;
    let failedFont: string | undefined;
    document.fonts.forEach(face => { if (face.status === 'error') failedFont = face.family; });
    if (failedFont) { this.resourceError = new ResourceError(`${t('字体加载失败')}：${failedFont}`); this.failed(this.resourceError); return; }
    this.layoutPending = false;
    this.updatePage();
  }
  private updatePage(): boolean {
    if (!this.ready || this.layoutPending || this.controller.signal.aborted || this.resourceError) return false;
    const height = this.mode === 'continuous' ? Math.ceil(this.body.getBoundingClientRect().height * mmPerPixel + 2 * this.margin + 1) : 297;
    this.dimensions.textContent = `210 × ${height} mm · ${t('四边')} ${this.margin} mm`;
    if (height > 5000) {
      this.status.className = 'error'; this.status.textContent = t('连续长页超过 5000 mm，请选择 A4 布局'); this.print.disabled = true; return false;
    }
    this.pageStyle.textContent = `@page{size:210mm ${height}mm;margin:${this.margin}mm}`;
    this.sheet.style.minHeight = `${height}mm`;
    this.status.className = ''; this.status.textContent = t('可打印'); this.print.disabled = false;
    return true;
  }
  private imageReady(image: HTMLImageElement | null, src: string, line?: number): Promise<void> {
    const location = line === undefined ? '' : `（${t('Markdown 第 {line} 行').replace('{line}', String(line))}）`;
    const address = src.trim() || t('空地址');
    const failed = () => new ResourceError(`${t('图片无法加载')}${location}：${address}`);
    if (!image || !src.trim()) return Promise.reject(failed());
    return new Promise<void>((resolve, reject) => {
      const signal = this.controller.signal;
      const aborted = () => reject(new DOMException('Print preview closed', 'AbortError'));
      signal.addEventListener('abort', aborted, { once: true });
      void image.decode().then(() => {
        signal.removeEventListener('abort', aborted);
        if (image.naturalWidth === 0) reject(failed()); else resolve();
      }, () => { signal.removeEventListener('abort', aborted); reject(failed()); });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort();
    this.resize.disconnect();
    this.closing = (async () => {
      try { await this.creating; } catch (error) { this.fatal(error); }
      if (this.created) await this.crepe.destroy();
      for (const url of this.diagramURLs) URL.revokeObjectURL(url);
      this.root.remove(); this.pageStyle.remove(); document.body.classList.remove('print-preview-active'); document.title = this.previousTitle;
    })();
    return this.closing;
  }
}
