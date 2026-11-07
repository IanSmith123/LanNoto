import { t } from './i18n';
import { readSidebarTopHeight, remember } from './preferences';

export function sidebarResize(top: HTMLElement, files: HTMLElement, outline: HTMLElement): HTMLElement {
  const handle = document.createElement('div');
  handle.className = 'sidebar-resize';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-label', t('调整文件列表高度'));
  handle.setAttribute('aria-controls', top.id);

  const apply = (height: number) => {
    top.style.setProperty('--sidebar-top-height', `${height}px`);
    top.dataset.resized = '';
  };
  const savedHeight = readSidebarTopHeight();
  if (Number.isFinite(savedHeight) && savedHeight > 0) apply(savedHeight);

  const limits = () => {
    const max = Math.max(0, top.offsetHeight + outline.offsetHeight - 72);
    const min = Math.min(max, top.offsetHeight - files.offsetHeight + 48);
    return { min, max };
  };
  const announceSize = () => {
    const { min, max } = limits();
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(top.offsetHeight));
  };
  const setHeight = (height: number) => {
    const { min, max } = limits();
    const next = Math.round(Math.max(min, Math.min(max, height)));
    apply(next);
    announceSize();
    return next;
  };
  handle.addEventListener('focus', announceSize);

  let drag: { pointer: number; y: number; height: number } | undefined;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, y: event.clientY, height: top.offsetHeight };
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.pointer === event.pointerId) setHeight(drag.height + event.clientY - drag.y);
  });
  handle.addEventListener('pointerup', event => {
    if (drag?.pointer === event.pointerId) remember('lannoto-sidebar-height', String(top.offsetHeight));
  });
  handle.addEventListener('lostpointercapture', () => { drag = undefined; });
  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const height = setHeight(top.offsetHeight + (event.key === 'ArrowUp' ? -24 : 24));
    remember('lannoto-sidebar-height', String(height));
  });
  return handle;
}
