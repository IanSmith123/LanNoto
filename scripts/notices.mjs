// Rebuild the distributed notices from the exact locally installed dependencies.
// Missing license texts stop the command; SPDX labels alone are not substitutes.
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const licenseName = /^(licen[cs]e|copying|notice|ofl|copyright)([.\-_]|$)/i;
const sections = []; const missing = [];
async function collect(directory, prefix = '', depth = 0) {
  const texts = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name); const relative = prefix + entry.name;
    if (entry.isFile() && licenseName.test(entry.name)) texts.push(`--- ${relative} ---\n${await readFile(path, 'utf8')}`);
    else if (entry.isDirectory() && depth < 3) texts.push(...await collect(path, relative + '/', depth + 1));
  }
  return texts;
}
async function add(name, version, directory, metadata = '') {
  const texts = await collect(directory);
  if (name === 'remark-math' && version === '6.0.0') texts.push('--- upstream license (d5d0660b150810a535bbb07eac6cc96a4510aa24/license) ---\n' + await readFile(join(root, 'licenses/upstream/remark-math-6.0.0.txt'), 'utf8'));
  if (texts.length === 0) { missing.push(`${name}@${version}`); return; }
  sections.push(`===== ${name} @ ${version} =====\n${metadata}\n\n${texts.join('\n\n')}`);
}
const lock = JSON.parse(await readFile(join(root, 'web/package-lock.json'), 'utf8'));
for (const [path, locked] of Object.entries(lock.packages)) {
  if (!path || locked.dev) continue;
  const directory = join(root, 'web', path);
  try { await stat(directory); } catch (error) { if (error.code === 'ENOENT' && locked.optional) continue; throw error; }
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== locked.version) throw new Error(`Installed version differs from lock: ${path}`);
  await add(pkg.name, pkg.version, directory, `npm license: ${pkg.license}\nSource: ${typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? locked.resolved}`);
}
const modules = execFileSync('go', ['list', '-deps', '-f', '{{if .Module}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}', './cmd/lannoto'], { cwd: root, encoding: 'utf8' });
for (const line of new Set(modules.trim().split(/\r?\n/).filter(Boolean))) {
  const [name, version, directory] = line.split('\t');
  if (name === 'lannoto') continue;
  await add(name, version, directory, `Go module: ${name}`);
}
const goroot = execFileSync('go', ['env', 'GOROOT'], { cwd: root, encoding: 'utf8' }).trim();
sections.push(`===== Go standard library =====\n\n${await readFile(join(goroot, 'LICENSE'), 'utf8')}`);
// Read copyright and Reserved Font Names from the actual shipped TTF name
// tables. The KaTeX code license does not replace the fonts' embedded OFL.
const fontDirectory = join(root, 'web/node_modules/katex/dist/fonts');
for (const filename of (await readdir(fontDirectory)).filter(name => name.endsWith('.ttf')).sort()) {
  const data = await readFile(join(fontDirectory, filename)); const names = new Set();
  for (let index = 0; index < data.readUInt16BE(4); index++) {
    const table = 12 + index * 16;
    if (data.toString('ascii', table, table + 4) !== 'name') continue;
    const offset = data.readUInt32BE(table + 8); const base = offset + data.readUInt16BE(offset + 4);
    for (let item = 0; item < data.readUInt16BE(offset + 2); item++) {
      const record = offset + 6 + item * 12; const platform = data.readUInt16BE(record); const key = data.readUInt16BE(record + 6);
      if (![0, 13, 14].includes(key)) continue;
      const start = base + data.readUInt16BE(record + 10); const length = data.readUInt16BE(record + 8);
      const raw = Buffer.from(data.subarray(start, start + length));
      names.add(platform === 0 || platform === 3 ? raw.swap16().toString('utf16le') : raw.toString('latin1'));
    }
  }
  if (![...names].some(name => name.includes('SIL Open Font License'))) throw new Error(`Unreviewed font license: ${filename}`);
  sections.push(`===== KaTeX font: ${filename} =====\n${[...names].join('\n\n')}`);
}
const ofl = await readFile(join(root, 'licenses/upstream/OFL-1.1.txt'), 'utf8');
sections.push('===== SIL Open Font License 1.1 (for the above fonts) =====\nSource: https://openfontlicense.org/documents/OFL.txt\n\n' + ofl.slice(ofl.indexOf('SIL OPEN FONT LICENSE Version 1.1')));
if (missing.length) throw new Error('Missing full license texts:\n' + missing.join('\n'));
await mkdir(join(root, 'licenses'), { recursive: true });
await writeFile(join(root, 'licenses/THIRD_PARTY.txt'), 'LanNoto dependency license texts\nGenerated by node scripts/notices.mjs from package-lock.json and go.mod.\nIncludes production npm dependency closure (a conservative superset of bundled modules), Go modules and Go standard library.\n\n' + sections.join('\n\n'));
console.log(`Wrote ${sections.length} component notices to licenses/THIRD_PARTY.txt`);
