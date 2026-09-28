'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PairStore } = require('../src/pair-store');

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shuji-pair-'));
  return { directory, store: new PairStore(path.join(directory, 'pair.json')) };
}

test('claimed side persists without storing the raw device token', () => {
  const { directory, store } = temporaryStore();
  const claimed = store.claim('left', '小左');
  assert.equal(store.resolve(claimed.token), 'left');
  assert.equal(store.publicState().slots.left.name, '小左');
  assert.equal(store.publicState().slots.left.avatar, '');
  assert.equal(fs.readFileSync(path.join(directory, 'pair.json'), 'utf8').includes(claimed.token), false);
  assert.equal(new PairStore(path.join(directory, 'pair.json')).resolve(claimed.token), 'left');
});

test('profile updates persist and follow the player through saved matches', () => {
  const { store } = temporaryStore();
  store.claim('left', '旧名字');
  store.claim('right', '对手');
  store.addHistories([
    { side: 'left', record: { id: 'mine', player: { name: '旧名字', avatar: '' } } },
    { side: 'right', record: { id: 'theirs', opponent: { slot: 'left', name: '旧名字', avatar: '' } } }
  ]);
  const avatar = 'data:image/png;base64,YQ==';
  store.updateProfile('left', '新名字', avatar);
  assert.equal(store.publicState().slots.left.name, '新名字');
  assert.equal(store.publicState().slots.left.avatar, avatar);
  assert.equal(store.findHistory('left', 'mine').player.name, '新名字');
  assert.equal(store.findHistory('right', 'theirs').opponent.avatar, avatar);
});

test('history lists expose summaries while details retain the strategy', () => {
  const { store } = temporaryStore();
  const record = {
    id: 'round-1', mode: 'solo', createdAt: 10, finishedAt: 20,
    targetCount: 1, length: 3, roundLimit: 9, won: true, failed: false,
    solvedCount: 1, guessesUsed: 2, secrets: ['123'], player: { guesses: [{ value: '123' }] }
  };
  store.addHistories([{ side: 'right', record }]);
  const summary = store.publicState().histories.right[0];
  assert.equal(summary.guessesUsed, 2);
  assert.equal('secrets' in summary, false);
  assert.deepEqual(store.findHistory('right', 'round-1').secrets, ['123']);
  assert.equal(store.deleteHistory('right', 'round-1'), true);
  assert.equal(store.deleteHistory('right', 'round-1'), false);
});
