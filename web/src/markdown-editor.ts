import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, parserCtx, serializerCtx, prosePluginsCtx, remarkCtx } from '@milkdown/kit/core';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { history } from '@milkdown/kit/plugin/history';
import { headingIdGenerator, paragraphSchema } from '@milkdown/kit/preset/commonmark';
import { insert } from '@milkdown/kit/utils';
import { setCodeMirrorTheme } from '@milkdown/crepe/feature/code-mirror';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { diffChars } from 'diff';
import type { Heading, Nodes } from 'mdast';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { codeTheme } from './code-theme';
import { t } from './i18n';
import { markdownPresence, peerSelection, visible, richPosition } from './markdown-presence';
import { mapOffset } from './markdown-offset';
import { MermaidPreviews } from './mermaid';
import { blankLines } from './blank-lines';
import { linkSplitScroll } from './split-scroll';

export const remoteOrigin = Symbol('remote');
const richOrigin = Symbol('rich-edit');
export type EditingMode = 'rich' | 'source' | 'preview' | 'split';

// Markdown is the only shared document. Both views edit this same Y.Text.
export class NoteEditor {
  readonly doc = new Y.Doc({ gc: false });
  readonly awareness = new Awareness(this.doc);
  readonly text = this.doc.getText('markdown');
  readonly undo = new Y.UndoManager(this.text, { trackedOrigins: new Set([richOrigin]) });
  readonly crepe: Crepe;
  private readonly diagrams: MermaidPreviews;
  private readonly richRoot = document.createElement('div');
  private readonly sourceRoot = document.createElement('div');
  private source?: EditorView;
  private unlinkScroll?: () => void;
  private readonly editable = new Compartment();
  private projecting = false;
  private writing = false;
  private mounted = false;
  private readonlyState = true;
  private caret?: { anchor: Y.RelativePosition; head: Y.RelativePosition };
  private mode: EditingMode = 'rich';

  constructor(private readonly root: HTMLElement, uploadImage?: (file: File) => Promise<string>) {
    this.diagrams = new MermaidPreviews(root);
    this.sourceRoot.className = 'markdown-source'; this.sourceRoot.hidden = true;
    this.richRoot.className = 'markdown-visual';
    root.append(this.sourceRoot, this.richRoot);
    this.crepe = new Crepe({ root: this.richRoot, features: { [Crepe.Feature.AI]: false }, featureConfigs: {
      [Crepe.Feature.CodeMirror]: { renderPreview: this.diagrams.preview },
      ...(uploadImage ? { [Crepe.Feature.ImageBlock]: { onUpload: uploadImage } } : {}),
    } });
    this.crepe.editor.use(blankLines);
    this.doc.on('beforeTransaction', transaction => {
      if (transaction.origin !== remoteOrigin || !this.mounted || this.mode !== 'rich') return;
      this.crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx), selection = view.state.selection;
        const map = mapOffset(visible(view.state.doc), this.markdown());
        this.caret = { anchor: Y.createRelativePositionFromTypeIndex(this.text, map(visible(view.state.doc, selection.anchor).length)), head: Y.createRelativePositionFromTypeIndex(this.text, map(visible(view.state.doc, selection.head).length)) };
      });
    });
    this.crepe.editor.config(ctx => {
      ctx.set(headingIdGenerator.key, () => '');
      ctx.update(paragraphSchema.key, previous => context => {
        const schema = previous(context);
        return { ...schema, toMarkdown: { ...schema.toMarkdown, runner: (state, node) => {
          if (node.content.size) return schema.toMarkdown.runner(state, node);
          // Empty visual paragraphs are whitespace, not authored HTML.
          state.openNode('paragraph'); state.closeNode();
        } } };
      });
      ctx.update(prosePluginsCtx, plugins => [...plugins, markdownPresence(this.text, this.awareness), new Plugin({
        props: { handleKeyDown: (_view, event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
          const key = event.key.toLowerCase();
          if (key !== 'z' && key !== 'y') return false;
          event.preventDefault();
          if (!this.readonlyState && this.mode === 'rich') { if (key === 'y' || event.shiftKey) this.undo.redo(); else this.undo.undo(); }
          return true;
        } },
        view: () => ({ update: (view, previous) => {
          if (!this.mounted || this.projecting || view.state.doc.eq(previous.doc)) return;
          if (this.readonlyState || this.mode !== 'rich') { queueMicrotask(() => this.project()); return; }
          const serialize = ctx.get(serializerCtx);
          this.write(serialize(previous.doc), serialize(view.state.doc));
        } }),
      })]);
    });
    this.text.observe(() => { if (this.mounted && !this.writing) this.project(); });
  }

  async create(template?: string, state?: Uint8Array): Promise<void> {
    if (state) Y.applyUpdate(this.doc, state, remoteOrigin);
    if (template !== undefined) this.doc.transact(() => {
      this.doc.getMap('lannoto').set('format', 'markdown-v1');
      if (template) this.text.insert(0, template);
    }, remoteOrigin);
    if (this.doc.getMap('lannoto').get('format') !== 'markdown-v1') throw new Error('Invalid Markdown document format');
    await this.crepe.editor.remove(history);
    await this.crepe.create();
    this.crepe.editor.action(setCodeMirrorTheme(codeTheme));
    this.mounted = true; this.project();
    this.source = new EditorView({ parent: this.sourceRoot, state: EditorState.create({ doc: this.text.toString(), extensions: [
      lineNumbers(), EditorView.lineWrapping, codeTheme,
      EditorState.lineSeparator.of('\n'),
      EditorView.contentAttributes.of({ 'aria-label': t('Markdown 源码') }),
      this.editable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      yCollab(this.text, this.awareness, { undoManager: this.undo }),
      keymap.of([...yUndoManagerKeymap.map(binding => ({ ...binding, run: (view: EditorView) => this.readonlyState || !this.editsSource() ? true : binding.run?.(view) ?? false })), ...defaultKeymap, indentWithTab]),
    ] }) });
    this.undo.clear(); this.setReadonly(true);
    this.updateSplitScroll();
  }

  markdown(): string { return this.text.toString(); }
  scrollToHeading(heading: HTMLHeadingElement): void {
    if (this.mode !== 'source') {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const source = this.source;
    if (!source || !this.mounted) return;
    this.crepe.editor.action(ctx => {
      const elements = [...ctx.get(editorViewCtx).dom.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      const index = elements.indexOf(heading);
      if (index < 0) return;
      // The Markdown parser gives exact offsets for Setext and nested
      // headings, even when several headings have identical text.
      const headings: Heading[] = [];
      const collect = (node: Nodes): void => {
        if (node.type === 'heading') headings.push(node);
        if ('children' in node) node.children.forEach(collect);
      };
      collect(ctx.get(remarkCtx).parse(source.state.doc.toString()));
      if (headings.length !== elements.length) return;
      const offset = headings[index].position?.start.offset;
      if (offset !== undefined) source.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'start' }) });
    });
  }
  scrollToPeer(clientId: number): void {
    if (!this.mounted || clientId === this.doc.clientID) return;
    const selection = peerSelection(this.text, this.awareness.getStates().get(clientId));
    if (!selection) return;
    if (this.editsSource() && this.source) {
      const position = Math.min(selection.head, this.source.state.doc.length);
      this.source.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      return;
    }
    const caret = this.richRoot.querySelector(`[data-peer-cursor="${clientId}"]`);
    if (caret?.getClientRects().length) {
      caret.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }
    // A lazy node view can hide its inline caret. Reveal its document block.
    this.crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx), doc = view.state.doc;
      const plain = visible(doc), offset = mapOffset(this.markdown(), plain)(selection.head);
      const position = doc.resolve(richPosition(doc, offset));
      const block = view.nodeDOM(position.depth ? position.before(1) : position.pos);
      if (block instanceof Element) block.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  }
  private write(previous: string, markdown: string): void {
    if (markdown === previous) return;
    // Apply only the user's semantic edit. Unchanged source punctuation,
    // indentation and blank lines retain their original spelling.
    const source = this.markdown(), map = mapOffset(previous, source);
    const patches: { from: number; to: number; insert: string }[] = [];
    let position = 0;
    for (const change of diffChars(previous, markdown)) {
      if (change.removed) { patches.push({ from: map(position), to: map(position + change.value.length), insert: '' }); position += change.value.length; }
      else if (change.added) patches.push({ from: map(position), to: map(position), insert: change.value });
      else position += change.value.length;
    }
    this.writing = true;
    try {
      this.doc.transact(() => {
        for (const patch of patches.reverse()) {
          if (patch.to > patch.from) this.text.delete(patch.from, patch.to - patch.from);
          if (patch.insert) this.text.insert(patch.from, patch.insert);
        }
      }, richOrigin);
    } finally { this.writing = false; }
    // Keep the user's selection and in-progress empty paragraphs. Markdown
    // whitespace has no paragraph node; parsing it back after each keystroke
    // would remove the empty paragraph before the user can type into it.
  }
  private project(): void {
    if (!this.mounted) return;
    this.projecting = true;
    try {
      this.crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        const parsed = ctx.get(parserCtx)(this.markdown());
        if (!parsed) throw new Error('Official Markdown parser rejected the document');
        // Replace only the changed document range so native selection mapping
        // and composition can retain unchanged surrounding content.
        const start = view.state.doc.content.findDiffStart(parsed.content);
        if (start === null) return;
        const end = view.state.doc.content.findDiffEnd(parsed.content);
        if (!end) return;
        const overlap = start - Math.min(end.a, end.b);
        const oldEnd = end.a + Math.max(0, overlap), newEnd = end.b + Math.max(0, overlap);
        const tr = view.state.tr.replace(start, oldEnd, parsed.slice(start, newEnd));
        if (this.caret) {
          const anchor = Y.createAbsolutePositionFromRelativePosition(this.caret.anchor, this.doc), head = Y.createAbsolutePositionFromRelativePosition(this.caret.head, this.doc);
          if (anchor?.type === this.text && head?.type === this.text) {
            const map = mapOffset(this.markdown(), visible(tr.doc));
            tr.setSelection(TextSelection.between(tr.doc.resolve(richPosition(tr.doc, map(anchor.index))), tr.doc.resolve(richPosition(tr.doc, map(head.index)))));
          }
        }
        view.dispatch(tr.setMeta('addToHistory', false));
      });
    } finally { this.projecting = false; this.caret = undefined; }
  }
  setMode(mode: EditingMode): void {
    this.awareness.setLocalStateField('cursor', null);
    this.undo.stopCapturing(); this.mode = mode;
    const split = mode === 'split';
    this.root.classList.toggle('split-editor', split);
    this.richRoot.hidden = mode === 'source'; this.sourceRoot.hidden = !this.editsSource();
    this.richRoot.toggleAttribute('data-readonly-preview', split || mode === 'preview');
    for (const [pane, label] of [[this.sourceRoot, t('源码编辑区')], [this.richRoot, t('实时预览')]] as const) {
      if (split) { pane.setAttribute('role', 'region'); pane.setAttribute('aria-label', label); }
      else { pane.removeAttribute('role'); pane.removeAttribute('aria-label'); }
    }
    this.setReadonly(this.readonlyState);
    if (this.editsSource()) this.source?.requestMeasure();
    this.updateSplitScroll();
  }
  private updateSplitScroll(): void {
    this.unlinkScroll?.();
    this.unlinkScroll = undefined;
    const view = this.source;
    if (this.mode !== 'split' || !view) return;
    let document: typeof view.state.doc | undefined;
    let offsets: number[] = [];
    this.unlinkScroll = linkSplitScroll(this.sourceRoot, this.richRoot, view, () => this.crepe.editor.action(ctx => {
      if (document !== view.state.doc) {
        document = view.state.doc;
        offsets = ctx.get(remarkCtx).parse(document.toString()).children.flatMap(block => {
          const offset = block.position?.start.offset;
          return block.type === 'heading' && offset !== undefined ? [offset] : [];
        });
      }
      const elements = ctx.get(editorViewCtx).dom.querySelectorAll<HTMLElement>(':scope > :is(h1,h2,h3,h4,h5,h6)');
      return { offsets, elements };
    }));
  }
  private editsSource(): boolean { return this.mode === 'source' || this.mode === 'split'; }
  setReadonly(value: boolean): void {
    this.readonlyState = value;
    if (!this.mounted) return;
    this.crepe.setReadonly(value || this.mode !== 'rich');
    const readonly = value || !this.editsSource();
    this.source?.dispatch({ effects: this.editable.reconfigure([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]) });
  }
  insert(markdown: string): void {
    if (this.editsSource() && this.source) this.source.dispatch(this.source.state.replaceSelection(markdown));
    else this.crepe.editor.action(insert(markdown));
  }
  async destroy(): Promise<void> {
    this.unlinkScroll?.();
    this.mounted = false; this.diagrams.destroy(); this.source?.destroy(); await this.crepe.destroy();
    this.undo.destroy(); this.awareness.destroy(); this.doc.destroy();
  }
}
