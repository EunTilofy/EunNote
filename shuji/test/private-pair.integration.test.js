'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, process) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`test server exited with ${process.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('test server did not start');
}

function connect(port, auth) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'], forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('key mode claims two sides, records solo play, protects deletion, and limits pair rooms', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shuji-private-'));
  const key = 'integration-secret';
  const keyFile = path.join(directory, 'key');
  fs.writeFileSync(keyFile, key);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      FUNCTION_KEY_FILE: keyFile,
      PAIR_FILE: path.join(directory, 'pair.json'),
      IDENTITIES_FILE: path.join(directory, 'identities.json')
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(port, child);

  const invalid = await connect(port, { functionKey: 'wrong' });
  t.after(() => invalid.close());
  assert.deepEqual(await emit(invalid, 'pair:state'), { ok: true, privateMode: false });

  const left = await connect(port, { functionKey: key });
  const right = await connect(port, { functionKey: key });
  t.after(() => { left.close(); right.close(); });
  const leftClaim = await emit(left, 'pair:claim', { side: 'left', name: '左左' });
  const rightClaim = await emit(right, 'pair:claim', { side: 'right', name: '右右' });
  assert.equal(leftClaim.pair.slot, 'left');
  assert.equal(rightClaim.pair.slot, 'right');
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  const profile = await emit(left, 'pair:profile', { name: '新左', avatar });
  assert.equal(profile.pair.slots.left.name, '新左');
  assert.equal(profile.pair.slots.left.avatar, avatar);
  assert.equal((await emit(right, 'pair:state')).pair.slots.left.name, '新左');

  const solo = await emit(left, 'game:solo', { targetCount: 1, length: 3, roundLimit: 4 });
  assert.equal(solo.ok, true);
  for (let round = 0; round < 4; round += 1) {
    const result = await emit(left, 'game:guess', {
      code: solo.room.code,
      token: solo.room.viewer.token,
      guess: String(round).padStart(3, '0')
    });
    assert.equal(result.ok, true);
    if (result.result.finished) break;
  }

  const pairState = await emit(left, 'pair:state');
  assert.equal(pairState.pair.histories.left.length, 1);
  assert.equal(pairState.pair.histories.right.length, 0);
  const record = pairState.pair.histories.left[0];
  assert.equal((await emit(right, 'history:get', { owner: 'left', id: record.id })).ok, true);
  const replay = await emit(right, 'history:replay', { owner: 'left', id: record.id });
  assert.equal(replay.room.pairMode, true);
  await emit(right, 'room:leave', { code: replay.room.code, token: replay.room.viewer.token, abandon: true });
  assert.equal((await emit(right, 'history:delete', { id: record.id })).ok, false);

  const abandoned = await emit(left, 'game:solo', { targetCount: 1, length: 3, roundLimit: 4 });
  assert.equal((await emit(left, 'room:leave', {
    code: abandoned.room.code,
    token: abandoned.room.viewer.token,
    abandon: true
  })).ok, true);
  const afterAbandon = (await emit(left, 'pair:state')).pair.histories.left;
  assert.equal(afterAbandon.length, 2);
  assert.equal(afterAbandon[0].failed, true);

  const proposal = await emit(left, 'pair:duel:propose', { targetCount: 1, length: 3, roundLimit: 4 });
  assert.equal(proposal.duel.role, 'host');
  const invited = await emit(right, 'pair:state');
  assert.equal(invited.duel.role, 'invitee');
  assert.deepEqual(
    [invited.duel.targetCount, invited.duel.length, invited.duel.roundLimit],
    [1, 3, 4]
  );
  assert.equal((await emit(right, 'game:solo', { targetCount: 1, length: 3, roundLimit: 4 })).ok, false);
  const rejectedNotice = new Promise((resolve) => left.once('pair:duel-notice', resolve));
  assert.equal((await emit(right, 'pair:duel:cancel')).ok, true);
  assert.match((await rejectedNotice).message, /拒绝/);
  const afterRejection = await emit(left, 'pair:state');
  assert.equal(afterRejection.duel, null);
  assert.equal(afterRejection.pair.histories.left.length, 2);

  await emit(left, 'pair:duel:propose', { targetCount: 1, length: 3, roundLimit: 4 });
  const hostStarted = new Promise((resolve) => {
    left.on('room:update', function listener(room) {
      if (room.directPair && room.status === 'playing') {
        left.off('room:update', listener);
        resolve(room);
      }
    });
  });
  const startedDuel = await emit(right, 'pair:duel:accept');
  const hostRoom = await hostStarted;
  assert.equal(startedDuel.room.status, 'playing');
  assert.ok(startedDuel.room.startedAt);
  const opponentLeft = new Promise((resolve) => right.once('pair:opponent-left', resolve));
  await emit(left, 'room:leave', { code: hostRoom.code, token: hostRoom.viewer.token, abandon: true });
  assert.match((await opponentLeft).message, /继续/);
  assert.equal((await emit(left, 'pair:state')).pair.histories.left.length, 2);
  assert.equal((await emit(right, 'game:guess', {
    code: startedDuel.room.code,
    token: startedDuel.room.viewer.token,
    guess: '000'
  })).ok, true);
  await emit(right, 'room:leave', { code: startedDuel.room.code, token: startedDuel.room.viewer.token, abandon: true });
  const afterDuel = await emit(left, 'pair:state');
  assert.equal(afterDuel.pair.histories.left[0].mode, 'pair');
  assert.equal(afterDuel.pair.histories.right[0].mode, 'pair');

  const created = await emit(left, 'room:create', { targetCount: 1, length: 3, roundLimit: 4 });
  assert.equal(created.room.pairMode, true);
  assert.equal((await emit(left, 'room:start', { code: created.room.code, token: created.room.viewer.token })).ok, false);
  const joined = await emit(right, 'room:join', { code: created.room.code });
  assert.equal(joined.room.players.length, 2);
  assert.equal((await emit(left, 'room:start', { code: created.room.code, token: created.room.viewer.token })).ok, true);

  const third = await connect(port, { functionKey: key });
  t.after(() => third.close());
  const thirdClaim = await emit(third, 'pair:claim', { side: 'right' });
  assert.equal(thirdClaim.ok, true);
  assert.equal((await emit(third, 'room:join', { code: created.room.code })).ok, false);

  assert.equal((await emit(left, 'history:delete', { id: record.id })).ok, true);
  assert.equal((await emit(left, 'pair:state')).pair.histories.left.length, 2);
});
