function read(key: string): string | undefined {
  const value = document.cookie.split('; ').find((entry) => entry.startsWith(`${key}=`));
  try { return value ? decodeURIComponent(value.slice(key.length + 1)) : undefined; } catch { return undefined; }
}
export function remember(key: string, value: string): void {
  document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
const names = ['Tom', 'Tim', 'Alex', 'Sam', 'Leo', 'Max', 'Ben', 'Jack', 'Owen', 'Luke', 'Noah', 'Finn', 'Theo'];
function boundedName(value: string): string {
  let result = '';
  for (const point of value.trim()) { const next = result + point; if (next.length > 30 || new TextEncoder().encode(next).length > 80) break; result = next; }
  return result;
}
export let username = boundedName(read('lannoto-name') || '') || names[crypto.getRandomValues(new Uint32Array(1))[0] % names.length];
remember('lannoto-name', username);
export function rename(value: string): void { username = boundedName(value) || username; remember('lannoto-name', username); }
const savedLanguage = read('lannoto-language');
export const language = savedLanguage === 'zh-CN' || savedLanguage === 'en' ? savedLanguage : navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
export function readSidebarTopHeight(): number { return Number(read('lannoto-sidebar-height')); }
export let dark = (read('lannoto-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
function applyTheme(): void { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }
export function toggleTheme(): void { dark = !dark; remember('lannoto-theme', dark ? 'dark' : 'light'); applyTheme(); }
applyTheme();
document.documentElement.lang = language;
