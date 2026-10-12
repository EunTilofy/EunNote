import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createSecurity } from './security.mjs';

const { io } = createRequire(new URL('../shuji/package.json', import.meta.url))('socket.io-client');

test('sessions protect all pages, uploads and game transports; logout and key rotation revoke access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eunnote-security-'));
  const children = new Set();
  let gateway;
  let game;
  let base;
  async function launch(script, env) {
    const child = spawn(process.execPath, [script], { cwd: import.meta.dirname, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.once('exit', () => children.delete(child));
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const output = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
      child.stdout.once('data', data => resolve(data.toString()));
    });
    return { child, output };
  }
  async function startGateway(gamePort = 6358) {
    const started = await launch('server.mjs', { CLIPBOARD_STATE_DIR: directory, HOST: '127.0.0.1', PORT: '0', SHUJI_PORT: String(gamePort), LOGIN_LIMIT: '3', PUBLIC_BASE_PATH: '/eunnote' });
    gateway = started.child;
    base = `http://127.0.0.1:${started.output.match(/port (\d+)/)[1]}/eunnote`;
  }
  async function stop(child) {
    const ended = once(child, 'exit');
    child.kill('SIGTERM');
    await ended;
  }
  let socket;
  try {
    await startGateway();
    const key = (await readFile(join(directory, 'access-token'), 'utf8')).trim();
    const bearer = { Authorization: `Bearer ${key}` };
    for (const path of ['/', '/clipboard/', '/notion/', '/shuji/']) {
      const response = await fetch(base + path, { redirect: 'manual' });
      assert.equal(response.status, 303);
      assert.ok(response.headers.get('location').startsWith('/eunnote/auth/'));
    }
    for (const path of ['/api/text', '/notion/api/state', '/shuji/socket.io/?EIO=4&transport=polling']) {
      assert.equal((await fetch(base + path)).status, 401);
    }
    assert.equal((await fetch(base + '/api/text', { headers: { Cookie: `note_key=${key}` } })).status, 401, 'legacy master-key cookies are rejected');
    const login = async value => fetch(base + '/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: value }) });
    assert.equal((await login('wrong')).status, 401);
    const response = await login(key);
    assert.equal(response.status, 200);
    const cookieHeader = response.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly; SameSite=Strict/);
    assert.match(cookieHeader, /Path=\/eunnote\//);
    assert.match(cookieHeader, /Max-Age=2592000/);
    const page = await (await fetch(base + '/notion/', { headers: { Cookie: cookieHeader.split(';')[0] } })).text();
    assert.match(page, /href="\/eunnote\/"/);
    assert.match(page, /src="\/eunnote\/notion\/app.js"/);
    assert.ok(!cookieHeader.includes(key));
    const cookie = cookieHeader.split(';')[0];
    const headers = { Cookie: cookie };
    assert.equal((await fetch(base + '/notion/', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/text', { headers })).status, 200);
    assert.equal((await fetch(base + '/notion/api/state', { headers: { ...headers, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' } })).status, 403);
    const sessions = await readFile(join(directory, 'web-sessions.json'), 'utf8');
    assert.ok(!sessions.includes(key));
    assert.ok(!sessions.includes(cookie.split('=')[1]));
    assert.equal((await fetch(base + '/notion/api/upload', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: '<script>bad</script>' })).status, 415);
    for (const path of ['/.git/config', '/clipboard/data/access-token', '/notion/../../.ssh/id_ed25519']) {
      assert.equal((await fetch(base + path, { headers })).status, 404);
    }

    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const gamePort = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const gameDir = join(directory, 'game');
    await mkdir(gameDir);
    game = (await launch('../shuji/server.js', { HOST: '127.0.0.1', PORT: String(gamePort), SHUJI_DATA_DIR: gameDir, FUNCTION_KEY_FILE: join(directory, 'access-token'), REQUIRE_FUNCTION_ACCESS: '1', PUBLIC_BASE_PATH: '/eunnote' })).child;
    await stop(gateway);
    await startGateway(gamePort);
    assert.equal((await fetch(base + '/api/text', { headers })).status, 200, 'sessions survive gateway restart');
    assert.equal((await fetch(`http://127.0.0.1:${gamePort}/api/function-access`, { headers: bearer })).status, 401, 'direct backend cannot bypass the gateway');
    assert.equal((await fetch(base + '/shuji/api/function-access', { headers })).status, 200);
    const gamePage = await (await fetch(base + '/shuji/', { headers })).text();
    assert.match(gamePage, /src="\/eunnote\/shuji\/app.js"/);
    assert.match(gamePage, /src="\/eunnote\/auth\/client.js"/);
    await assert.rejects(new Promise((resolve, reject) => {
      const anonymous = io(new URL(base).origin, { path: '/eunnote/shuji/socket.io', transports: ['websocket'], reconnection: false, timeout: 1500 });
      anonymous.once('connect', () => { anonymous.close(); resolve(); });
      anonymous.once('connect_error', error => { anonymous.close(); reject(error); });
    }));
    socket = io(new URL(base).origin, { path: '/eunnote/shuji/socket.io', transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: new URL(base).origin }, auth: { functionKey: 'session' }, reconnection: false, timeout: 3000 });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const pair = await new Promise(resolve => socket.emit('pair:state', {}, resolve));
    assert.equal(pair.ok, true, 'gateway session grants private game access without exposing the master key');
    const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
    assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers })).status, 200);
    await disconnected;
    assert.equal((await fetch(base + '/api/text', { headers })).status, 401, 'logged-out cookies cannot be replayed');
    const another = (await login(key)).headers.get('set-cookie').split(';')[0];
    await stop(gateway);
    await writeFile(join(directory, 'access-token'), randomBytes(24).toString('hex'), { mode: 0o600 });
    await startGateway(gamePort);
    assert.equal((await fetch(base + '/api/text', { headers: bearer })).status, 401);
    assert.equal((await fetch(base + '/api/text', { headers: { Cookie: another } })).status, 401, 'rotating the master key invalidates existing sessions');
    for (let i = 0; i < 3; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('wrong')).status, 429);
    assert.equal((await fetch(base + '/healthz')).status, 200);
  } finally {
    socket?.close();
    await Promise.all([...children].map(stop));
    await rm(directory, { recursive: true, force: true });
  }
});

test('proxy boundary validates the host, transport, origin and trusted client IP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eunnote-proxy-'));
  try {
    const security = createSecurity({ dataDir: directory, token: 'a'.repeat(48), origin: 'https://note.example', behindProxy: true, rateLimit: 20 });
    const request = { url: '/auth/session', method: 'POST', headers: { host: 'note.example', 'x-forwarded-proto': 'https', 'x-real-ip': '192.0.2.1' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(security.check(request), null);
    assert.equal(security.clientIp(request), '192.0.2.1');
    assert.equal(security.check({ ...request, socket: { remoteAddress: '192.0.2.3' } }).status, 403);
    assert.equal(security.check({ ...request, headers: { ...request.headers, host: 'evil.example' } }).status, 421);
    assert.equal(security.check({ ...request, headers: { ...request.headers, 'x-forwarded-proto': 'http' } }).status, 400);
    assert.equal(security.check({ ...request, headers: { ...request.headers, origin: 'https://evil.example' } }).status, 403);
    const response = { setHeader(_name, value) { this.cookie = value; } };
    assert.equal(security.login(request, response, 'a'.repeat(48)), 200);
    assert.match(response.cookie, /; Secure/);
    for (let i = 0; i < 20; i++) security.check(request);
    assert.equal(security.check(request).status, 429);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
