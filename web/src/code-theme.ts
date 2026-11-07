import { EditorView } from '@codemirror/view';

// Use our public theme variables for both editing views and reset them to
// light paper colors in the standalone print view.
export const codeTheme = EditorView.theme({
  '&': { color: 'var(--code-foreground, #111)', backgroundColor: 'var(--code-background, #f7f7f7)' },
  '.cm-gutters': { color: 'var(--code-foreground, #666)', backgroundColor: 'var(--code-background, #f7f7f7)' },
  '.cm-cursor': { borderLeftColor: 'var(--code-foreground, #111)' },
}, { dark: false });
