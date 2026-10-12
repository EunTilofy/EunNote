import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

const digest = value => createHash('sha256').update(value).digest('hex');
const localAddress = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

export function createSecurity({ dataDir, token, origin = '', behindProxy = false, basePath = '', sessionSeconds = 2592000, rateLimit = 1200, loginLimit = 10 }) {
  const publicOrigin = origin ? new URL(origin).origin : '';
  if (publicOrigin && !publicOrigin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must use HTTPS');
  const sessionsFile = join(dataDir, 'web-sessions.json');
  const keyHash = digest(token);
  let saved;
  try { saved = JSON.parse(readFileSync(sessionsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessions = new Map(saved?.keyHash === keyHash && Array.isArray(saved.sessions) ? saved.sessions : []);
  const requests = new Map();
  const failures = new Map();
  const lifetime = Math.min(30 * 86400, Math.max(60, sessionSeconds)) * 1000;
  const cookieOptions = `Path=${basePath.replace(/\/$/, '')}/; HttpOnly; SameSite=Strict${publicOrigin ? '; Secure' : ''}`;

  function saveSessions() {
    const now = Date.now();
    for (const [id, expires] of sessions) if (!Number.isFinite(expires) || expires <= now) sessions.delete(id);
    writeFileSync(`${sessionsFile}.tmp`, JSON.stringify({ keyHash, sessions: [...sessions] }), { mode: 0o600 });
    renameSync(`${sessionsFile}.tmp`, sessionsFile);
  }
  saveSessions();

  function cookieId(req) {
    const value = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('note_session='))?.slice(13) || '';
    return /^[a-f0-9]{64}$/.test(value) ? digest(value) : '';
  }
  function authenticated(req) {
    if (sameSecret(req.headers.authorization, `Bearer ${token}`)) return true;
    const id = cookieId(req);
    return Boolean(id && sessions.get(id) > Date.now());
  }
  function clientIp(req) {
    if (behindProxy && localAddress(req.socket.remoteAddress) && isIP(req.headers['x-real-ip'] || '')) return req.headers['x-real-ip'];
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }
  function bucket(map, key, period) {
    const now = Date.now();
    let entry = map.get(key);
    if (!entry || entry.until <= now) {
      if (map.size >= 10000) {
        for (const [id, value] of map) if (value.until <= now) map.delete(id);
        if (map.size >= 10000) map.delete(map.keys().next().value);
      }
      entry = { count: 0, until: now + period };
      map.set(key, entry);
    }
    return entry;
  }
  function check(req) {
    if (behindProxy && !localAddress(req.socket.remoteAddress)) return { status: 403, error: '请通过网站的 HTTPS 入口访问。' };
    const health = req.url === '/healthz';
    if (publicOrigin && !health) {
      if (req.headers.host !== new URL(publicOrigin).host) return { status: 421, error: '访问地址无效。' };
      if (behindProxy && req.headers['x-forwarded-proto'] !== 'https') return { status: 400, error: '请使用 HTTPS。' };
    }
    if (!req.url?.startsWith('/')) return { status: 400, error: '请求地址无效。' };
    const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== expectedOrigin) return { status: 403, error: '不允许跨站访问。' };
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') return { status: 403, error: '不允许跨站访问。' };
    if (Number(req.headers['content-length']) > 8 * 1024 * 1024) return { status: 413, error: '请求内容过大。' };
    const current = bucket(requests, clientIp(req), 60000);
    if (++current.count > rateLimit) return { status: 429, error: '请求过于频繁，请稍后再试。' };
    return null;
  }
  function login(req, res, candidate) {
    const ip = clientIp(req);
    const current = bucket(failures, ip, 15 * 60000);
    const global = bucket(failures, '*', 60000);
    if (current.count >= loginLimit || global.count >= 100) return 429;
    if (typeof candidate !== 'string' || !sameSecret(candidate, token)) {
      current.count++;
      global.count++;
      return 401;
    }
    failures.delete(ip);
    const secret = randomBytes(32).toString('hex');
    if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
    sessions.set(digest(secret), Date.now() + lifetime);
    saveSessions();
    const cookie = `note_session=${secret}; ${cookieOptions}; Max-Age=${Math.floor(lifetime / 1000)}`;
    res.setHeader('Set-Cookie', basePath ? [cookie, 'note_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0'] : cookie);
    return 200;
  }
  function logout(req, res) {
    const id = cookieId(req);
    sessions.delete(id);
    saveSessions();
    const cookie = `note_session=; ${cookieOptions}; Max-Age=0`;
    res.setHeader('Set-Cookie', basePath ? [cookie, 'note_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0'] : cookie);
    return id;
  }
  function socketSession(req) {
    const id = cookieId(req);
    return id && sessions.get(id) > Date.now() ? { id, expires: sessions.get(id) } : null;
  }
  return { authenticated, check, clientIp, login, logout, socketSession, publicOrigin };
}
