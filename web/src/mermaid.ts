import { t } from './i18n';

let sequence = 0;
let queue: Promise<void> = Promise.resolve();

// Mermaid configuration is global. Serialize initialization and rendering so
// an editor's dark theme cannot leak into the independent light print snapshot.
export function diagramSVG(code: string, dark = false): Promise<string> {
  const result = queue.then(async () => {
    if (code.length > 50000) throw new Error(t('Mermaid 图表不能超过 50000 个字符'));
    // Render locally without fetching diagram images, links or remote fonts.
    if (/(?:https?:|javascript:|data:|file:|blob:|(?:["'(\s])\/\/)/i.test(code)) throw new Error(t('Mermaid 图表暂不支持外部资源或链接'));
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default', htmlLabels: false, fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      maxTextSize: 50000, maxEdges: 500,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'fontFamily', 'theme', 'themeCSS', 'dompurifyConfig'],
    });
    const { svg } = await mermaid.render(`lannoto-mermaid-${++sequence}`, code);
    // SVG used as an image needs explicit intrinsic dimensions. Percentage
    // widths otherwise shrink sequence diagrams to the browser's 300px default.
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const bounds = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
      root.setAttribute('width', String(bounds[2])); root.setAttribute('height', String(bounds[3]));
    }
    return new XMLSerializer().serializeToString(root);
  });
  // A syntax error belongs to its diagram and must not poison later renders.
  queue = result.then(() => undefined, () => undefined);
  return result;
}

interface Preview { root: HTMLElement; code: string; version: number; apply: (value: null | string | HTMLElement) => void; timer?: ReturnType<typeof setTimeout> }
export class MermaidPreviews {
  private readonly previews = new Set<Preview>();
  private destroyed = false;
  private readonly theme = new MutationObserver(() => {
    for (const preview of this.previews) {
      if (this.canDiscard(preview)) this.remove(preview);
      else this.render(preview);
    }
  });
  constructor(private readonly scope: HTMLElement) { this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); }
  private mounted(preview: Preview): boolean { return this.scope.querySelector(`[data-mermaid-preview="${preview.root.dataset.mermaidPreview}"]`) !== null; }
  private canDiscard(preview: Preview): boolean {
    // Nearby blocks can request previews in the same batch before their
    // placeholders enter the DOM. Their timers check for attachment later.
    return preview.timer === undefined && !this.mounted(preview);
  }
  private remove(preview: Preview): void { if (preview.timer) clearTimeout(preview.timer); this.previews.delete(preview); }
  readonly preview = (language: string, content: string, apply: (value: null | string | HTMLElement) => void): HTMLElement | null => {
    if (language.trim().toLowerCase() !== 'mermaid') return null;
    for (const old of this.previews) if (this.canDiscard(old)) this.remove(old);
    const root = document.createElement('div'); root.className = 'mermaid-preview'; root.setAttribute('aria-label', t('Mermaid 图表'));
    root.dataset.mermaidPreview = String(++sequence);
    const preview = { root, code: content, version: 0, apply }; this.previews.add(preview); this.render(preview);
    return root;
  };
  private render(preview: Preview): void {
    const version = ++preview.version;
    preview.root.textContent = t('正在绘制 Mermaid 图表'); preview.root.removeAttribute('role');
    if (preview.timer) clearTimeout(preview.timer);
    preview.timer = setTimeout(() => {
      preview.timer = undefined;
      if (this.destroyed || !this.mounted(preview)) { this.remove(preview); return; }
      void diagramSVG(preview.code, document.documentElement.dataset.theme === 'dark').then(svg => {
        if (this.destroyed || preview.version !== version || !this.mounted(preview)) return;
        preview.root.innerHTML = svg; preview.apply(preview.root.outerHTML);
      }, error => {
        if (this.destroyed || preview.version !== version || !this.mounted(preview)) return;
        preview.root.textContent = `${t('Mermaid 语法或渲染错误')}\n${error instanceof Error ? error.message : String(error)}`;
        preview.root.setAttribute('role', 'alert'); preview.apply(preview.root.outerHTML);
      });
    }, 180);
  }
  destroy(): void { this.destroyed = true; this.theme.disconnect(); for (const preview of this.previews) this.remove(preview); }
}
