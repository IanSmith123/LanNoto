import { checked } from './api';
export async function download(response: Response, fallback: string): Promise<void> {
  await checked(response);
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition);
  const plain = /filename="((?:[^"\\]|\\.)*)"|filename=([^;]+)/i.exec(disposition);
  const filename = encoded ? decodeURIComponent(encoded[1]) : plain ? (plain[1] || plain[2]).replace(/\\(["\\])/g, '$1').trim() : fallback;
  const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
