'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { PairStore } = require('./src/pair-store');
const {
  calculateRoundLimit,
  createPlayer,
  generateSecrets,
  playerRank,
  publicPlayer,
  submitGuess,
  validateConfig,
  validateRoundLimit
} = require('./src/game');

const PORT = Number(process.env.PORT) || 6357;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const IDENTITIES_FILE = process.env.IDENTITIES_FILE || path.join(DATA_DIR, 'identities.json');
const PAIR_FILE = process.env.PAIR_FILE || path.join(DATA_DIR, 'pair.json');
const FUNCTION_KEY_FILE = process.env.FUNCTION_KEY_FILE || '';
const rooms = new Map();

let functionKey = '';
if (FUNCTION_KEY_FILE) {
  functionKey = fs.readFileSync(FUNCTION_KEY_FILE, 'utf8').trim();
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const pairStore = new PairStore(PAIR_FILE);

function readIdentities() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(IDENTITIES_FILE, 'utf8'))));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

const identities = readIdentities();

function persistIdentities() {
  const temporary = `${IDENTITIES_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(identities), null, 2));
  fs.renameSync(temporary, IDENTITIES_FILE);
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 16) throw new Error('玩家 ID 需要为 1 到 16 个字符');
  return name;
}

function cleanAvatar(value) {
  if (value === '') return '';
  if (typeof value !== 'string') throw new Error('头像格式不正确');
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('头像仅支持 PNG、JPG、GIF 或 WebP');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 512 * 1024) throw new Error('头像不能超过 512 KB');
  const signatures = {
    png: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    gif: ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')),
    webp: bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  };
  if (!signatures[match[1]]) throw new Error('头像图片内容无效');
  return value;
}

function clientIp(socket) {
  const forwarded = String(socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || String(socket.handshake.address || '')).replace(/^::ffff:/, '');
}

function fixedName(socket, requestedName) {
  const ip = clientIp(socket);
  const existing = identities.get(ip);
  if (existing) return existing;
  const name = cleanName(requestedName);
  identities.set(ip, name);
  persistIdentities();
  return name;
}

function playerName(socket, requestedName, fallback = '玩家') {
  const slot = socket.data.pairSlot && pairStore.state.slots[socket.data.pairSlot];
  return slot?.name || fixedName(socket, requestedName || fallback);
}

function validFunctionKey(candidate) {
  const actual = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(functionKey);
  return Boolean(functionKey) && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) code += alphabet[crypto.randomInt(0, alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('暂时无法创建房间，请稍后再试');
}

function serializeRoom(room, viewerId) {
  const reveal = room.status === 'finished';
  const viewer = room.players.get(viewerId);
  return {
    code: room.code,
    mode: room.mode,
    pairMode: room.pairMode,
    directPair: room.directPair,
    status: room.status,
    hostId: room.hostId,
    targetCount: room.targetCount,
    length: room.length,
    roundLimit: room.roundLimit,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    viewerId,
    viewer: viewer ? { ...publicPlayer(viewer, true), token: viewer.token } : null,
    players: playerRank(room.players.values()).map((player) =>
      publicPlayer(player, reveal || player.id === viewerId)
    ),
    secrets: reveal ? room.secrets : undefined
  };
}

function emitRoom(room) {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit('room:update', serializeRoom(room, player.id));
  }
}

function emitPairUpdate() {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.functionAccess) socket.emit('pair:update');
  }
}

function emitToPairSlot(side, event, payload) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.functionAccess && socket.data.pairSlot === side) socket.emit(event, payload);
  }
}

function waitingDirectRoom() {
  return [...rooms.values()].find((room) => room.directPair && room.status === 'lobby') || null;
}

function directDuelFor(side) {
  if (!side) return null;
  const room = waitingDirectRoom();
  if (!room) return null;
  const host = [...room.players.values()][0];
  if (!host) return null;
  return {
    role: host.pairSlot === side ? 'host' : 'invitee',
    hostSide: host.pairSlot,
    hostName: host.name,
    createdAt: room.createdAt,
    targetCount: room.targetCount,
    length: room.length,
    roundLimit: room.roundLimit
  };
}

function removeWaitingDirectRoom(room) {
  for (const player of room.players.values()) {
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
  rooms.delete(room.code);
}

function historyPlayer(player) {
  return JSON.parse(JSON.stringify(publicPlayer(player, true)));
}

function historyOpponent(player, room) {
  return {
    name: player.name,
    avatar: player.avatar || '',
    slot: player.pairSlot,
    solvedCount: player.solved.filter(Boolean).length,
    guessesUsed: player.guesses.length,
    won: player.solved.every(Boolean),
    failed: player.failed,
    targetCount: room.targetCount
  };
}

function historyRecord(room, player, opponent = null) {
  return {
    id: randomId(12),
    matchId: room.historyMatchId,
    mode: room.mode === 'solo' ? 'solo' : 'pair',
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    targetCount: room.targetCount,
    length: room.length,
    roundLimit: room.roundLimit,
    won: player.solved.every(Boolean),
    failed: player.failed,
    solvedCount: player.solved.filter(Boolean).length,
    guessesUsed: player.guesses.length,
    secrets: [...room.secrets],
    player: historyPlayer(player),
    opponent: opponent ? historyOpponent(opponent, room) : null
  };
}

function saveRoomHistory(room) {
  if (room.historyRecorded) return;
  room.historyRecorded = true;
  const players = [...room.players.values()];
  const entries = [];
  if (room.mode === 'solo' && players.length === 1 && players[0].pairSlot) {
    entries.push({ side: players[0].pairSlot, record: historyRecord(room, players[0]) });
  } else if (room.mode === 'multi' && players.length === 2) {
    const sides = new Set(players.map((player) => player.pairSlot));
    if (sides.size === 2 && sides.has('left') && sides.has('right')) {
      entries.push({ side: players[0].pairSlot, record: historyRecord(room, players[0], players[1]) });
      entries.push({ side: players[1].pairSlot, record: historyRecord(room, players[1], players[0]) });
    }
  }
  pairStore.addHistories(entries);
  if (entries.length) emitPairUpdate();
}

function finishRoom(room) {
  if (room.status === 'finished') return;
  room.status = 'finished';
  room.finishedAt = Date.now();
  saveRoomHistory(room);
}

function maybeFinishRoom(room) {
  const players = [...room.players.values()];
  if (room.status === 'playing' && players.length && players.every((player) => player.finishedAt)) {
    finishRoom(room);
  }
}

function findPlayer(room, token) {
  return [...room.players.values()].find((player) => player.token === token);
}

function addPlayer(room, name, socket) {
  if (room.status !== 'lobby') throw new Error('游戏已经开始，无法加入');
  if (room.pairMode) {
    if (!socket.data.functionAccess || !socket.data.pairSlot) throw new Error('这是双人空间的房间，请通过带 key 的链接进入');
    if (room.players.size >= 2) throw new Error('双人房间已经满了');
    if ([...room.players.values()].some((item) => item.pairSlot === socket.data.pairSlot)) {
      throw new Error('这一侧已经在房间里了');
    }
  } else if (room.players.size >= 30) {
    throw new Error('房间人数已满');
  }

  const player = createPlayer(randomId(8), name, room.targetCount);
  player.pairSlot = socket.data.pairSlot || null;
  player.avatar = player.pairSlot ? pairStore.state.slots[player.pairSlot]?.avatar || '' : '';
  player.token = randomId();
  player.socketId = socket.id;
  room.players.set(player.id, player);
  socket.join(room.code);
  return player;
}

function leaveRoom(room, player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
  player.connected = false;
  player.socketId = null;
  if (room.status === 'lobby') {
    room.players.delete(player.id);
    if (room.hostId === player.id) room.hostId = room.players.keys().next().value || null;
    if (!room.players.size) rooms.delete(room.code);
  } else if (room.status === 'playing' && !player.finishedAt) {
    player.failed = true;
    player.finishedAt = Date.now();
    maybeFinishRoom(room);
  }
}

function disconnectPlayer(room, player) {
  player.connected = false;
  player.socketId = null;
  if (room.status === 'lobby') {
    player.disconnectTimer = setTimeout(() => {
      if (room.status !== 'lobby' || player.connected) return;
      const cancelledDirectPair = room.directPair && player.pairSlot;
      leaveRoom(room, player);
      if (cancelledDirectPair) {
        const otherSide = player.pairSlot === 'left' ? 'right' : 'left';
        emitToPairSlot(otherSide, 'pair:duel-notice', { message: '对方取消了这场比赛' });
        emitPairUpdate();
      }
      if (rooms.has(room.code)) emitRoom(room);
    }, 30_000);
    player.disconnectTimer.unref();
  } else if (room.status === 'playing' && !player.finishedAt) {
    player.failed = true;
    player.finishedAt = Date.now();
    maybeFinishRoom(room);
  }
}

function newRoom({ code, mode, targetCount, length, roundLimit, status, pairMode = false, directPair = false, secrets = null }) {
  const effectiveRoundLimit = Number.isInteger(roundLimit)
    ? roundLimit
    : calculateRoundLimit(targetCount, length);
  validateRoundLimit(effectiveRoundLimit);
  return {
    code,
    mode,
    status,
    hostId: null,
    targetCount,
    length,
    roundLimit: effectiveRoundLimit,
    secrets: secrets ? [...secrets] : generateSecrets(targetCount, length),
    pairMode,
    directPair,
    historyMatchId: randomId(12),
    historyRecorded: false,
    players: new Map(),
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, rooms: rooms.size, uptime: Math.floor(process.uptime()) });
});

app.get('/api/function-access', (request, response) => {
  response.set('Cache-Control', 'no-store');
  const authorization = request.get('authorization') || '';
  if (!authorization.startsWith('Bearer ') || !validFunctionKey(authorization.slice(7))) {
    return response.status(401).json({ ok: false });
  }
  response.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.data.functionAccess = validFunctionKey(socket.handshake.auth?.functionKey);
  socket.data.pairSlot = socket.data.functionAccess
    ? pairStore.resolve(socket.handshake.auth?.pairToken)
    : null;

  const handle = (callback, action) => {
    try {
      action();
    } catch (error) {
      callback({ ok: false, error: error.message || '操作失败' });
    }
  };

  const requirePairAccess = () => {
    if (!socket.data.functionAccess) throw new Error('访问 key 无效');
  };

  const requireClaimedSlot = () => {
    requirePairAccess();
    if (!socket.data.pairSlot) throw new Error('请先认领左边或右边');
    return socket.data.pairSlot;
  };

  const requireNoPendingDuel = () => {
    if (socket.data.pairSlot && waitingDirectRoom()) {
      throw new Error('请先进入“直接对战”处理当前邀请');
    }
  };

  socket.on('pair:state', (_payload, callback) => handle(callback, () => {
    if (!socket.data.functionAccess) {
      callback({ ok: true, privateMode: false });
      return;
    }
    const pending = waitingDirectRoom();
    const pendingHost = pending && [...pending.players.values()][0];
    if (pendingHost?.pairSlot === socket.data.pairSlot && !pendingHost.connected) {
      if (pendingHost.disconnectTimer) clearTimeout(pendingHost.disconnectTimer);
      pendingHost.disconnectTimer = null;
      pendingHost.connected = true;
      pendingHost.socketId = socket.id;
      socket.join(pending.code);
    }
    callback({
      ok: true,
      privateMode: true,
      pair: pairStore.publicState(socket.data.pairSlot),
      duel: directDuelFor(socket.data.pairSlot)
    });
  }));

  socket.on('pair:claim', (payload, callback) => handle(callback, () => {
    requirePairAccess();
    const side = String(payload.side || '');
    const existing = pairStore.state.slots[side];
    const name = existing?.name || cleanName(payload.name);
    const claimed = pairStore.claim(side, name);
    socket.data.pairSlot = claimed.side;
    callback({
      ok: true,
      token: claimed.token,
      pair: pairStore.publicState(claimed.side)
    });
    emitPairUpdate();
  }));

  socket.on('pair:profile', (payload, callback) => handle(callback, () => {
    const side = requireClaimedSlot();
    const name = cleanName(payload.name);
    const avatar = cleanAvatar(payload.avatar);
    pairStore.updateProfile(side, name, avatar);
    for (const room of rooms.values()) {
      let changed = false;
      for (const player of room.players.values()) {
        if (player.pairSlot !== side) continue;
        player.name = name;
        player.avatar = avatar;
        changed = true;
      }
      if (changed) emitRoom(room);
    }
    callback({ ok: true, pair: pairStore.publicState(side) });
    emitPairUpdate();
  }));

  socket.on('history:get', (payload, callback) => handle(callback, () => {
    requireClaimedSlot();
    const owner = String(payload.owner || '');
    const record = pairStore.findHistory(owner, String(payload.id || ''));
    if (!record) throw new Error('这局历史已经不存在了');
    callback({ ok: true, record });
  }));

  socket.on('history:delete', (payload, callback) => handle(callback, () => {
    const side = requireClaimedSlot();
    if (!pairStore.deleteHistory(side, String(payload.id || ''))) {
      throw new Error('这局历史已经不存在了');
    }
    callback({ ok: true, pair: pairStore.publicState(side) });
    emitPairUpdate();
  }));

  socket.on('history:replay', (payload, callback) => handle(callback, () => {
    requireClaimedSlot();
    requireNoPendingDuel();
    const record = pairStore.findHistory(String(payload.owner || ''), String(payload.id || ''));
    if (!record) throw new Error('这局历史已经不存在了');
    validateConfig(Number(record.targetCount), Number(record.length));
    validateRoundLimit(Number(record.roundLimit));
    if (!Array.isArray(record.secrets) || record.secrets.length !== record.targetCount) {
      throw new Error('这局历史无法重新挑战');
    }
    const room = newRoom({
      code: `SOLO-${randomId(4).toUpperCase()}`,
      mode: 'solo',
      targetCount: record.targetCount,
      length: record.length,
      roundLimit: record.roundLimit,
      status: 'lobby',
      pairMode: true,
      secrets: record.secrets
    });
    const player = addPlayer(room, playerName(socket), socket);
    room.hostId = player.id;
    room.status = 'playing';
    room.startedAt = Date.now();
    rooms.set(room.code, room);
    callback({ ok: true, room: serializeRoom(room, player.id) });
  }));

  socket.on('identity:get', (_payload, callback) => {
    const slot = socket.data.pairSlot && pairStore.state.slots[socket.data.pairSlot];
    callback({ ok: true, name: slot?.name || identities.get(clientIp(socket)) || null });
  });

  socket.on('game:solo', (payload, callback) => handle(callback, () => {
    requireNoPendingDuel();
    const targetCount = Number(payload.targetCount);
    const length = Number(payload.length);
    const roundLimit = Number(payload.roundLimit);
    validateConfig(targetCount, length);
    const room = newRoom({
      code: `SOLO-${randomId(4).toUpperCase()}`,
      mode: 'solo',
      targetCount,
      length,
      roundLimit,
      status: 'lobby',
      pairMode: Boolean(socket.data.functionAccess && socket.data.pairSlot)
    });
    const player = addPlayer(room, playerName(socket, payload.name, '独行玩家'), socket);
    room.hostId = player.id;
    room.status = 'playing';
    room.startedAt = Date.now();
    rooms.set(room.code, room);
    callback({ ok: true, room: serializeRoom(room, player.id) });
  }));

  socket.on('pair:duel:propose', (payload, callback) => handle(callback, () => {
    const side = requireClaimedSlot();
    const targetCount = Number(payload.targetCount);
    const length = Number(payload.length);
    const roundLimit = Number(payload.roundLimit);
    validateConfig(targetCount, length);
    validateRoundLimit(roundLimit);

    const existing = waitingDirectRoom();
    if (existing) {
      const host = [...existing.players.values()][0];
      if (host?.pairSlot === side) throw new Error('比赛已经发出，正在等待另一边');
      throw new Error('对方已经发起比赛，请查看参数后选择加入');
    }

    const room = newRoom({
      code: `PAIR-${randomId(4).toUpperCase()}`,
      mode: 'multi',
      targetCount,
      length,
      roundLimit,
      status: 'lobby',
      pairMode: true,
      directPair: true
    });
    const player = addPlayer(room, playerName(socket), socket);
    room.hostId = player.id;
    rooms.set(room.code, room);
    callback({ ok: true, duel: directDuelFor(side) });
    emitPairUpdate();
  }));

  socket.on('pair:duel:accept', (_payload, callback) => handle(callback, () => {
    const side = requireClaimedSlot();
    const room = waitingDirectRoom();
    const host = room && [...room.players.values()][0];
    if (!room || !host || host.pairSlot === side) throw new Error('现在没有可以加入的直接对战');
    if (!host.connected) throw new Error('对方暂时离线，请稍后再试');
    const player = addPlayer(room, playerName(socket), socket);
    room.status = 'playing';
    room.startedAt = Date.now();
    callback({ ok: true, room: serializeRoom(room, player.id) });
    emitPairUpdate();
    emitRoom(room);
  }));

  socket.on('pair:duel:cancel', (_payload, callback) => handle(callback, () => {
    const side = requireClaimedSlot();
    const room = waitingDirectRoom();
    const host = room && [...room.players.values()][0];
    if (!room || !host) throw new Error('这场邀请已经结束了');
    const otherSide = side === 'left' ? 'right' : 'left';
    const message = host.pairSlot === side ? '对方取消了这场比赛' : '对方拒绝了这个比赛';
    removeWaitingDirectRoom(room);
    callback({ ok: true, duel: null });
    emitToPairSlot(otherSide, 'pair:duel-notice', { message });
    emitPairUpdate();
  }));

  socket.on('room:create', (payload, callback) => handle(callback, () => {
    requireNoPendingDuel();
    const targetCount = Number(payload.targetCount);
    const length = Number(payload.length);
    const roundLimit = Number(payload.roundLimit);
    validateConfig(targetCount, length);
    const room = newRoom({
      code: createRoomCode(),
      mode: 'multi',
      targetCount,
      length,
      roundLimit,
      status: 'lobby',
      pairMode: Boolean(socket.data.functionAccess && socket.data.pairSlot)
    });
    const player = addPlayer(room, playerName(socket, payload.name), socket);
    room.hostId = player.id;
    rooms.set(room.code, room);
    callback({ ok: true, room: serializeRoom(room, player.id) });
    emitRoom(room);
  }));

  socket.on('room:join', (payload, callback) => handle(callback, () => {
    requireNoPendingDuel();
    const room = rooms.get(String(payload.code || '').trim().toUpperCase());
    if (!room || room.mode !== 'multi') throw new Error('房间不存在或已失效');
    const player = addPlayer(room, playerName(socket, payload.name), socket);
    callback({ ok: true, room: serializeRoom(room, player.id) });
    emitRoom(room);
  }));

  socket.on('room:resume', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').trim().toUpperCase());
    if (!room || room.status !== 'lobby') throw new Error('等待房间已失效');
    const player = findPlayer(room, String(payload.token || ''));
    if (!player) throw new Error('无法恢复等待房间');
    if (room.pairMode && player.pairSlot !== socket.data.pairSlot) throw new Error('无法恢复双人房间');
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.connected = true;
    player.socketId = socket.id;
    socket.join(room.code);
    callback({ ok: true, room: serializeRoom(room, player.id) });
    emitRoom(room);
  }));

  socket.on('room:start', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').toUpperCase());
    const player = room && findPlayer(room, String(payload.token || ''));
    if (!room || !player) throw new Error('房间验证失败');
    if (player.id !== room.hostId) throw new Error('只有房主可以开始');
    if (room.status !== 'lobby') throw new Error('游戏已经开始');
    if (room.directPair) throw new Error('直接对战会在另一边进入后自动开始');
    if (room.pairMode && room.players.size !== 2) throw new Error('请等待另一边加入房间');
    if ([...room.players.values()].some((item) => !item.connected)) {
      throw new Error('有玩家正在重新连接，请稍候');
    }
    room.status = 'playing';
    room.startedAt = Date.now();
    callback({ ok: true });
    emitRoom(room);
  }));

  socket.on('game:guess', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').toUpperCase());
    const player = room && findPlayer(room, String(payload.token || ''));
    if (!room || !player) throw new Error('游戏验证失败，请重新进入');
    const result = submitGuess(room, player, String(payload.guess || ''));
    maybeFinishRoom(room);
    callback({ ok: true, result });
    emitRoom(room);
  }));

  socket.on('room:leave', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').toUpperCase());
    const player = room && findPlayer(room, String(payload.token || ''));
    if (!room || !player) throw new Error('房间验证失败');
    const wasActive = payload.abandon === true && room.pairMode && room.mode === 'multi' && room.status === 'playing' && !player.finishedAt;
    const opponent = wasActive
      ? [...room.players.values()].find((item) => item.id !== player.id && item.pairSlot)
      : null;
    leaveRoom(room, player);
    callback({ ok: true });
    if (opponent) emitToPairSlot(opponent.pairSlot, 'pair:opponent-left', { message: '对手退出了比赛，你可以继续完成这一局' });
    if (rooms.has(room.code)) emitRoom(room);
  }));

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = [...room.players.values()].find((item) => item.socketId === socket.id);
      if (!player) continue;
      const opponent = room.pairMode && room.mode === 'multi' && room.status === 'playing' && !player.finishedAt
        ? [...room.players.values()].find((item) => item.id !== player.id && item.pairSlot)
        : null;
      disconnectPlayer(room, player);
      if (opponent) emitToPairSlot(opponent.pairSlot, 'pair:opponent-left', { message: '对手退出了比赛，你可以继续完成这一局' });
      if (rooms.has(room.code)) emitRoom(room);
      break;
    }
  });
});

setInterval(() => {
  const expiry = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, room] of rooms.entries()) {
    if ((room.finishedAt || room.createdAt) < expiry) rooms.delete(code);
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`数迹已启动：http://${HOST}:${PORT}`);
});
