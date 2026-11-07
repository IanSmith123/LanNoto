import { $remark } from '@milkdown/kit/utils';

interface Block { type: string; children?: Block[]; position?: { start: { offset?: number }; end: { offset?: number } } }

// Preserve whitespace in the visual projection without inserting HTML into
// the authoritative Markdown. Lists and quotations use the same block gaps.
export const blankLines = $remark('lannoto-blank-lines', () => () => (tree, file) => {
  const source = String(file.value);
  function preserve(root: Block): void {
    if (!root.children) return;
    for (const child of root.children) preserve(child);
    if (!['root', 'blockquote', 'listItem'].includes(root.type)) return;
    const output: Block[] = [];
    const add = (gap: string, boundary: number) => {
      const whitespace = root.type === 'root' ? gap : gap.replace(/^[ \t>]+/gm, '');
      if (!/^\s*$/.test(whitespace)) return;
      const lines = (whitespace.match(/\n/g) || []).length;
      for (let i = 0; i < Math.ceil(Math.max(0, lines - boundary) / 2); i++) output.push({ type: 'paragraph', children: [] });
    };
    let end = root.position?.start.offset ?? 0;
    for (const child of root.children) {
      const start = child.position?.start.offset;
      if (start !== undefined && (output.length || root.type === 'root')) add(source.slice(end, start), output.length ? 2 : 0);
      output.push(child); end = child.position?.end.offset ?? end;
    }
    if (root.type === 'root') add(source.slice(end), 1);
    root.children = output;
  }
  preserve(tree as Block);
});
