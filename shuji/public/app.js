/* global io */
'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const functionKey = new URLSearchParams(location.hash.slice(1)).get('key') || '';
const savedPairToken = localStorage.getItem('shuji:pair-token') || '';
const socket = io({
  path: '/shuji/socket.io',
  auth: { functionKey, pairToken: savedPairToken }
});
const state = {
  mode: 'solo', room: null, selectedResultPlayer: null,
  privateMode: false, pair: null, slot: null, selectedHistory: null, historyDetail: null,
  profileAvatar: '', duel: null, timer: null
};

function showFunctionHome() {
  if (!functionKey) return;
  const destination = new URL(location.href);
  destination.port = '6357';
  destination.pathname = '/';
  destination.search = '';
  destination.hash = `key=${encodeURIComponent(functionKey)}`;
  $('#functionHome').href = destination.href;
  $('#functionHome').classList.remove('hidden');
}

async function revealFunctionHome() {
  if (!functionKey) return;
  try {
    const response = await fetch('/shuji/api/function-access', { headers: { Authorization: `Bearer ${functionKey}` }, cache: 'no-store' });
    if (!response.ok) return;
    showFunctionHome();
  } catch {}
}

revealFunctionHome();

const elements = {
  home: $('#homeView'), game: $('#gameView'), lobby: $('#lobbyView'), play: $('#playView'),
  results: $('#resultsView'), startForm: $('#startForm'), startButton: $('#startButton'),
  name: $('#nameInput'), code: $('#codeInput'), targets: $('#targetInput'), length: $('#lengthInput'),
  rounds: $('#roundInput'), targetValue: $('#targetValue'), lengthValue: $('#lengthValue'),
  roundValue: $('#roundValue'), roundPreview: $('#roundPreview'),
  duelCancel: $('#duelCancelButton'), duelDot: $('#duelDot'), elapsed: $('#elapsedTime'),
  roomLabel: $('#roomLabel'), roundNow: $('#roundNow'), roundLimit: $('#roundLimit'),
  solvedNow: $('#solvedNow'), targetCount: $('#targetCount'), lobbyPlayers: $('#lobbyPlayerList'),
  lobbyCount: $('#lobbyCount'), copyCode: $('#copyCode'), begin: $('#beginButton'),
  waiting: $('#waitingText'), boards: $('#boards'), status: $('#statusStrip'),
  guessForm: $('#guessForm'), guessInput: $('#guessInput'), guessLength: $('#guessLength'),
  resultTabs: $('#resultTabs'), resultBoards: $('#resultBoards'), answers: $('#answers'),
  dialog: $('#infoDialog'), dialogContent: $('#dialogContent'), toast: $('#toast'),
  pairClaim: $('#pairClaimView'), claimName: $('#claimNameInput'),
  leftHistoryPanel: $('#leftHistoryPanel'), rightHistoryPanel: $('#rightHistoryPanel'),
  leftHistory: $('#leftHistoryList'), rightHistory: $('#rightHistoryList'),
  historyDialog: $('#historyDialog'), historyStrategy: $('#historyStrategy'),
  historyBoards: $('#historyBoards'), historyAnswers: $('#historyAnswers'),
  profileDialog: $('#profileDialog'), avatarPicker: $('#avatarPicker'),
  avatarInput: $('#avatarInput'), profileName: $('#profileNameInput'), saveProfile: $('#saveProfileButton')
};

function calculateRoundLimit(targetCount, length) {
  return Math.min(30, Math.max(4, targetCount + Math.ceil(Math.log2(length)) + 6));
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.className = 'toast'; }, 2400);
}

function request(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error('连接正在恢复，请稍后再试'));
      return;
    }
    socket.timeout(8000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) {
        reject(new Error('连接超时，请稍后再试'));
        return;
      }
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error || '网络连接失败'));
    });
  });
}

async function loadFixedIdentity() {
  try {
    const response = await request('identity:get', {});
    if (!response.name) return;
    elements.name.value = response.name;
    $('#fixedIdentityName').textContent = response.name;
    $('#identityField').classList.add('hidden');
    $('#fixedIdentity').classList.remove('hidden');
  } catch {
    // The editable field remains available if identity lookup is temporarily unavailable.
  }
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function initials(person) {
  return String(person?.name || '?').trim().slice(0, 1).toUpperCase();
}

function fillAvatar(container, person, fallback = '?') {
  container.replaceChildren();
  if (person?.avatar) {
    const image = document.createElement('img');
    image.src = person.avatar;
    image.alt = '';
    container.appendChild(image);
  } else {
    container.textContent = person ? initials(person) : fallback;
  }
}

function avatarNode(person, className = 'player-avatar') {
  const avatar = document.createElement('span');
  avatar.className = className;
  fillAvatar(avatar, person);
  return avatar;
}

function sideName(side) {
  return side === 'left' ? '左边' : '右边';
}

function formatHistoryTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function applyPairIdentity() {
  if (!state.slot || !state.pair?.slots?.[state.slot]) return;
  const slot = state.pair.slots[state.slot];
  elements.name.value = slot.name;
  $('#fixedIdentity').querySelector('span').textContent = '我的位置';
  $('#fixedIdentityName').textContent = `${sideName(state.slot)} · ${slot.name}`;
  $('#identityField').classList.add('hidden');
  $('#fixedIdentity').classList.remove('hidden');
}

function updateClaimOptions(pair) {
  for (const side of ['left', 'right']) {
    const slot = pair.slots[side];
    $(`#claim${side === 'left' ? 'Left' : 'Right'}Label`).textContent = slot
      ? `进入${sideName(side)}`
      : `认领${sideName(side)}`;
    $(`#claim${side === 'left' ? 'Left' : 'Right'}Hint`).textContent = slot
      ? `已认领 · ${slot.name}`
      : '还没有人认领';
  }
}

function renderHistoryList(side) {
  const container = side === 'left' ? elements.leftHistory : elements.rightHistory;
  const records = state.pair?.histories?.[side] || [];
  container.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = state.pair?.slots?.[side] ? '还没有留下对局记录' : '认领后，对局会出现在这里';
    container.appendChild(empty);
    return;
  }

  records.forEach((record) => {
    const card = document.createElement('div');
    card.className = 'history-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const mode = record.mode === 'pair' ? '双人对战' : '独自挑战';
    const opponent = record.opponent ? ` · 对 ${record.opponent.name}` : '';
    card.innerHTML = `
      <div class="history-card-title"><span class="history-mode${record.mode === 'pair' ? ' pair' : ''}">${mode}</span>${escapeHtml(formatHistoryTime(record.finishedAt))}</div>
      <div class="history-card-result${record.won ? ' won' : ''}">${record.won ? '完成全部轨迹' : `找到 ${record.solvedCount}/${record.targetCount}`}${escapeHtml(opponent)}</div>
      <div class="history-card-meta">${record.targetCount} 个目标 · ${record.length} 位数 · ${record.guessesUsed}/${record.roundLimit} 轮</div>`;
    const open = () => openHistory(side, record);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    if (side === state.slot) {
      const remove = document.createElement('button');
      remove.className = 'history-delete';
      remove.type = 'button';
      remove.title = '删除这局历史';
      remove.setAttribute('aria-label', '删除这局历史');
      remove.textContent = '×';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm('删除这局对战历史？')) return;
        try {
          const response = await request('history:delete', { id: record.id });
          renderPair(response.pair);
          showToast('这局历史已删除');
        } catch (error) {
          showToast(error.message, true);
        }
      });
      card.appendChild(remove);
    }
    container.appendChild(card);
  });
}

function renderPair(pair, duel = state.duel) {
  state.pair = pair;
  state.slot = pair.slot;
  state.duel = duel;
  document.body.classList.add('pair-mode');
  $$('.private-only').forEach((element) => element.classList.remove('hidden'));
  updateClaimOptions(pair);
  if (!pair.slot) {
    elements.home.classList.add('hidden');
    elements.pairClaim.classList.remove('hidden');
    return;
  }

  elements.pairClaim.classList.add('hidden');
  elements.home.classList.add('pair-ready');
  if (!state.room) elements.home.classList.remove('hidden');
  elements.leftHistoryPanel.classList.remove('hidden');
  elements.rightHistoryPanel.classList.remove('hidden');
  $('#leftHistoryName').textContent = pair.slots.left?.name || '等待认领';
  $('#rightHistoryName').textContent = pair.slots.right?.name || '等待认领';
  fillAvatar($('#leftProfileAvatar'), pair.slots.left, 'L');
  fillAvatar($('#rightProfileAvatar'), pair.slots.right, 'R');
  $('#leftMeBadge').classList.toggle('hidden', pair.slot !== 'left');
  $('#rightMeBadge').classList.toggle('hidden', pair.slot !== 'right');
  $('#leftProfileButton').classList.toggle('hidden', pair.slot !== 'left');
  $('#rightProfileButton').classList.toggle('hidden', pair.slot !== 'right');
  renderHistoryList('left');
  renderHistoryList('right');
  applyPairIdentity();
  applyDuelFormState();
}

async function refreshPairMode() {
  try {
    const response = await request('pair:state', {});
    state.privateMode = response.privateMode;
    if (!response.privateMode) {
      elements.pairClaim.classList.add('hidden');
      elements.home.classList.remove('hidden');
      return false;
    }
    showFunctionHome();
    renderPair(response.pair, response.duel);
    return true;
  } catch (error) {
    showToast(error.message, true);
    return false;
  }
}

function openHistory(owner, record) {
  state.selectedHistory = { owner, id: record.id };
  state.historyDetail = null;
  const ownerName = state.pair?.slots?.[owner]?.name || sideName(owner);
  const mode = record.mode === 'pair' ? '双人对战' : '独自挑战';
  $('#historyDialogTitle').textContent = `${ownerName} · ${mode}`;
  $('#historyDialogMeta').textContent = `${formatHistoryTime(record.finishedAt)} · ${record.targetCount} 个目标 · ${record.length} 位数 · ${record.guessesUsed} 轮`;
  elements.historyStrategy.classList.add('hidden');
  elements.historyBoards.replaceChildren();
  elements.historyAnswers.replaceChildren();
  $('#viewStrategyButton').textContent = '查看这局策略';
  elements.historyDialog.showModal();
}

async function showSelectedStrategy() {
  try {
    if (!state.historyDetail) {
      const selected = state.selectedHistory;
      state.historyDetail = (await request('history:get', selected)).record;
    }
    const record = state.historyDetail;
    const visible = !elements.historyStrategy.classList.contains('hidden');
    if (visible) {
      elements.historyStrategy.classList.add('hidden');
      $('#viewStrategyButton').textContent = '查看这局策略';
      return;
    }
    const available = Math.min(window.innerWidth - 90, 840);
    const gaps = Math.max(0, record.targetCount - 1) * 12 + record.targetCount * Math.max(0, record.length - 1) * 2;
    const size = Math.max(17, Math.min(24, Math.floor((available - gaps) / (record.targetCount * record.length))));
    elements.historyBoards.style.setProperty('--tile-size', `${size}px`);
    renderBoards(elements.historyBoards, record.player, record);
    elements.historyAnswers.replaceChildren();
    record.secrets.forEach((answer, index) => {
      const span = document.createElement('span');
      span.className = 'answer';
      span.textContent = `${index + 1}. ${answer}`;
      elements.historyAnswers.appendChild(span);
    });
    elements.historyStrategy.classList.remove('hidden');
    $('#viewStrategyButton').textContent = '收起策略';
  } catch (error) {
    showToast(error.message, true);
  }
}

function openProfile() {
  const profile = state.pair?.slots?.[state.slot];
  if (!profile) return;
  state.profileAvatar = profile.avatar || '';
  elements.profileName.value = profile.name;
  elements.avatarInput.value = '';
  fillAvatar(elements.avatarPicker, profile);
  elements.profileDialog.showModal();
  setTimeout(() => elements.profileName.focus(), 0);
}

async function prepareAvatar(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('仅支持 PNG、JPG、GIF 或 WebP 图片');
  if (file.size > 8 * 1024 * 1024) throw new Error('原图不能超过 8 MB');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    const size = 320;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f5f5f2';
    context.fillRect(0, 0, size, size);
    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    const avatar = canvas.toDataURL('image/jpeg', .86);
    if (avatar.length > 700 * 1024) throw new Error('处理后的头像仍然太大，请换一张图片');
    return avatar;
  } finally {
    URL.revokeObjectURL(source);
  }
}

function previewProfileAvatar() {
  fillAvatar(elements.avatarPicker, {
    name: elements.profileName.value || state.pair?.slots?.[state.slot]?.name,
    avatar: state.profileAvatar
  });
}

function setConfigValues(config) {
  elements.targets.value = config.targetCount;
  elements.length.value = config.length;
  elements.rounds.value = config.roundLimit;
  elements.targetValue.textContent = config.targetCount;
  elements.lengthValue.textContent = config.length;
  elements.roundValue.textContent = config.roundLimit;
  elements.roundPreview.textContent = config.roundLimit;
}

function applyDuelFormState() {
  const invitation = state.duel;
  elements.duelDot.classList.toggle('hidden', invitation?.role !== 'invitee');
  const viewingDuel = state.mode === 'duel';
  $$('.mode-tab').forEach((button) => {
    button.disabled = Boolean(invitation) && button.dataset.mode !== 'duel';
  });
  const locked = viewingDuel && Boolean(invitation);
  if (locked) setConfigValues(invitation);
  for (const input of [elements.targets, elements.length, elements.rounds]) input.disabled = locked;
  elements.duelCancel.classList.toggle('hidden', !locked);

  if (!viewingDuel) {
    elements.startButton.disabled = Boolean(invitation);
    return;
  }
  if (!invitation) {
    elements.startButton.disabled = false;
    elements.startButton.querySelector('span').textContent = '发起比赛';
  } else if (invitation.role === 'host') {
    elements.startButton.disabled = true;
    elements.startButton.querySelector('span').textContent = '等待对方加入';
  } else {
    elements.startButton.disabled = false;
    elements.startButton.querySelector('span').textContent = '加入比赛';
  }
}

function updatePreview() {
  elements.targetValue.textContent = elements.targets.value;
  elements.lengthValue.textContent = elements.length.value;
  const recommended = calculateRoundLimit(Number(elements.targets.value), Number(elements.length.value));
  elements.rounds.value = recommended;
  elements.roundValue.textContent = recommended;
  elements.roundPreview.textContent = recommended;
}

function showGame() {
  elements.home.classList.add('hidden');
  elements.pairClaim.classList.add('hidden');
  elements.game.classList.remove('hidden');
}

function updateLobbySession(room) {
  if (room.status === 'lobby' && room.viewer?.token) {
    sessionStorage.setItem('shuji:lobby', JSON.stringify({
      code: room.code,
      token: room.viewer.token
    }));
  } else {
    sessionStorage.removeItem('shuji:lobby');
  }
}

function setBoardSize(room) {
  const available = Math.min(window.innerWidth - 48, 1240);
  const boardGaps = Math.max(0, room.targetCount - 1) * 12;
  const cellGaps = room.targetCount * Math.max(0, room.length - 1) * 2;
  const size = Math.max(18, Math.min(28,
    Math.floor((available - boardGaps - cellGaps) / (room.targetCount * room.length))));
  elements.boards.style.setProperty('--tile-size', `${size}px`);
  elements.resultBoards.style.setProperty('--tile-size', `${size}px`);
}

function createTileRow(value, feedback, length, locked = false) {
  const row = document.createElement('div');
  row.className = 'board-row';
  row.style.setProperty('--length', length);
  for (let index = 0; index < length; index += 1) {
    const tile = document.createElement('div');
    tile.className = `tile ${feedback?.[index] || (locked ? 'locked' : '')}`;
    tile.textContent = feedback ? value[index] : '';
    row.appendChild(tile);
  }
  return row;
}

function renderBoards(container, player, room) {
  container.replaceChildren();
  for (let targetIndex = 0; targetIndex < room.targetCount; targetIndex += 1) {
    const board = document.createElement('section');
    board.className = `board${player.solved[targetIndex] ? ' solved' : ''}`;
    const title = document.createElement('div');
    title.className = 'board-title';
    const solvedLabel = player.solved[targetIndex] ? `<b>第 ${player.solvedAt[targetIndex]} 轮找到</b>` : '';
    title.innerHTML = `<span>轨迹 ${String(targetIndex + 1).padStart(2, '0')}</span>${solvedLabel}`;
    const grid = document.createElement('div');
    grid.className = 'board-grid';
    let solvedBefore = false;

    for (let round = 0; round < room.roundLimit; round += 1) {
      const guess = player.guesses?.[round];
      const feedback = guess?.feedback?.[targetIndex];
      if (feedback) {
        grid.appendChild(createTileRow(guess.value, feedback, room.length));
        if (feedback.every((item) => item === 'correct')) solvedBefore = true;
      } else {
        grid.appendChild(createTileRow('', null, room.length, solvedBefore));
      }
    }
    board.append(title, grid);
    container.appendChild(board);
  }
}

function renderLobby(room) {
  elements.lobby.classList.remove('hidden');
  elements.play.classList.add('hidden');
  elements.results.classList.add('hidden');
  elements.copyCode.textContent = room.code;
  elements.copyCode.classList.toggle('hidden', room.directPair);
  $('#directWaiting').classList.toggle('hidden', !room.directPair);
  $('.room-code-wrap small').textContent = room.directPair ? '双人空间 · 无需房间号' : '点击房间号复制到剪贴板';
  $('.room-code-wrap p').textContent = room.directPair
    ? '保持页面打开，另一边选择“直接对战”后会自动开始。'
    : room.pairMode
      ? '另一边加入后，由房主开始这场双人对战。'
    : '朋友加入后，由房主统一开始。最多支持 30 人。';
  elements.lobbyCount.textContent = room.players.length;
  elements.lobbyPlayers.replaceChildren();
  room.players.forEach((player) => {
    const pill = document.createElement('span');
    pill.className = `player-pill${player.id === room.hostId ? ' host' : ''}${player.connected ? '' : ' offline'}`;
    pill.append(avatarNode(player), document.createTextNode(player.name));
    elements.lobbyPlayers.appendChild(pill);
  });
  const isHost = room.viewerId === room.hostId;
  elements.begin.classList.toggle('hidden', !isHost || room.directPair);
  elements.waiting.classList.toggle('hidden', isHost && !room.directPair);
  elements.waiting.textContent = room.directPair ? '正在等待另一边…' : '等待房主开始...';
}

function renderStatus(room) {
  elements.status.replaceChildren();
  room.players.forEach((player, index) => {
    const chip = document.createElement('div');
    chip.className = `rank-chip${player.id === room.viewerId ? ' me' : ''}${player.failed ? ' failed' : ''}`;
    const progress = player.failed ? '已失败' : `${player.solvedCount}/${room.targetCount} · ${player.guessesUsed}轮`;
    const rank = document.createElement('b');
    rank.textContent = `#${index + 1}`;
    chip.append(avatarNode(player), rank, document.createTextNode(`${player.name} · ${progress}`));
    elements.status.appendChild(chip);
  });
}

function renderPlay(room) {
  elements.lobby.classList.add('hidden');
  elements.play.classList.remove('hidden');
  elements.results.classList.add('hidden');
  elements.roundNow.textContent = room.viewer.guessesUsed;
  elements.solvedNow.textContent = room.viewer.solvedCount;
  renderStatus(room);
  renderBoards(elements.boards, room.viewer, room);
  const disabled = Boolean(room.viewer.finishedAt);
  elements.guessInput.disabled = disabled;
  elements.guessForm.querySelector('button').disabled = disabled;
  if (!disabled) setTimeout(() => elements.guessInput.focus(), 0);
}

function renderResults(room) {
  elements.lobby.classList.add('hidden');
  elements.play.classList.add('hidden');
  elements.results.classList.remove('hidden');
  const own = room.players.find((player) => player.id === room.viewerId) || room.players[0];
  const won = own?.solvedCount === room.targetCount;
  $('#resultTitle').textContent = own?.failed ? '已退出，本局失败' : won ? '全部轨迹已找到' : '追迹告一段落';
  $('#resultCopy').textContent = room.mode === 'multi'
    ? '点击玩家 ID，查看每个人留下的完整推理轨迹。'
    : `${own?.guessesUsed || 0} 轮猜测，${own?.solvedCount || 0} 个目标被成功锁定。`;

  elements.resultTabs.replaceChildren();
  room.players.forEach((player, index) => {
    const button = document.createElement('button');
    const selectedId = state.selectedResultPlayer || own.id;
    button.className = `result-tab${selectedId === player.id ? ' active' : ''}`;
    button.append(
      avatarNode(player),
      document.createTextNode(`#${index + 1} ${player.name} · ${player.failed ? '失败' : `${player.solvedCount}/${room.targetCount}`}`)
    );
    button.addEventListener('click', () => {
      state.selectedResultPlayer = player.id;
      renderResults(room);
    });
    elements.resultTabs.appendChild(button);
  });

  const selected = room.players.find((player) => player.id === (state.selectedResultPlayer || own.id)) || own;
  renderBoards(elements.resultBoards, selected, room);
  elements.answers.replaceChildren();
  (room.secrets || []).forEach((answer, index) => {
    const span = document.createElement('span');
    span.className = 'answer';
    span.textContent = `${index + 1}. ${answer}`;
    elements.answers.appendChild(span);
  });
}

function formatElapsed(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function syncGameTimer(room) {
  clearInterval(state.timer);
  state.timer = null;
  if (!room.startedAt) {
    elements.elapsed.textContent = '00:00';
    return;
  }
  const update = () => {
    const end = room.finishedAt || Date.now();
    elements.elapsed.textContent = formatElapsed(end - room.startedAt);
  };
  update();
  if (room.status === 'playing') state.timer = setInterval(update, 1000);
}

function applyRoom(room) {
  state.room = room;
  updateLobbySession(room);
  showGame();
  syncGameTimer(room);
  setBoardSize(room);
  elements.name.value = room.viewer?.name || elements.name.value;
  elements.roomLabel.textContent = room.mode === 'solo' ? '单人挑战' : room.directPair ? '双人直接对战' : `房间 ${room.code}`;
  elements.roundLimit.textContent = room.roundLimit;
  elements.targetCount.textContent = room.targetCount;
  elements.guessLength.textContent = room.length;
  elements.guessInput.maxLength = room.length;
  elements.guessInput.placeholder = '0'.repeat(room.length);
  if (room.status === 'lobby') renderLobby(room);
  else if (room.status === 'playing') renderPlay(room);
  else renderResults(room);
}

$$('.mode-tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    $$('.mode-tab').forEach((item) => item.classList.toggle('active', item === button));
    $$('.join-only').forEach((item) => item.classList.toggle('hidden', state.mode !== 'join'));
    $$('.config-only').forEach((item) => item.classList.toggle('hidden', state.mode === 'join'));
    elements.startButton.disabled = false;
    elements.startButton.querySelector('span').textContent =
      state.mode === 'join' ? '进入房间'
        : state.mode === 'create' ? '创建竞赛'
          : state.mode === 'duel' ? '直接对战'
            : '开始追迹';
    applyDuelFormState();
  });
});

$$('[data-claim-side]').forEach((button) => {
  button.addEventListener('click', async () => {
    const side = button.dataset.claimSide;
    button.disabled = true;
    try {
      const response = await request('pair:claim', { side, name: elements.claimName.value });
      localStorage.setItem('shuji:pair-token', response.token);
      socket.auth.pairToken = response.token;
      renderPair(response.pair);
      showToast(`已进入${sideName(side)}`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
});

[elements.targets, elements.length].forEach((input) => input.addEventListener('input', updatePreview));
elements.rounds.addEventListener('input', () => {
  elements.roundValue.textContent = elements.rounds.value;
});
elements.duelCancel.addEventListener('click', async () => {
  elements.duelCancel.disabled = true;
  try {
    await request('pair:duel:cancel', {});
    state.duel = null;
    applyDuelFormState();
    showToast('这场比赛已放弃，不会计入历史');
  } catch (error) {
    showToast(error.message, true);
    await refreshPairMode();
  } finally {
    elements.duelCancel.disabled = false;
  }
});
elements.startForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.startButton.disabled = true;
  try {
    const payload = {
      name: elements.name.value,
      targetCount: Number(elements.targets.value),
      length: Number(elements.length.value),
      roundLimit: Number(elements.rounds.value),
      code: elements.code.value
    };
    if (state.mode === 'duel') {
      const response = state.duel?.role === 'invitee'
        ? await request('pair:duel:accept', {})
        : await request('pair:duel:propose', payload);
      if (response.room) {
        state.duel = null;
        applyRoom(response.room);
      } else {
        state.duel = response.duel;
        applyDuelFormState();
        showToast('比赛已发出，等待对方加入');
      }
    } else {
      const eventName = state.mode === 'solo' ? 'game:solo' : state.mode === 'create' ? 'room:create' : 'room:join';
      applyRoom((await request(eventName, payload)).room);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.startButton.disabled = false;
    applyDuelFormState();
  }
});

elements.begin.addEventListener('click', async () => {
  try {
    await request('room:start', { code: state.room.code, token: state.room.viewer.token });
  } catch (error) {
    showToast(error.message, true);
  }
});

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers that expose the API but deny clipboard permission.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('浏览器拒绝了剪贴板访问');
}

elements.copyCode.addEventListener('click', async () => {
  try {
    await copyText(state.room.code);
    showToast(`房间号 ${state.room.code} 已复制`);
  } catch (error) {
    showToast(`${error.message}，请长按房间号手动复制`, true);
  }
});

elements.guessInput.addEventListener('input', () => {
  elements.guessInput.value = elements.guessInput.value.replace(/\D/g, '').slice(0, state.room?.length || 10);
});

elements.guessForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const guess = elements.guessInput.value;
  if (guess.length !== state.room.length) {
    showToast(`请输入 ${state.room.length} 位数字`, true);
    return;
  }
  const button = elements.guessForm.querySelector('button');
  button.disabled = true;
  try {
    await request('game:guess', { code: state.room.code, token: state.room.viewer.token, guess });
    elements.guessInput.value = '';
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

socket.on('room:update', applyRoom);

async function leaveAndGo(destination, { reload = false } = {}) {
  if (state.leaving) return;
  state.leaving = true;
  sessionStorage.removeItem('shuji:lobby');
  if (state.room?.viewer?.token) {
    const leave = request('room:leave', {
      code: state.room.code,
      token: state.room.viewer.token,
      abandon: state.room.status !== 'finished'
    }).catch(() => {});
    await Promise.race([
      leave,
      new Promise((resolve) => setTimeout(resolve, 350))
    ]);
  }
  if (reload) location.reload();
  else location.assign(destination);
}

function returnToShujiHome() {
  leaveAndGo(null, { reload: true });
}

$('#homeButton').addEventListener('click', returnToShujiHome);
$('#backButton').addEventListener('click', returnToShujiHome);
$('#functionHome').addEventListener('click', (event) => {
  if (!state.room) return;
  event.preventDefault();
  leaveAndGo(event.currentTarget.href);
});

$('#leftProfileButton').addEventListener('click', openProfile);
$('#rightProfileButton').addEventListener('click', openProfile);
elements.avatarPicker.addEventListener('click', () => elements.avatarInput.click());
elements.avatarInput.addEventListener('change', async () => {
  const file = elements.avatarInput.files[0];
  if (!file) return;
  elements.avatarPicker.disabled = true;
  try {
    state.profileAvatar = await prepareAvatar(file);
    previewProfileAvatar();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.avatarPicker.disabled = false;
    elements.avatarInput.value = '';
  }
});
elements.profileName.addEventListener('input', () => {
  if (!state.profileAvatar) previewProfileAvatar();
});
$('#removeAvatarButton').addEventListener('click', () => {
  state.profileAvatar = '';
  previewProfileAvatar();
});
elements.saveProfile.addEventListener('click', async () => {
  elements.saveProfile.disabled = true;
  try {
    const response = await request('pair:profile', {
      name: elements.profileName.value,
      avatar: state.profileAvatar
    });
    renderPair(response.pair);
    elements.profileDialog.close();
    showToast('个人资料已保存');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.saveProfile.disabled = false;
  }
});
$$('[data-profile-close]').forEach((button) => button.addEventListener('click', () => elements.profileDialog.close()));
elements.profileDialog.addEventListener('click', (event) => {
  if (event.target === elements.profileDialog) elements.profileDialog.close();
});

$('#viewStrategyButton').addEventListener('click', showSelectedStrategy);
$('#replayHistoryButton').addEventListener('click', async () => {
  const button = $('#replayHistoryButton');
  button.disabled = true;
  try {
    const response = await request('history:replay', state.selectedHistory);
    elements.historyDialog.close();
    applyRoom(response.room);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$$('[data-history-close]').forEach((button) => button.addEventListener('click', () => elements.historyDialog.close()));
elements.historyDialog.addEventListener('click', (event) => {
  if (event.target === elements.historyDialog) elements.historyDialog.close();
});

$('#helpButton').addEventListener('click', () => {
  elements.dialogContent.innerHTML = `
    <h2>如何留下数迹</h2>
    <p>系统会生成 N 个互不相同、可含前导零的 M 位数字。每轮输入一个 M 位数字，它会同时作用于所有尚未找到的目标。</p>
    <div class="legend"><span class="green">绿色 · 数字与位置都正确</span><span class="orange">橙色 · 数字存在但位置错误</span><span class="gray">灰色 · 不存在或数量已用尽</span></div>
    <p>重复数字严格按出现次数判定。猜中一个目标后，该列整行变绿，之后不再显示提示。找到全部目标即可获胜。</p>
    <p><b>推荐轮次：</b>N + ⌈log₂(M)⌉ + 6，可在 4–30 轮之间自由调整。它以反馈的信息论下界为基础，再加入重复数字定位、逐个命中与人类操作余量。</p>`;
  elements.dialog.showModal();
});

$$('[data-close]').forEach((button) => button.addEventListener('click', () => elements.dialog.close()));
elements.dialog.addEventListener('click', (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  $('#themeButton').textContent = light ? '☾ 深色' : '☀ 浅色';
  $('#themeButton').setAttribute('aria-label', light ? '切换深色模式' : '切换浅色模式');
  document.querySelector('meta[name="theme-color"]').content = light ? '#f5f8fb' : '#0a0f1b';
}

async function resumeLobby() {
  const saved = JSON.parse(sessionStorage.getItem('shuji:lobby') || 'null');
  if (!saved) return;
  try {
    applyRoom((await request('room:resume', saved)).room);
  } catch {
    sessionStorage.removeItem('shuji:lobby');
  }
}

$('#themeButton').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('shuji:theme', next);
  applyTheme(next);
});

window.addEventListener('resize', () => {
  if (state.room) setBoardSize(state.room);
});

applyTheme(localStorage.getItem('shuji:theme') || 'light');
updatePreview();
socket.on('pair:update', () => {
  if (state.privateMode) refreshPairMode();
});
socket.on('pair:duel-notice', (payload) => {
  showToast(payload?.message || '这场直接对战已取消', true);
});
socket.on('pair:opponent-left', (payload) => {
  showToast(payload?.message || '对手退出了比赛，你可以继续完成这一局', true);
});
socket.on('connect', async () => {
  const privateAccess = await refreshPairMode();
  if (!privateAccess) await loadFixedIdentity();
  if (!privateAccess || state.slot) resumeLobby();
});
