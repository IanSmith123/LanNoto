import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { mapOffset } from './markdown-offset';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

// Inline carets use the shared Markdown's relative positions in both views.
// A rendered selection inside hidden Markdown punctuation maps to its nearest
// visible text boundary, while its authoritative position remains in Y.Text.
export function visible(doc: Node, end = doc.content.size): string { return doc.textBetween(0, end, '\n\n', '\ufffc'); }
export function richPosition(doc: Node, plainOffset: number): number {
  let lo = 0, hi = doc.content.size;
  while (lo < hi) { const middle = Math.floor((lo + hi) / 2); if (visible(doc, middle).length < plainOffset) lo = middle + 1; else hi = middle; }
  return lo;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function identifier(value: unknown): boolean { return value == null || object(value) && Number.isSafeInteger(value.client) && Number.isSafeInteger(value.clock) && Number(value.client) >= 0 && Number(value.clock) >= 0; }
function relative(value: unknown): Y.RelativePosition | undefined {
  if (!object(value) || !identifier(value.type) || !identifier(value.item) || value.tname != null && typeof value.tname !== 'string' || value.assoc != null && !Number.isSafeInteger(value.assoc)) return;
  return Y.createRelativePositionFromJSON(value);
}
export function peerSelection(text: Y.Text, state: unknown): { anchor: number; head: number } | undefined {
  if (!text.doc || !object(state) || !object(state.cursor)) return;
  const anchorRelative = relative(state.cursor.anchor), headRelative = relative(state.cursor.head);
  if (!anchorRelative || !headRelative) return;
  const anchor = Y.createAbsolutePositionFromRelativePosition(anchorRelative, text.doc);
  const head = Y.createAbsolutePositionFromRelativePosition(headRelative, text.doc);
  if (anchor?.type === text && head?.type === text) return { anchor: anchor.index, head: head.index };
}

export function markdownPresence(text: Y.Text, awareness: Awareness): Plugin {
  let version = 0, cachedVersion = -1;
  let cachedDoc: Node | undefined, cached = DecorationSet.empty;
  return new Plugin({
    props: { decorations: state => {
      if (cachedDoc === state.doc && cachedVersion === version) return cached;
      cachedDoc = state.doc; cachedVersion = version;
      const decorations: Decoration[] = [], markdown = text.toString(), plain = visible(state.doc), toPlain = mapOffset(markdown, plain);
      for (const [id, raw] of awareness.getStates()) {
        const peer: unknown = raw;
        if (id === awareness.clientID || !object(peer)) continue;
        const selection = peerSelection(text, peer);
        if (!selection) continue;
        const a = richPosition(state.doc, toPlain(selection.anchor)), h = richPosition(state.doc, toPlain(selection.head));
        const user = object(peer.user) ? peer.user : {};
        const color = typeof user.color === 'string' && /^#[\da-f]{6}$/i.test(user.color) ? user.color : '#2563eb';
        if (a !== h) decorations.push(Decoration.inline(Math.min(a, h), Math.max(a, h), { class: 'ProseMirror-yjs-selection', style: `background-color:${color}55` }));
        decorations.push(Decoration.widget(h, () => {
          const caret = document.createElement('span'); caret.className = 'ProseMirror-yjs-cursor'; caret.style.borderColor = color;
          caret.dataset.peerCursor = String(id);
          const name = document.createElement('div'); name.textContent = typeof user.name === 'string' ? user.name : ''; name.style.backgroundColor = color; caret.append(name); return caret;
        }, { key: `markdown-cursor-${id}-${String(user.name)}-${h}` }));
      }
      cached = DecorationSet.create(state.doc, decorations); return cached;
    } },
    view: view => {
      let disposed = false, scheduled = false;
      const changed = () => {
        version++;
        if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; if (!disposed) view.dispatch(view.state.tr.setMeta('markdown-presence', true)); }); }
      };
      const publish = () => {
        if (!view.hasFocus()) return;
        const markdown = text.toString(), plain = visible(view.state.doc), selection = view.state.selection, toSource = mapOffset(plain, markdown);
        const anchor = Y.createRelativePositionFromTypeIndex(text, toSource(visible(view.state.doc, selection.anchor).length));
        const head = Y.createRelativePositionFromTypeIndex(text, toSource(visible(view.state.doc, selection.head).length));
        const previous = awareness.getLocalState()?.cursor;
        if (!previous || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(previous.anchor), anchor) || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(previous.head), head)) awareness.setLocalStateField('cursor', { anchor, head });
      };
      awareness.on('change', changed);
      view.dom.addEventListener('focusin', publish);
      const blur = () => { queueMicrotask(() => { if (!disposed && !view.hasFocus() && awareness.getLocalState()?.cursor) awareness.setLocalStateField('cursor', null); }); };
      view.dom.addEventListener('focusout', blur);
      return { update: publish, destroy: () => { disposed = true; awareness.off('change', changed); view.dom.removeEventListener('focusin', publish); view.dom.removeEventListener('focusout', blur); } };
    },
  });
}
