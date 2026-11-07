import type { EditorView } from '@codemirror/view';

interface Anchor { source: number; preview: number }

export function linkSplitScroll(
  sourcePane: HTMLElement,
  previewPane: HTMLElement,
  sourceView: EditorView,
  headings: () => { offsets: number[]; elements: NodeListOf<HTMLElement> },
): () => void {
  const mirrored = new WeakMap<HTMLElement, number>();
  let frame = 0;

  const sync = (origin: HTMLElement) => {
    const sourceEnd = sourcePane.scrollHeight - sourcePane.clientHeight;
    const previewEnd = previewPane.scrollHeight - previewPane.clientHeight;
    if (sourceEnd <= 0 || previewEnd <= 0) return;

    // Match section boundaries even when rendered blocks have different heights.
    const anchors: Anchor[] = [{ source: 0, preview: 0 }];
    const { offsets, elements } = headings();
    if (offsets.length === elements.length) {
      const sourceTop = sourceView.documentTop - sourcePane.getBoundingClientRect().top + sourcePane.scrollTop;
      const previewTop = previewPane.getBoundingClientRect().top - previewPane.scrollTop;
      offsets.forEach((offset, index) => {
        const source = sourceTop + sourceView.lineBlockAt(offset).top;
        const preview = elements[index].getBoundingClientRect().top - previewTop;
        const last = anchors[anchors.length - 1];
        if (source > last.source && preview > last.preview && source < sourceEnd && preview < previewEnd) {
          anchors.push({ source, preview });
        }
      });
    }
    anchors.push({ source: sourceEnd, preview: previewEnd });

    const from = origin === sourcePane ? 'source' : 'preview';
    const to = from === 'source' ? 'preview' : 'source';
    const target = from === 'source' ? previewPane : sourcePane;
    const position = Math.max(0, Math.min(origin.scrollTop, anchors[anchors.length - 1][from]));
    const end = anchors.findIndex((anchor, index) => index > 0 && anchor[from] >= position);
    const before = anchors[end - 1], after = anchors[end];
    const fraction = (position - before[from]) / (after[from] - before[from]);
    target.scrollTop = before[to] + fraction * (after[to] - before[to]);
    mirrored.set(target, target.scrollTop);
  };

  const onScroll = (event: Event) => {
    const pane = event.currentTarget as HTMLElement;
    if (mirrored.get(pane) === pane.scrollTop) return;
    mirrored.delete(pane);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => sync(pane));
  };
  sourcePane.addEventListener('scroll', onScroll, { passive: true });
  previewPane.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    sourcePane.removeEventListener('scroll', onScroll);
    previewPane.removeEventListener('scroll', onScroll);
  };
}
