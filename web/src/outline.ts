import { t } from './i18n';
import { language } from './preferences';
interface Entry { element: HTMLHeadingElement; title: string; level: number; children: Entry[] }

function readHeadings(root: HTMLElement): Entry[] {
  return [...root.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5')].map(element => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.ProseMirror-yjs-cursor').forEach(cursor => cursor.remove());
    return { element, title: copy.textContent?.trim() || t('未命名标题'), level: Number(element.tagName.slice(1)), children: [] };
  });
}

function groupHeadings(entries: Entry[]): Entry[] {
  const roots: Entry[] = [], stack: Entry[] = [];
  for (const entry of entries) {
    while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(entry); else roots.push(entry);
    stack.push(entry);
  }
  return roots;
}

// Read standard rendered headings; never assign IDs or mutate editor content.
export class DocumentOutline {
  readonly root = document.createElement('section');
  private readonly nav = document.createElement('nav');
  private readonly observer: MutationObserver;
  private readonly collapsed = new Set<string>();
  private entries: Entry[] = [];
  private frame = 0;

  constructor(private readonly editor: HTMLElement, private readonly jumpTo: (heading: HTMLHeadingElement) => void) {
    this.root.className = 'document-outline';
    const title = document.createElement('h2'); title.textContent = t('文章目录');
    this.nav.setAttribute('aria-label', t('文章目录'));
    this.root.append(title, this.nav);
    this.observer = new MutationObserver(() => {
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
    });
    this.observer.observe(editor, { childList: true, characterData: true, subtree: true });
    this.update();
  }
  private update(): void {
    const next = readHeadings(this.editor);
    if (this.nav.hasChildNodes() && this.entries.length === next.length && next.every((entry, i) => entry.element === this.entries[i].element && entry.title === this.entries[i].title && entry.level === this.entries[i].level)) return;
    this.entries = next;
    const roots = groupHeadings(next);
    this.nav.replaceChildren();
    if (!roots.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t('暂无 H1–H5 标题'); this.nav.append(empty); return; }
    this.nav.append(this.list(roots));
  }
  private list(entries: Entry[]): HTMLUListElement {
    const list = document.createElement('ul');
    for (const entry of entries) {
      const item = document.createElement('li'); item.dataset.level = String(entry.level);
      const row = document.createElement('div'); row.className = 'outline-row';
      const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'outline-jump'; jump.textContent = entry.title; jump.title = `H${entry.level} · ${entry.title}`;
      jump.addEventListener('click', () => this.jumpTo(entry.element));
      if (entry.children.length) {
        const children = this.list(entry.children);
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'outline-toggle';
        const key = `${entry.level}:${entry.title}:${this.entries.filter(other => other.level === entry.level && other.title === entry.title).indexOf(entry)}`;
        const state = () => { const closed = this.collapsed.has(key); children.hidden = closed; toggle.textContent = closed ? '▸' : '▾'; toggle.setAttribute('aria-expanded', String(!closed)); toggle.setAttribute('aria-label', language === 'zh-CN' ? `${closed ? '展开' : '折叠'} ${entry.title} 的子标题` : `${closed ? 'Expand' : 'Collapse'} subheadings of ${entry.title}`); };
        toggle.addEventListener('click', () => { if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); state(); });
        state(); row.append(toggle, jump); item.append(row, children);
      } else { const spacer = document.createElement('span'); spacer.className = 'outline-spacer'; row.append(spacer, jump); item.append(row); }
      list.append(item);
    }
    return list;
  }
  destroy(): void { this.observer.disconnect(); cancelAnimationFrame(this.frame); this.root.remove(); }
}
