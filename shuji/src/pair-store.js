'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const SIDES = ['left', 'right'];
const HISTORY_LIMIT = 200;

function emptyState() {
  return {
    version: 1,
    slots: { left: null, right: null },
    histories: { left: [], right: [] }
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeState(value) {
  const fallback = emptyState();
  if (!value || typeof value !== 'object') return fallback;
  for (const side of SIDES) {
    const slot = value.slots?.[side];
    if (slot && typeof slot.name === 'string') {
      fallback.slots[side] = {
        name: slot.name,
        avatar: typeof slot.avatar === 'string' ? slot.avatar : '',
        claimedAt: Number(slot.claimedAt) || Date.now(),
        tokenHashes: Array.isArray(slot.tokenHashes)
          ? slot.tokenHashes.filter((item) => typeof item === 'string').slice(-8)
          : []
      };
    }
    if (Array.isArray(value.histories?.[side])) {
      fallback.histories[side] = value.histories[side]
        .filter((item) => item && typeof item.id === 'string')
        .slice(0, HISTORY_LIMIT);
    }
  }
  return fallback;
}

function historySummary(record) {
  return {
    id: record.id,
    matchId: record.matchId,
    mode: record.mode,
    createdAt: record.createdAt,
    startedAt: record.startedAt || record.createdAt,
    finishedAt: record.finishedAt,
    targetCount: record.targetCount,
    length: record.length,
    roundLimit: record.roundLimit,
    won: record.won,
    failed: record.failed,
    solvedCount: record.solvedCount,
    guessesUsed: record.guessesUsed,
    opponent: record.opponent || null
  };
}

class PairStore {
  constructor(filename) {
    this.filename = filename;
    this.state = this.read();
  }

  read() {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.filename, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  save() {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }

  resolve(token) {
    if (!token) return null;
    const candidate = hashToken(token);
    return SIDES.find((side) => this.state.slots[side]?.tokenHashes.includes(candidate)) || null;
  }

  claim(side, requestedName) {
    if (!SIDES.includes(side)) throw new Error('请选择左边或右边');
    let slot = this.state.slots[side];
    if (!slot) {
      slot = { name: requestedName, avatar: '', claimedAt: Date.now(), tokenHashes: [] };
      this.state.slots[side] = slot;
    }
    const token = crypto.randomBytes(24).toString('hex');
    slot.tokenHashes = [...slot.tokenHashes.slice(-7), hashToken(token)];
    this.save();
    return { side, name: slot.name, token };
  }

  publicState(viewerSlot = null) {
    const slots = {};
    const histories = {};
    for (const side of SIDES) {
      const slot = this.state.slots[side];
      slots[side] = slot ? { name: slot.name, avatar: slot.avatar || '', claimedAt: slot.claimedAt } : null;
      histories[side] = this.state.histories[side].map(historySummary);
    }
    return { slot: viewerSlot, slots, histories };
  }

  addHistories(entries) {
    if (!entries.length) return;
    for (const { side, record } of entries) {
      if (!SIDES.includes(side)) continue;
      this.state.histories[side].unshift(record);
      this.state.histories[side] = this.state.histories[side].slice(0, HISTORY_LIMIT);
    }
    this.save();
  }

  findHistory(side, id) {
    if (!SIDES.includes(side)) return null;
    return this.state.histories[side].find((item) => item.id === id) || null;
  }

  deleteHistory(side, id) {
    if (!SIDES.includes(side)) return false;
    const before = this.state.histories[side].length;
    this.state.histories[side] = this.state.histories[side].filter((item) => item.id !== id);
    if (this.state.histories[side].length === before) return false;
    this.save();
    return true;
  }

  updateProfile(side, name, avatar) {
    if (!SIDES.includes(side) || !this.state.slots[side]) throw new Error('找不到你的双人身份');
    const slot = this.state.slots[side];
    slot.name = name;
    slot.avatar = avatar;
    for (const record of this.state.histories[side]) {
      if (record.player) {
        record.player.name = name;
        record.player.avatar = avatar;
      }
    }
    for (const owner of SIDES) {
      for (const record of this.state.histories[owner]) {
        if (record.opponent?.slot === side) {
          record.opponent.name = name;
          record.opponent.avatar = avatar;
        }
      }
    }
    this.save();
  }
}

module.exports = { PairStore, hashToken, historySummary };
