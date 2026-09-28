import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('authenticated shared text, replacement, limits and restart persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-test-'));
  let child;
  let base;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: import.meta.dirname,
      env: { ...process.env, CLIPBOARD_STATE_DIR: dir, HOST: '127.0.0.1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const output = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited: ${code}`)));
      child.stdout.once('data', (data) => resolve(data.toString()));
    });
    base = `http://127.0.0.1:${output.match(/port (\d+)/)[1]}`;
  }
  async function stop() {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    child = null;
  }
  try {
    await start();
    const key = (await readFile(join(dir, 'access-token'), 'utf8')).trim();
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'text/plain' };
    const get = () => fetch(`${base}/api/text`, { headers });
    const put = (body, extra = {}) => fetch(`${base}/api/text`, { method: 'PUT', headers: { ...headers, ...extra }, body });
    assert.equal((await fetch(base)).status, 200);
    assert.match(await (await fetch(base)).text(), /<title>功能页<\/title>/);
    assert.equal((await fetch(`${base}/clipboard/`)).status, 200);
    assert.equal((await fetch(`${base}/clipboard/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/api/text`)).status, 401);
    assert.equal((await fetch(`${base}/api/text`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await get()).headers.get('cache-control'), 'no-store');
    assert.equal((await (await get()).json()).text, '');
    assert.equal((await put('first')).status, 200);
    const latest = '中文剪贴板\nsecond <script>alert(1)</script>\t🙂';
    assert.equal((await put(latest)).status, 200);
    assert.equal((await (await get()).json()).text, latest);
    assert.equal((await put('bad', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await put('bad', { 'Content-Type': 'application/json' })).status, 415);
    assert.equal((await put('x'.repeat(2 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await (await get()).json()).text, latest);
    await stop();
    await start();
    assert.equal((await readFile(join(dir, 'access-token'), 'utf8')).trim(), key);
    assert.equal((await (await get()).json()).text, latest);
    assert.equal((await put('')).status, 200);
    assert.equal((await (await get()).json()).text, '');
  } finally {
    if (child) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
