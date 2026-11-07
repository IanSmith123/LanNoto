import { diffChars } from 'diff';

// Map UTF-16 boundaries through a standard diff without rebuilding text.
export function mapOffset(from: string, to: string): (position: number) => number {
  const changes = diffChars(from, to);
  return position => {
    let old = 0, next = 0;
    for (const change of changes) {
      if (change.added) { next += change.value.length; continue; }
      if (position < old + change.value.length) return change.removed ? next : next + position - old;
      old += change.value.length;
      if (!change.removed) next += change.value.length;
    }
    return next;
  };
}
