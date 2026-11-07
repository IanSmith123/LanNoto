import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { expect } from '@playwright/test';

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('No test listener address');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function workspace(): Promise<string> {
  const artifacts = resolve('../tests/artifacts');
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(join(artifacts, 'process-'));
  await mkdir(join(cwd, 'note'));
  await writeFile(join(cwd, 'note', '恢复测试.md'), '# 恢复测试\n\n初始正文。\n');
  return cwd;
}

export async function boot(cwd: string, password: string | null = 'process-test-password', port?: number, options?: { path?: string; env?: NodeJS.ProcessEnv; executable?: string }) {
  const listenPort = port ?? await availablePort();
  const args = ['--host', '127.0.0.1', '--port', String(listenPort)];
  if (password !== null) args.push('--password', password);
  if (options?.path) args.push('--pandoc', options.path);
  const child = spawn(options?.executable ?? resolve(`../dist/lannoto${process.platform === 'win32' ? '.exe' : ''}`), args, { cwd, windowsHide: true, env: { ...process.env, ...options?.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const url = `http://127.0.0.1:${listenPort}`;
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error('Test service exited before readiness');
    try { return (await fetch(`${url}/api/config`)).status; }
    catch (error) { if (error instanceof TypeError) return 0; throw error; }
  }, { timeout: 10000 }).toBe(200);
  return { child, exited, port: listenPort, url, logs: () => log, stop: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; } };
}
