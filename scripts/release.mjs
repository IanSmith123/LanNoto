import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await stat(join(root, 'internal/webassets/dist/index.html'));
const buildID = (await readFile(join(root, 'internal/webassets/dist/build-id.txt'), 'utf8')).trim();
if (!/^[0-9a-f-]{36}$/.test(buildID)) throw new Error('Missing valid frontend build identity; build the frontend first');
execFileSync(process.execPath, ['scripts/notices.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
const releases = join(root, 'dist/releases'); await mkdir(releases, { recursive: true });
const notices = await readFile(join(root, 'licenses/THIRD_PARTY.txt'), 'utf8');
const readme = `# LanNoto

Run \`lannoto.exe\` on Windows or \`./lannoto\` on Linux and macOS from the directory where you want to keep your workspace. Open http://localhost:8080 and sign in with the password printed at startup. Word export requires Pandoc on the host.

在希望存放笔记的目录运行程序，访问 http://localhost:8080，用启动日志中的密码登录。Word 导出需要主机安装 Pandoc。

[English documentation](https://github.com/IanSmith123/LanNoto/blob/main/README.md) · [中文文档](https://github.com/IanSmith123/LanNoto/blob/main/readme_zh.md)

Frontend build: ${buildID}

<details>
<summary>Third-party licenses / 第三方许可</summary>

${notices.trimEnd().replace(/^/gm, '    ')}

</details>
`;
const checksums = [];
const targets = [
  ['linux', 'amd64'],
  ['linux', 'arm64'],
  ['linux', '386'],
  ['linux', 'arm', '7'],
  ['windows', 'amd64'],
  ['windows', 'arm64'],
  ['windows', '386'],
  ['darwin', 'amd64'],
  ['darwin', 'arm64'],
];
const stage = await mkdtemp(join(releases, '.stage-'));
try {
  await writeFile(join(stage, 'README.md'), readme);
  for (const [os, arch, arm] of targets) {
    const platform = arm ? arch + 'v' + arm : arch;
    const archive = `lannoto-${os}-${platform}.tar.gz`;
    const binary = os === 'windows' ? 'lannoto.exe' : 'lannoto';
    const executable = join(stage, binary);
    execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', executable, './cmd/lannoto'], { cwd: root, env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch, GOARM: arm ?? '' }, stdio: 'inherit', windowsHide: true });
    if ((await readFile(executable)).includes(Buffer.from('LANNOTO_TEST_FAULT_DIR'))) throw new Error('Refusing to package a fault-test binary');
    execFileSync('tar', ['-czf', join(releases, archive), '-C', stage, binary, 'README.md'], { cwd: root, stdio: 'inherit', windowsHide: true });
    checksums.push(`${createHash('sha256').update(await readFile(join(releases, archive))).digest('hex')}  ${archive}`);
    console.log(`Packaged ${archive}`);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
await writeFile(join(releases, 'SHA256SUMS'), checksums.join('\n') + '\n');
