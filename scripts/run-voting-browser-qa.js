import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local-only verification. It never modifies the public JSON or voting config.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'codex28-voting-qa-'));
const processes = [];
function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  processes.push(child);
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Local server exited before ${url} was ready`);
    try { await fetch(url); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error(`Local server unavailable: ${url}`);
}
try {
  const publicRoot = join(temporary, 'site');
  await mkdir(publicRoot);
  await cp(join(root, 'dist'), join(publicRoot, 'codex-28'), { recursive: true });
  const staticServer = start('python3', ['-m', 'http.server', '4173', '--bind', '127.0.0.1', '--directory', publicRoot]);
  const api = start(process.execPath, ['scripts/voting-dev-server.js'], { VOTING_DEV_DB: join(temporary, 'votes.sqlite'), VOTING_DEV_PORT: '8787', VOTING_DEV_NOW: '2026-10-08T20:09:00.000Z' });
  await Promise.all([ready('http://127.0.0.1:4173/codex-28/', staticServer), ready('http://127.0.0.1:8787/', api)]);
  const browser = start('python3', ['scripts/voting-browser-qa.py'], { VOTING_SITE_URL: 'http://127.0.0.1:4173/codex-28/' });
  process.exitCode = await new Promise((resolve, reject) => { browser.once('exit', code => resolve(code ?? 1)); browser.once('error', reject); });
} finally {
  await Promise.all(processes.filter(child => child.exitCode === null).map(child => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); })));
  await rm(temporary, { recursive: true, force: true });
}
