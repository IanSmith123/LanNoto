export function labelIcon(button: HTMLButtonElement, label: string, path: string): void {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(ns, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  button.replaceChildren(svg);
  button.title = label;
  button.setAttribute('aria-label', label);
}
