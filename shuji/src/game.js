'use strict';

const crypto = require('node:crypto');

const MIN_TARGETS = 1;
const MAX_TARGETS = 6;
const MIN_LENGTH = 3;
const MAX_LENGTH = 10;
const MIN_ROUNDS = 4;
const MAX_ROUNDS = 30;

function validateConfig(targetCount, length) {
  if (!Number.isInteger(targetCount) || targetCount < MIN_TARGETS || targetCount > MAX_TARGETS) {
    throw new Error(`目标数量必须在 ${MIN_TARGETS} 到 ${MAX_TARGETS} 之间`);
  }
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    throw new Error(`数字长度必须在 ${MIN_LENGTH} 到 ${MAX_LENGTH} 之间`);
  }
}

function calculateRoundLimit(targetCount, length) {
  validateConfig(targetCount, length);
  // Add duplicate-placement uncertainty, one finishing guess per target, and a human-play buffer.
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, targetCount + Math.ceil(Math.log2(length)) + 6));
}

function validateRoundLimit(roundLimit) {
  if (!Number.isInteger(roundLimit) || roundLimit < MIN_ROUNDS || roundLimit > MAX_ROUNDS) {
    throw new Error(`最大轮次必须在 ${MIN_ROUNDS} 到 ${MAX_ROUNDS} 之间`);
  }
}

function scoreGuess(secret, guess) {
  if (secret.length !== guess.length) throw new Error('猜测长度与答案不一致');

  const result = Array(secret.length).fill('absent');
  const remaining = new Map();
  for (let index = 0; index < secret.length; index += 1) {
    if (guess[index] === secret[index]) {
      result[index] = 'correct';
    } else {
      remaining.set(secret[index], (remaining.get(secret[index]) || 0) + 1);
    }
  }
  for (let index = 0; index < guess.length; index += 1) {
    if (result[index] === 'correct') continue;
    const count = remaining.get(guess[index]) || 0;
    if (count > 0) {
      result[index] = 'present';
      remaining.set(guess[index], count - 1);
    }
  }
  return result;
}

function generateSecrets(targetCount, length) {
  validateConfig(targetCount, length);
  const secrets = new Set();
  while (secrets.size < targetCount) {
    let value = '';
    for (let index = 0; index < length; index += 1) value += crypto.randomInt(0, 10);
    secrets.add(value);
  }
  return [...secrets];
}

function createPlayer(id, name, targetCount) {
  return {
    id,
    name,
    connected: true,
    failed: false,
    joinedAt: Date.now(),
    finishedAt: null,
    guesses: [],
    solved: Array(targetCount).fill(false),
    solvedAt: Array(targetCount).fill(null)
  };
}

function submitGuess(game, player, guess, now = Date.now()) {
  if (game.status !== 'playing') throw new Error('游戏尚未开始或已经结束');
  if (player.finishedAt) throw new Error('你的游戏已经结束');
  if (!new RegExp(`^\\d{${game.length}}$`).test(guess)) throw new Error(`请输入 ${game.length} 位数字`);
  if (player.guesses.length >= game.roundLimit) throw new Error('已达到轮次上限');

  const feedback = game.secrets.map((secret, targetIndex) => {
    if (player.solved[targetIndex]) return null;
    const score = scoreGuess(secret, guess);
    if (score.every((state) => state === 'correct')) {
      player.solved[targetIndex] = true;
      player.solvedAt[targetIndex] = player.guesses.length + 1;
    }
    return score;
  });
  player.guesses.push({ value: guess, feedback });
  const won = player.solved.every(Boolean);
  const exhausted = player.guesses.length >= game.roundLimit;
  if (won || exhausted) player.finishedAt = now;
  return { feedback, won, exhausted, finished: Boolean(player.finishedAt) };
}

function publicPlayer(player, revealHistory = false) {
  const output = {
    id: player.id,
    name: player.name,
    avatar: player.avatar || '',
    connected: player.connected,
    failed: player.failed,
    guessesUsed: player.guesses.length,
    solvedCount: player.solved.filter(Boolean).length,
    solved: player.solved,
    solvedAt: player.solvedAt,
    finishedAt: player.finishedAt
  };
  if (revealHistory) output.guesses = player.guesses;
  return output;
}

function playerRank(players) {
  return [...players].sort((left, right) => {
    if (left.failed !== right.failed) return left.failed ? 1 : -1;
    const leftSolved = left.solved.filter(Boolean).length;
    const rightSolved = right.solved.filter(Boolean).length;
    if (rightSolved !== leftSolved) return rightSolved - leftSolved;
    const leftWon = left.solved.every(Boolean);
    const rightWon = right.solved.every(Boolean);
    if (leftWon !== rightWon) return leftWon ? -1 : 1;
    if (left.guesses.length !== right.guesses.length) return left.guesses.length - right.guesses.length;
    return (left.finishedAt || Infinity) - (right.finishedAt || Infinity);
  });
}

module.exports = {
  calculateRoundLimit,
  createPlayer,
  generateSecrets,
  playerRank,
  publicPlayer,
  scoreGuess,
  submitGuess,
  validateConfig,
  validateRoundLimit
};
