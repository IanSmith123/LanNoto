import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve('..');
await mkdir(join(root, 'tests', 'artifacts'), { recursive: true });
const workspace = await mkdtemp(join(process.env.LANNOTO_TEST_WORKSPACE_PARENT || join(root, 'tests', 'artifacts'), 'p1-'));
await mkdir(join(workspace, 'note'));
await writeFile(join(workspace, 'note', '会议纪要.md'), '# 团队会议\n\n待办正文。\n');
await writeFile(join(workspace, 'note', 'Project Notes.md'), '# Project Notes\n\nExisting content.\n');
console.log(`P1 test workspace: ${workspace}`);
const child = spawn(join(root, 'dist', process.platform === 'win32' ? 'lannoto.exe' : 'lannoto'), ['--host', '127.0.0.1', '--port', '18081', '--password', 'p1-test-password'], { cwd: workspace, stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
