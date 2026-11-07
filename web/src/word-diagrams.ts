import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { parserCtx } from '@milkdown/kit/core';
import type { Connection } from './sync';
import { diagramSVG } from './mermaid';
import { APIError } from './api';
import { t } from './i18n';

export async function wordDiagrams(connection: Connection, markdown: string, signal: AbortSignal): Promise<{ source: string; png: string }[]> {
  const sources = new Set<string>();
  connection.editor.crepe.editor.action(ctx => {
    const doc = ctx.get(parserCtx)(markdown);
    if (!doc) throw new Error('Official parser rejected export snapshot');
    doc.descendants(node => { if (node.type === codeBlockSchema.type(ctx) && String(node.attrs.language).toLowerCase() === 'mermaid') sources.add(node.textContent.trim()); });
  });
  const fail = (message: string): never => { throw new APIError(422, 'mermaid_export', t(message)); };
  if (sources.size > 32) fail('Word 最多导出 32 幅 Mermaid 图表');
  const result: { source: string; png: string }[] = []; let total = 0, pixels = 0;
  for (const source of sources) {
    signal.throwIfAborted();
    let svg: string;
    try { svg = await diagramSVG(source); }
    catch (error) { throw new APIError(422, 'mermaid_export', `${t('Mermaid 语法或渲染错误')}\n${error instanceof Error ? error.message : String(error)}`); }
    signal.throwIfAborted();
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const width = parseFloat(root.getAttribute('width') || ''), height = parseFloat(root.getAttribute('height') || '');
    if (!(width > 0 && height > 0)) fail('Mermaid 图片尺寸无效');
    const scale = 2, w = Math.ceil(width * scale), h = Math.ceil(height * scale);
    pixels += w * h;
    if (w * h > 16000000 || pixels > 32000000 || w > 16384 || h > 16384) fail('Mermaid 图片像素超过限制');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const image = new Image(); image.src = url; await image.decode(); signal.throwIfAborted();
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const context = canvas.getContext('2d'); if (!context) fail('Mermaid 图片渲染失败');
      context!.fillStyle = '#fff'; context!.fillRect(0, 0, w, h); context!.drawImage(image, 0, 0, w, h);
      const png = canvas.toDataURL('image/png').split(',')[1];
      canvas.width = canvas.height = 0;
      total += png.length * 3 / 4;
      if (png.length * 3 / 4 > 2 * 1024 * 1024 || total > 8 * 1024 * 1024) fail('Mermaid 图片超过导出大小限制');
      result.push({ source, png });
    } catch (error) {
      if (error instanceof APIError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new APIError(422, 'mermaid_export', `${t('Mermaid 图片渲染失败')}\n${error instanceof Error ? error.message : String(error)}`);
    } finally { URL.revokeObjectURL(url); }
  }
  return result;
}
