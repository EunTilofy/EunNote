const token = new URLSearchParams(location.hash.slice(1)).get('key');
const boardsEl = document.querySelector('#boards');
const wallEl = document.querySelector('#wall');
const gpuMachinesEl = document.querySelector('#gpuMachines');
const gpuOverview = document.querySelector('#gpuOverview');
const gpuDetailModal = document.querySelector('#gpuDetailModal');
const gpuDetailContent = document.querySelector('#gpuDetailContent');
const gpuDetailClose = document.querySelector('#gpuDetailClose');
const syncEl = document.querySelector('#syncStatus');
const identityButton = document.querySelector('#identityButton');
const identityModal = document.querySelector('#identityModal');
const identityChoices = document.querySelector('#identityChoices');
const todoModal = document.querySelector('#todoModal');
const todoModalForm = document.querySelector('#todoModalForm');
const todoModalTitle = document.querySelector('#todoModalTitle');
const todoModalText = document.querySelector('#todoModalText');
const todoModalRecurring = document.querySelector('#todoModalRecurring');
const todoRecurrenceFields = document.querySelector('#todoRecurrenceFields');
const todoRecurrenceInterval = document.querySelector('#todoRecurrenceInterval');
const todoRecurrenceUnit = document.querySelector('#todoRecurrenceUnit');
const todoModalImportant = document.querySelector('#todoModalImportant');
const todoDatePreview = document.querySelector('#todoDatePreview');
const profileModal = document.querySelector('#profileModal');
const profileName = document.querySelector('#profileName');
const avatarPreview = document.querySelector('#avatarPicker');
const avatarInput = document.querySelector('#avatarInput');
const imageInput = document.querySelector('#imageInput');
const wallText = document.querySelector('#wallText');
const composer = document.querySelector('#composer');
const pendingImagesEl = document.querySelector('#pendingImages');
const publishButton = document.querySelector('#publish');
const showMoreButton = document.querySelector('#showMore');
const themeToggle = document.querySelector('#themeToggle');
const backHome = document.querySelector('#backHome');
const introEditor = document.querySelector('#introEditor');
const introTitle = document.querySelector('#introTitle');
const introColors = document.querySelector('#introColors');
const sloganModal = document.querySelector('#sloganModal');
const sloganText = document.querySelector('#sloganText');
const sloganColors = document.querySelector('#sloganColors');
const wallTools = document.querySelector('#wallTools');
const wallFilterButton = document.querySelector('#wallFilterButton');
const wallFilterPanel = document.querySelector('#wallFilterPanel');
const filterFeatured = document.querySelector('#filterFeatured');
const wallFeatured = document.querySelector('#wallFeatured');
const wallEditModal = document.querySelector('#wallEditModal');
const wallEditText = document.querySelector('#wallEditText');
const wallEditFeatured = document.querySelector('#wallEditFeatured');
const wallEditImageArea = document.querySelector('#wallEditImageArea');
const wallEditImageInput = document.querySelector('#wallEditImageInput');
const wallEditImagesEl = document.querySelector('#wallEditImages');
const wallEditImageCount = document.querySelector('#wallEditImageCount');
const imagePreview = document.querySelector('#imagePreview');
const imagePreviewImage = document.querySelector('#imagePreviewImage');
const imagePreviewCount = document.querySelector('#imagePreviewCount');
const imagePreviewPrevious = document.querySelector('#imagePreviewPrevious');
const imagePreviewNext = document.querySelector('#imagePreviewNext');
const WALL_PAGE_SIZES = { grid: 50, list: 10 };

let state;
let gpuMachines = [];
let openGpuMachineName = '';
let gpuDetailCloseTimer;
let renderedGpuDetailKey = '';
let gpuDragState = null;
let gpuOrderSaving = false;
let deferredGpuMachines = null;
let identity = localStorage.getItem('note-identity');
let editingProfile;
let addingTodoPerson;
let todoModalIsComposing = false;
let pendingAvatar;
let pendingImages = [];
let wallView = localStorage.getItem('note-wall-view') === 'list' ? 'list' : 'grid';
let visibleWallItems = WALL_PAGE_SIZES[wallView];
let toastTimer;
let actionQueue = Promise.resolve();
let wallLayoutFrame;
let presence = {};
let presenceStarted = false;
let manuallySleeping = false;
let presenceQueue = Promise.resolve();
let editingIntro = false;
let editingSloganPerson;
let editingSloganColor = 'neutral';
let composeWallKind = 'note';
let composeWallStyle = 'paper';
let wallFilters = { kind: 'all', style: 'all', featured: false };
let editingWallId;
let editingWallKind = 'note';
let editingWallStyle = 'paper';
let editingWallImages = [];
let previewImages = [];
let previewImageIndex = 0;
let imagePreviewCloseTimer;
const presenceSessionId = typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const timers = new Map();
const localValues = new Map();

function setStatus(message, kind = '') {
  syncEl.className = `sync-status ${kind}`;
  syncEl.lastChild.textContent = message;
}

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2300);
}

function isImeConfirm(event) {
  return event.isComposing || event.keyCode === 229;
}

async function api(path, options = {}) {
  const response = await fetch(`/notion/api${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body && !(options.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function queueAction(action, quiet = false) {
  setStatus('正在保存');
  actionQueue = actionQueue.catch(() => {}).then(async () => {
    try {
      const result = await api('/action', { method: 'POST', body: JSON.stringify(action) });
      state = result.state;
      render();
      setStatus('已同步', 'saved');
      return result;
    } catch (error) {
      setStatus('同步失败', 'error');
      if (!quiet) toast(error.message);
      throw error;
    }
  });
  return actionQueue;
}

function sendPresence(status, personId = identity, quiet = true) {
  if (!personId || !token) return Promise.resolve();
  const payload = { personId, sessionId: presenceSessionId, status };
  presenceQueue = presenceQueue.catch(() => {}).then(async () => {
    try {
      const result = await api('/presence', { method: 'POST', body: JSON.stringify(payload) });
      presence = result.presence || presence;
      renderPresence();
      return result;
    } catch (error) {
      if (!quiet) toast(error.message);
      if (!quiet) throw error;
      return null;
    }
  });
  return presenceQueue;
}

function debounceAction(key, actionFactory, delay = 550) {
  clearTimeout(timers.get(key));
  setStatus('有修改');
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    const expected = localValues.get(key);
    try {
      await queueAction(actionFactory(), true);
      if (localValues.get(key) === expected) {
        localValues.delete(key);
        render();
      }
    } catch {
      timers.set(key, setTimeout(() => debounceAction(key, actionFactory, 0), 2500));
    }
  }, delay));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.querySelector('span').textContent = theme === 'dark' ? '☀' : '☾';
  themeToggle.title = theme === 'dark' ? '切换到浅色' : '切换到深色';
}

const savedTheme = localStorage.getItem('note-theme');
if (token) backHome.href = `/#key=${encodeURIComponent(token)}`;
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('note-theme', next);
  applyTheme(next);
});

function initials(person) {
  return (person.name || '?').trim().slice(0, 1).toUpperCase();
}

function avatarNode(person, className = 'avatar') {
  const node = document.createElement('span');
  node.className = className;
  if (person.avatar) {
    const img = document.createElement('img');
    img.src = person.avatar;
    img.alt = '';
    node.append(img);
  } else {
    node.textContent = initials(person);
  }
  return node;
}

function createBoard(person) {
  const board = document.createElement('article');
  board.className = 'person-board';
  board.dataset.person = person.id;
  board.innerHTML = `
    <header class="person-top">
      <div class="avatar-slot"></div>
      <div class="person-meta"><div class="person-name-row"><h2></h2><span class="presence-badge" data-status="away"><i></i><span>离开</span></span></div></div>
      <button class="person-slogan empty" data-color="neutral" type="button" title="点击设置 slogan"><span>点击写一句话</span></button>
      <div class="person-actions"><button class="presence-toggle" type="button" hidden aria-label="进入睡觉状态" title="进入睡觉状态">🌙</button><button class="profile-button" type="button">设置资料</button></div>
    </header>
    <div class="board-body">
      <div class="focus-card">
        <div class="focus-title-row"><span class="focus-label"><i class="pulse"></i>现在正在做 <small class="focus-count">0 项</small></span><button class="focus-add-button" type="button" aria-label="新增正在做的事项" title="新增正在做的事项">＋</button></div>
        <div class="focus-list"></div>
      </div>
      <section class="board-section">
        <p class="section-label"><span>待办清单</span><span class="todo-count">0 项</span></p>
        <button class="todo-add-trigger" type="button"><span>＋</span> 新增待办</button>
        <ul class="todo-list"></ul>
      </section>
      <section class="board-section">
        <p class="section-label"><span>随手记</span><span class="note-count">0 / 5000</span></p>
        <textarea class="note-area" maxlength="5000" placeholder="想法、提醒、牢骚……都可以写在这里。"></textarea>
      </section>
      <section class="board-section completed-section">
        <p class="section-label"><span>已完成</span><span class="completed-count">0 项</span></p>
        <ul class="completed-list"></ul>
      </section>
    </div>`;

  board.querySelector('.profile-button').addEventListener('click', () => openProfile(person.id));
  board.querySelector('.person-slogan').addEventListener('click', () => openSlogan(person.id));
  board.querySelector('.presence-toggle').addEventListener('click', async () => {
    if (identity !== person.id) return;
    const wasSleeping = presence[person.id]?.status === 'sleeping';
    manuallySleeping = !wasSleeping;
    renderPresence();
    try {
      await sendPresence(wasSleeping ? 'wake' : 'sleeping', person.id, false);
      toast(wasSleeping ? '醒来啦，已经显示在线' : '晚安，已经进入睡觉状态');
    } catch {
      manuallySleeping = wasSleeping;
      renderPresence();
    }
  });
  const noteArea = board.querySelector('.note-area');
  board.querySelector('.focus-add-button').addEventListener('click', async () => {
    try {
      await flushFocusEdits(person.id);
      await queueAction({ type: 'addFocus', personId: person.id, title: '新的事项', endsAt: '' });
      const titleInput = board.querySelector('.focus-item-title');
      titleInput?.focus();
      titleInput?.select();
    } catch {}
  });
  noteArea.addEventListener('input', () => {
    const key = `${person.id}:note`;
    localValues.set(key, noteArea.value);
    board.querySelector('.note-count').textContent = `${noteArea.value.length} / 5000`;
    debounceAction(key, () => ({ type: 'setNote', personId: person.id, note: localValues.get(key) ?? noteArea.value }));
  });
  board.querySelector('.todo-add-trigger').addEventListener('click', async () => {
    try {
      await flushTodoEdits(person.id);
      openTodoModal(person.id);
    } catch {}
  });
  return board;
}

function cancelFocusEdits(personId, focusId) {
  const key = `${personId}:focus:${focusId}`;
  clearTimeout(timers.get(key));
  timers.delete(key);
  localValues.delete(key);
}

function beginFocusEdit(personId, focusId, titleEl) {
  const key = `${personId}:focus:${focusId}`;
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (!localValues.has(key)) localValues.set(key, { title: titleEl.value });
}

function updateFocusDraft(personId, focusId, titleEl) {
  const key = `${personId}:focus:${focusId}`;
  localValues.set(key, { title: titleEl.value });
  setStatus('有修改');
}

async function commitFocusEdit(personId, focusId, titleEl) {
  const key = `${personId}:focus:${focusId}`;
  const person = state.people.find(item => item.id === personId);
  const focus = person?.focuses.find(item => item.id === focusId);
  if (!focus) return cancelFocusEdits(personId, focusId);
  const title = titleEl.value.trim();
  if (!title) {
    titleEl.value = focus.title;
    toast('事项名称不能为空');
  }
  const draft = { title: title || focus.title };
  localValues.set(key, draft);
  if (draft.title === focus.title) {
    if (localValues.get(key) === draft) localValues.delete(key);
    render();
    return;
  }
  try {
    await queueAction({ type: 'updateFocus', personId, focusId, title: draft.title, endsAt: focus.endsAt || '' }, true);
    if (localValues.get(key) === draft) {
      localValues.delete(key);
      render();
    }
  } catch {}
}

function scheduleFocusCommit(personId, focusId, titleEl) {
  const key = `${personId}:focus:${focusId}`;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    commitFocusEdit(personId, focusId, titleEl);
  }, 220));
}

function cancelTodoEdit(personId, todoId) {
  const key = `${personId}:todo:${todoId}`;
  clearTimeout(timers.get(key));
  timers.delete(key);
  localValues.delete(key);
}

function beginTodoEdit(personId, todoId, label) {
  const key = `${personId}:todo:${todoId}`;
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (!localValues.has(key)) localValues.set(key, { text: label.textContent });
}

function updateTodoDraft(personId, todoId, label) {
  localValues.set(`${personId}:todo:${todoId}`, { text: label.textContent });
  setStatus('有修改');
}

async function commitTodoEdit(personId, todoId, label) {
  const key = `${personId}:todo:${todoId}`;
  const person = state.people.find(item => item.id === personId);
  const todo = person?.todos.find(item => item.id === todoId);
  if (!todo) return cancelTodoEdit(personId, todoId);
  const text = label.textContent.replace(/\s+/g, ' ').trim();
  if (!text) {
    label.textContent = todo.text;
    cancelTodoEdit(personId, todoId);
    toast('待办不能为空');
    return;
  }
  label.textContent = text;
  const draft = { text };
  localValues.set(key, draft);
  if (text === todo.text) {
    if (localValues.get(key) === draft) localValues.delete(key);
    render();
    return;
  }
  try {
    await queueAction({ type: 'editTodo', personId, todoId, text }, true);
    if (localValues.get(key) === draft) {
      localValues.delete(key);
      render();
    }
  } catch {}
}

function scheduleTodoCommit(personId, todoId, label) {
  const key = `${personId}:todo:${todoId}`;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    commitTodoEdit(personId, todoId, label);
  }, 220));
}

async function flushTodoEdits(personId) {
  const prefix = `${personId}:todo:`;
  const entries = [...localValues.entries()].filter(([key]) => key.startsWith(prefix));
  if (!entries.length) return;
  for (const [key, value] of entries) {
    clearTimeout(timers.get(key));
    timers.delete(key);
    const todoId = key.slice(prefix.length);
    const person = state.people.find(item => item.id === personId);
    const todo = person?.todos.find(item => item.id === todoId);
    const text = String(value?.text || '').replace(/\s+/g, ' ').trim();
    if (todo && text && text !== todo.text) {
      await queueAction({ type: 'editTodo', personId, todoId, text }, true);
    }
    if (localValues.get(key) === value) localValues.delete(key);
  }
  render();
}

async function flushFocusEdits(personId) {
  const prefix = `${personId}:focus:`;
  for (const [key, value] of [...localValues.entries()]) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(timers.get(key));
    timers.delete(key);
    const focusId = key.slice(prefix.length);
    const focus = state.people.find(person => person.id === personId)?.focuses.find(item => item.id === focusId);
    if (focus) await queueAction({ type: 'updateFocus', personId, focusId, title: value.title, endsAt: focus.endsAt || '' }, true);
    localValues.delete(key);
  }
  render();
}

function syncInput(input, value, key) {
  if (localValues.has(key) || document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

function renderBoard(person) {
  let board = boardsEl.querySelector(`[data-person="${person.id}"]`);
  if (!board) {
    board = createBoard(person);
    boardsEl.append(board);
  }
  const avatarSlot = board.querySelector('.avatar-slot');
  avatarSlot.replaceChildren(avatarNode(person));
  board.querySelector('.person-meta h2').textContent = person.name;
  const slogan = board.querySelector('.person-slogan');
  slogan.dataset.color = person.slogan?.color || 'neutral';
  slogan.classList.toggle('empty', !person.slogan?.text);
  slogan.querySelector('span').textContent = person.slogan?.text || '点击写一句话';
  board.querySelector('.focus-count').textContent = `${person.focuses.length} 项`;
  renderFocuses(board.querySelector('.focus-list'), person);
  const note = localValues.get(`${person.id}:note`) ?? person.note;
  syncInput(board.querySelector('.note-area'), person.note || '', `${person.id}:note`);
  board.querySelector('.note-count').textContent = `${note.length} / 5000`;
  const pending = person.todos.filter(item => todoStatus(item) === 'todo');
  const completed = person.todos.filter(item => todoStatus(item) === 'done');
  board.querySelector('.todo-count').textContent = `${pending.length} 项未完成`;
  board.querySelector('.completed-count').textContent = `${completed.length} 项`;
  renderTodos(board.querySelector('.todo-list'), person);
  renderCompleted(board.querySelector('.completed-list'), person);
}

function renderFocuses(list, person) {
  const prefix = `${person.id}:focus:`;
  if ([...localValues.keys()].some(key => key.startsWith(prefix))) return;
  list.classList.toggle('single', person.focuses.length <= 1);
  list.replaceChildren();
  if (!person.focuses.length) {
    const empty = document.createElement('p');
    empty.className = 'focus-empty';
    empty.textContent = '还没有正在进行的事情。';
    list.append(empty);
    return;
  }
  for (const focus of person.focuses) {
    const linkedTodo = person.todos.find(todo => todo.id === focus.todoId);
    const row = document.createElement('section');
    row.className = 'focus-item';
    row.classList.toggle('important', linkedTodo?.important === true);
    row.dataset.focusId = focus.id;
    const dragHandle = document.createElement('span');
    dragHandle.className = 'focus-drag';
    dragHandle.draggable = true;
    dragHandle.title = '拖拽调整顺序';
    dragHandle.setAttribute('aria-label', '拖拽调整顺序');
    dragHandle.textContent = '⠿';
    dragHandle.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `focus:${focus.id}`);
      row.classList.add('drag-source');
    });
    dragHandle.addEventListener('dragend', () => row.classList.remove('drag-source'));
    row.addEventListener('dragover', event => {
      event.preventDefault();
      const bounds = row.getBoundingClientRect();
      const horizontal = (event.clientX - (bounds.left + bounds.width / 2)) / bounds.width;
      const vertical = (event.clientY - (bounds.top + bounds.height / 2)) / bounds.height;
      const position = Math.abs(horizontal) > Math.abs(vertical)
        ? (horizontal > 0 ? 'after' : 'before')
        : (vertical > 0 ? 'after' : 'before');
      row.dataset.dropPosition = position;
    });
    row.addEventListener('dragleave', () => delete row.dataset.dropPosition);
    row.addEventListener('drop', event => {
      event.preventDefault();
      const source = event.dataTransfer.getData('text/plain');
      const sourceId = source.startsWith('focus:') ? source.slice(6) : '';
      const position = row.dataset.dropPosition || 'before';
      delete row.dataset.dropPosition;
      if (sourceId && sourceId !== focus.id) queueAction({ type: 'moveFocus', personId: person.id, focusId: sourceId, targetId: focus.id, position });
    });
    const title = document.createElement('textarea');
    title.className = 'focus-item-title';
    title.rows = 3;
    title.maxLength = 100;
    title.value = focus.title;
    title.setAttribute('aria-label', '正在做的事情');
    const details = document.createElement('div');
    details.className = 'focus-item-details';
    const elapsed = document.createElement('span');
    elapsed.className = 'focus-elapsed';
    elapsed.textContent = focusTiming(focus);
    details.append(elapsed);
    const actions = document.createElement('div');
    actions.className = 'focus-item-actions';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'focus-delete';
    deleteButton.textContent = '×';
    deleteButton.title = '删除正在做的事项';
    deleteButton.setAttribute('aria-label', '删除正在做的事项');
    deleteButton.addEventListener('click', () => {
      cancelFocusEdits(person.id, focus.id);
      queueAction({ type: 'deleteFocus', personId: person.id, focusId: focus.id });
    });
    const returnButton = document.createElement('button');
    returnButton.type = 'button';
    returnButton.className = 'focus-clear';
    returnButton.textContent = '移回待办';
    returnButton.addEventListener('click', async () => {
      const currentTitle = title.value.trim();
      if (!currentTitle) return toast('事项名称不能为空');
      cancelFocusEdits(person.id, focus.id);
      try {
        await queueAction({ type: 'updateFocus', personId: person.id, focusId: focus.id, title: currentTitle, endsAt: focus.endsAt || '' });
        await queueAction({ type: 'clearFocus', personId: person.id, focusId: focus.id });
      } catch {}
    });
    const completeButton = document.createElement('button');
    completeButton.type = 'button';
    completeButton.className = 'focus-complete';
    completeButton.textContent = '完成';
    completeButton.addEventListener('click', async () => {
      const currentTitle = title.value.trim();
      if (!currentTitle) return toast('事项名称不能为空');
      cancelFocusEdits(person.id, focus.id);
      try {
        await queueAction({ type: 'updateFocus', personId: person.id, focusId: focus.id, title: currentTitle, endsAt: focus.endsAt || '' });
        await queueAction({ type: 'completeFocus', personId: person.id, focusId: focus.id });
        toast('完成时间已经记下来了');
      } catch {}
    });
    actions.append(returnButton, completeButton);
    let titleIsComposing = false;
    title.addEventListener('compositionstart', () => {
      titleIsComposing = true;
      beginFocusEdit(person.id, focus.id, title);
    });
    title.addEventListener('compositionend', () => {
      titleIsComposing = false;
      updateFocusDraft(person.id, focus.id, title);
      if (document.activeElement !== title) scheduleFocusCommit(person.id, focus.id, title);
    });
    title.addEventListener('focus', () => beginFocusEdit(person.id, focus.id, title));
    title.addEventListener('input', () => updateFocusDraft(person.id, focus.id, title));
    title.addEventListener('blur', event => {
      if (titleIsComposing) return;
      if (event.relatedTarget && row.contains(event.relatedTarget)) return;
      scheduleFocusCommit(person.id, focus.id, title);
    });
    title.addEventListener('keydown', event => {
      if (titleIsComposing || isImeConfirm(event)) return;
      if (event.key === 'Enter') { event.preventDefault(); title.blur(); }
      if (event.key === 'Escape') {
        event.preventDefault();
        title.value = focus.title;
        cancelFocusEdits(person.id, focus.id);
        title.blur();
      }
    });
    row.append(dragHandle, deleteButton, title, details, actions);
    list.append(row);
  }
}

function renderTodos(list, person) {
  const prefix = `${person.id}:todo:`;
  if ([...localValues.keys()].some(key => key.startsWith(prefix))) return;
  list.replaceChildren();
  const pending = person.todos.filter(todo => todoStatus(todo) === 'todo');
  if (!pending.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-todos';
    empty.textContent = '还没有待办，今天可以松口气。';
    list.append(empty);
    return;
  }
  for (const [index, todo] of pending.entries()) {
    const item = document.createElement('li');
    item.className = 'todo-item';
    item.classList.toggle('important', todo.important === true);
    item.draggable = true;
    item.dataset.todoId = todo.id;
    const schedule = todoSchedule(todo);
    const dateText = schedule.text;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = false;
    checkbox.setAttribute('aria-label', `标记 ${todo.text}${dateText ? `，${dateText}` : ''}`);
    checkbox.addEventListener('change', () => queueAction({ type: 'toggleTodo', personId: person.id, todoId: todo.id, done: checkbox.checked }));
    const copy = document.createElement('div');
    copy.className = 'todo-copy';
    const label = document.createElement('span');
    label.className = 'todo-label';
    label.textContent = todo.text;
    label.title = '点击修改';
    const beginEdit = event => {
      if (!label.isContentEditable) {
        label.contentEditable = 'true';
        beginTodoEdit(person.id, todo.id, label);
      }
      if (event.type === 'click' && document.activeElement !== label) label.focus();
    };
    label.addEventListener('pointerdown', beginEdit);
    label.addEventListener('click', beginEdit);
    label.addEventListener('focus', () => beginTodoEdit(person.id, todo.id, label));
    label.addEventListener('input', () => updateTodoDraft(person.id, todo.id, label));
    let todoIsComposing = false;
    label.addEventListener('compositionstart', () => {
      todoIsComposing = true;
      beginTodoEdit(person.id, todo.id, label);
    });
    label.addEventListener('compositionend', () => {
      todoIsComposing = false;
      updateTodoDraft(person.id, todo.id, label);
      if (document.activeElement !== label) scheduleTodoCommit(person.id, todo.id, label);
    });
    label.addEventListener('keydown', event => {
      if (todoIsComposing || isImeConfirm(event)) return;
      if (event.key === 'Enter') { event.preventDefault(); label.blur(); }
      if (event.key === 'Escape') {
        event.preventDefault();
        label.textContent = todo.text;
        cancelTodoEdit(person.id, todo.id);
        label.contentEditable = 'false';
        label.blur();
      }
    });
    label.addEventListener('blur', () => {
      label.contentEditable = 'false';
      if (todoIsComposing || !localValues.has(`${person.id}:todo:${todo.id}`)) return;
      scheduleTodoCommit(person.id, todo.id, label);
    });
    copy.append(label);
    if (dateText) {
      const date = document.createElement('time');
      date.className = 'todo-date';
      date.dateTime = schedule.dateTime;
      date.textContent = `（${dateText}）`;
      copy.append(date);
    }
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'todo-start';
    start.textContent = '开始做';
    start.addEventListener('click', async () => {
      try {
        await flushTodoEdits(person.id);
        await flushFocusEdits(person.id);
        await queueAction({ type: 'startTodo', personId: person.id, todoId: todo.id });
      } catch {}
    });
    const order = document.createElement('span');
    order.className = 'todo-order';
    const up = document.createElement('button');
    up.type = 'button'; up.textContent = '↑'; up.title = '上移'; up.disabled = index === 0;
    if (index > 0) up.addEventListener('click', () => queueAction({ type: 'moveTodo', personId: person.id, todoId: todo.id, targetId: pending[index - 1].id, position: 'before' }));
    const down = document.createElement('button');
    down.type = 'button'; down.textContent = '↓'; down.title = '下移'; down.disabled = index === pending.length - 1;
    if (index < pending.length - 1) down.addEventListener('click', () => queueAction({ type: 'moveTodo', personId: person.id, todoId: todo.id, targetId: pending[index + 1].id, position: 'after' }));
    order.append(up, down);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '删除待办');
    remove.addEventListener('click', () => {
      cancelTodoEdit(person.id, todo.id);
      queueAction({ type: 'deleteTodo', personId: person.id, todoId: todo.id });
    });
    item.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `todo:${todo.id}`);
      item.classList.add('drag-source');
    });
    item.addEventListener('dragend', () => item.classList.remove('drag-source'));
    item.addEventListener('dragover', event => {
      event.preventDefault();
      const position = event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2 ? 'after' : 'before';
      item.dataset.dropPosition = position;
    });
    item.addEventListener('dragleave', () => delete item.dataset.dropPosition);
    item.addEventListener('drop', event => {
      event.preventDefault();
      const source = event.dataTransfer.getData('text/plain');
      const sourceId = source.startsWith('todo:') ? source.slice(5) : '';
      const position = item.dataset.dropPosition || 'before';
      delete item.dataset.dropPosition;
      if (sourceId && sourceId !== todo.id) queueAction({ type: 'moveTodo', personId: person.id, todoId: sourceId, targetId: todo.id, position });
    });
    item.append(checkbox, copy, start, order, remove);
    list.append(item);
  }
}

function todoStatus(todo) {
  return todo.status || (todo.done ? 'done' : 'todo');
}

function renderCompleted(list, person) {
  list.replaceChildren();
  const completed = person.todos.filter(todo => todoStatus(todo) === 'done').sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  if (!completed.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-todos';
    empty.textContent = '完成的事情会出现在这里。';
    list.append(empty);
    return;
  }
  for (const todo of completed) {
    const item = document.createElement('li');
    item.className = 'completed-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.setAttribute('aria-label', `将 ${todo.text} 移回待办`);
    checkbox.addEventListener('change', () => queueAction({ type: 'toggleTodo', personId: person.id, todoId: todo.id, done: false }));
    const content = document.createElement('div');
    const label = document.createElement('span');
    const dateText = todoSchedule(todo).text;
    label.textContent = `${todo.text}${dateText ? `（${dateText}）` : ''}`;
    const time = document.createElement('time');
    time.dateTime = todo.completedAt || '';
    time.textContent = completedTime(todo.completedAt);
    content.append(label, time);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'completed-restore';
    restore.textContent = '放回待办';
    restore.setAttribute('aria-label', `将 ${todo.text} 放回待办`);
    restore.addEventListener('click', () => queueAction({ type: 'toggleTodo', personId: person.id, todoId: todo.id, done: false }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '删除完成记录');
    remove.addEventListener('click', () => queueAction({ type: 'deleteTodo', personId: person.id, todoId: todo.id }));
    item.append(checkbox, content, restore, remove);
    list.append(item);
  }
}

function completedTime(iso) {
  if (!iso) return '完成时间未记录';
  return `${new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 完成`;
}

function focusTiming(focus) {
  if (!focus?.title || !focus.startedAt) return '尚未开始';
  const started = new Date(focus.startedAt);
  if (Number.isNaN(started.getTime())) return '正在进行';
  const minutes = Math.max(0, Math.floor((Date.now() - started.getTime()) / 60000));
  let elapsed;
  if (minutes < 1) elapsed = '刚刚开始';
  else if (minutes < 60) elapsed = `已进行 ${minutes} 分钟`;
  else if (minutes < 1440) elapsed = `已进行 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  else elapsed = `已进行 ${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时`;
  const sameDay = started.toDateString() === new Date().toDateString();
  const startText = started.toLocaleString('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${startText} 开始 · ${elapsed}`;
}

function updateFocusTimers() {
  if (!state) return;
  for (const person of state.people) {
    const board = boardsEl.querySelector(`[data-person="${person.id}"]`);
    if (!board) continue;
    for (const focus of person.focuses) {
      const elapsed = board.querySelector(`[data-focus-id="${focus.id}"] .focus-elapsed`);
      if (elapsed) elapsed.textContent = focusTiming(focus);
    }
  }
}

function filteredWallItems() {
  return [...state.wall]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .filter(item => wallFilters.kind === 'all' || (item.kind || 'note') === wallFilters.kind)
    .filter(item => wallFilters.style === 'all' || (item.style || 'paper') === wallFilters.style)
    .filter(item => !wallFilters.featured || item.featured === true);
}

function renderWall() {
  wallEl.replaceChildren();
  wallEl.style.height = '';
  wallEl.classList.toggle('list-view', wallView === 'list');
  const filtered = filteredWallItems();
  const items = filtered.slice(0, visibleWallItems);
  wallEl.classList.toggle('empty-wall', items.length === 0);
  if (!items.length) {
    wallEl.textContent = state.wall.length ? '没有符合当前筛选的贴贴。' : '墙上还是空的，贴下第一句话或第一张图吧。';
  } else {
    for (const item of items) wallEl.append(wallCard(item));
    if (wallView === 'grid') scheduleWallLayout();
  }
  showMoreButton.hidden = visibleWallItems >= filtered.length;
  renderWallControls();
}

function appendMoreWallItems() {
  const filtered = filteredWallItems();
  const renderedCount = wallEl.querySelectorAll(':scope > .wall-card').length;
  const nextItems = filtered.slice(renderedCount, renderedCount + WALL_PAGE_SIZES[wallView]);
  const fragment = document.createDocumentFragment();
  for (const item of nextItems) fragment.append(wallCard(item));
  wallEl.append(fragment);
  visibleWallItems = renderedCount + nextItems.length;
  showMoreButton.hidden = visibleWallItems >= filtered.length;
  if (wallView === 'grid') scheduleWallLayout();
}

function wallCard(item) {
  const person = state.people.find(p => p.id === item.authorId) || state.people[0];
  const card = document.createElement('article');
  card.className = `wall-card${item.featured ? ' featured' : ''}`;
  const kind = item.kind || 'note';
  card.dataset.kind = kind;
  card.dataset.style = item.style || 'paper';
  card.classList.toggle('has-images', Boolean((item.images || []).length));
  if (item.featured && kind !== 'diary') {
    const featured = document.createElement('span');
    featured.className = 'wall-featured-badge';
    featured.textContent = '✦ 精华';
    card.append(featured);
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'wall-edit';
  edit.textContent = '✎';
  edit.setAttribute('aria-label', '修改这条内容');
  edit.addEventListener('click', () => openWallEditor(item));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'wall-delete';
  remove.textContent = '×';
  remove.setAttribute('aria-label', '删除这条内容');
  remove.addEventListener('click', () => {
    if (confirm('要把这条从墙上取下来吗？')) queueAction({ type: 'deleteWall', itemId: item.id });
  });
  card.append(edit, remove);
  if (kind === 'diary') {
    const diaryHeader = document.createElement('header');
    diaryHeader.className = 'diary-header';
    const diaryLabel = document.createElement('span');
    diaryLabel.textContent = item.featured ? '✦ 精华日记' : 'DIARY · 日记';
    const diaryDate = document.createElement('time');
    diaryDate.dateTime = item.createdAt;
    diaryDate.textContent = new Date(item.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
    diaryHeader.append(diaryLabel, diaryDate);
    card.append(diaryHeader);
  }
  const sources = item.images || [];
  if (sources.length) {
    const gallery = document.createElement('div');
    gallery.className = 'wall-gallery';
    const images = document.createElement('div');
    images.className = 'wall-images';
    images.dataset.count = String(sources.length);
    images.classList.toggle('multi', sources.length > 1);
    let galleryDragged = false;
    for (const [index, source] of sources.entries()) {
      const img = document.createElement('img');
      img.className = 'wall-image';
      img.alt = item.text ? item.text.slice(0, 60) : '贴图区图片';
      img.loading = 'lazy';
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', `预览第 ${index + 1} 张图片`);
      img.addEventListener('load', scheduleWallLayout, { once: true });
      img.addEventListener('click', () => {
        if (galleryDragged) { galleryDragged = false; return; }
        openImagePreview(sources, index);
      });
      img.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openImagePreview(sources, index); }
      });
      img.src = source;
      images.append(img);
    }
    gallery.append(images);
    if (sources.length > 1) {
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'wall-gallery-nav previous';
      previous.textContent = '‹';
      previous.setAttribute('aria-label', '上一张图片');
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'wall-gallery-nav next';
      next.textContent = '›';
      next.setAttribute('aria-label', '下一张图片');
      const count = document.createElement('span');
      count.className = 'wall-gallery-count';
      count.textContent = `1 / ${sources.length}`;
      const currentIndex = () => Math.max(0, Math.min(sources.length - 1, Math.round(images.scrollLeft / Math.max(1, images.clientWidth))));
      const updateCount = () => { count.textContent = `${currentIndex() + 1} / ${sources.length}`; };
      const move = offset => images.scrollTo({ left: (currentIndex() + offset + sources.length) % sources.length * images.clientWidth, behavior: 'smooth' });
      previous.addEventListener('click', () => move(-1));
      next.addEventListener('click', () => move(1));
      images.addEventListener('scroll', updateCount, { passive: true });
      images.addEventListener('wheel', event => {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        const atStart = images.scrollLeft <= 1;
        const atEnd = images.scrollLeft + images.clientWidth >= images.scrollWidth - 1;
        if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;
        event.preventDefault();
        images.scrollBy({ left: delta, behavior: 'auto' });
      }, { passive: false });
      let dragStartX = 0;
      let dragScrollStart = 0;
      images.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        dragStartX = event.clientX;
        dragScrollStart = images.scrollLeft;
        galleryDragged = false;
        images.classList.add('dragging');
        images.setPointerCapture(event.pointerId);
      });
      images.addEventListener('pointermove', event => {
        if (!images.hasPointerCapture(event.pointerId)) return;
        const distance = event.clientX - dragStartX;
        if (Math.abs(distance) > 4) galleryDragged = true;
        images.scrollLeft = dragScrollStart - distance;
      });
      const stopDragging = event => {
        if (images.hasPointerCapture(event.pointerId)) images.releasePointerCapture(event.pointerId);
        images.classList.remove('dragging');
        setTimeout(() => { galleryDragged = false; }, 0);
      };
      images.addEventListener('pointerup', stopDragging);
      images.addEventListener('pointercancel', stopDragging);
      gallery.append(previous, next, count);
    }
    card.append(gallery);
  }
  const copy = document.createElement('div');
  copy.className = 'wall-copy';
  if (item.text) {
    const text = document.createElement('p');
    text.className = 'wall-text';
    text.textContent = item.text;
    if (wallView === 'list' && item.text.length > ((item.kind || 'note') === 'diary' ? 55 : 75)) {
      card.classList.add('has-long-text');
      text.tabIndex = 0;
      text.setAttribute('role', 'button');
      text.title = '点击展开全文';
      const toggleText = () => {
        const expanded = card.classList.toggle('text-expanded');
        text.title = expanded ? '点击收起' : '点击展开全文';
        text.setAttribute('aria-expanded', String(expanded));
      };
      text.addEventListener('click', toggleText);
      text.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleText(); }
      });
    }
    copy.append(text);
  }
  const meta = document.createElement('div');
  meta.className = 'wall-meta';
  const author = document.createElement('span');
  author.className = 'wall-author';
  author.append(avatarNode(person, 'mini-avatar'), document.createTextNode(person.name));
  const time = document.createElement('time');
  time.dateTime = item.createdAt;
  time.textContent = relativeTime(item.createdAt);
  meta.append(author, time);
  copy.append(meta);
  card.append(copy);
  return card;
}

function scheduleWallLayout() {
  cancelAnimationFrame(wallLayoutFrame);
  wallLayoutFrame = requestAnimationFrame(layoutWall);
}

function layoutWall() {
  if (wallEl.classList.contains('empty-wall') || wallView === 'list') {
    wallEl.style.height = '';
    return;
  }
  const width = wallEl.clientWidth;
  if (!width) return;
  const columns = width >= 1050 ? 5 : width >= 800 ? 4 : width >= 560 ? 3 : width >= 390 ? 2 : 1;
  const gap = width >= 560 ? 9 : 7;
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const cards = [...wallEl.children];
  for (const card of cards) card.style.width = `${cardWidth}px`;
  const heights = Array(columns).fill(0);
  for (const card of cards) {
    const column = heights.indexOf(Math.min(...heights));
    const x = column * (cardWidth + gap);
    const y = heights[column];
    card.style.transform = `translate(${x}px, ${y}px)`;
    heights[column] += card.offsetHeight + gap;
  }
  wallEl.style.height = `${Math.max(0, ...heights) - (cards.length ? gap : 0)}px`;
}

function renderWallControls() {
  for (const button of wallTools.querySelectorAll('[data-wall-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.wallView === wallView));
  }
  for (const button of wallFilterPanel.querySelectorAll('[data-filter-kind]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filterKind === wallFilters.kind));
  }
  for (const button of wallFilterPanel.querySelectorAll('[data-filter-style]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filterStyle === wallFilters.style));
  }
  filterFeatured.checked = wallFilters.featured;
}

function renderComposeWallOptions() {
  for (const button of composer.querySelectorAll('[data-compose-kind]')) {
    button.setAttribute('aria-pressed', String(button.dataset.composeKind === composeWallKind));
  }
  for (const button of composer.querySelectorAll('[data-compose-style]')) {
    button.setAttribute('aria-pressed', String(button.dataset.composeStyle === composeWallStyle));
  }
}

function renderWallEditOptions() {
  for (const button of wallEditModal.querySelectorAll('[data-edit-kind]')) {
    button.setAttribute('aria-pressed', String(button.dataset.editKind === editingWallKind));
  }
  for (const button of wallEditModal.querySelectorAll('[data-edit-style]')) {
    button.setAttribute('aria-pressed', String(button.dataset.editStyle === editingWallStyle));
  }
}

function openWallEditor(item) {
  editingWallId = item.id;
  editingWallKind = item.kind || 'note';
  editingWallStyle = item.style || 'paper';
  wallEditText.value = item.text || '';
  wallEditFeatured.checked = item.featured === true;
  editingWallImages = (item.images || []).map(url => ({ url }));
  renderWallEditImages();
  renderWallEditOptions();
  wallEditModal.hidden = false;
  setTimeout(() => wallEditText.focus(), 50);
}

function closeWallEditor() {
  for (const image of editingWallImages) if (image.preview) URL.revokeObjectURL(image.preview);
  editingWallImages = [];
  wallEditModal.hidden = true;
  editingWallId = undefined;
}

function addWallEditFiles(files) {
  for (const file of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) continue;
    if (file.size > 8 * 1024 * 1024) { toast('每张图片不能超过 8 MB'); continue; }
    if (editingWallImages.length >= 8) { toast('一条贴贴最多保留 8 张图片'); break; }
    editingWallImages.push({ file, preview: URL.createObjectURL(file) });
  }
  renderWallEditImages();
}

function renderWallEditImages() {
  wallEditImagesEl.replaceChildren();
  wallEditImageCount.textContent = `${editingWallImages.length} / 8`;
  const sources = editingWallImages.map(image => image.url || image.preview);
  for (const [index, image] of editingWallImages.entries()) {
    const thumb = document.createElement('figure');
    thumb.className = 'wall-edit-thumb';
    const preview = document.createElement('img');
    preview.src = image.url || image.preview;
    preview.alt = `第 ${index + 1} 张图片`;
    preview.addEventListener('click', () => openImagePreview(sources, index));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `删除第 ${index + 1} 张图片`);
    remove.addEventListener('click', () => {
      if (image.preview) URL.revokeObjectURL(image.preview);
      editingWallImages.splice(index, 1);
      renderWallEditImages();
    });
    thumb.append(preview, remove);
    wallEditImagesEl.append(thumb);
  }
  document.querySelector('#addWallEditImages').disabled = editingWallImages.length >= 8;
}

function openImagePreview(images, index = 0) {
  clearTimeout(imagePreviewCloseTimer);
  previewImages = images.filter(Boolean);
  if (!previewImages.length) return;
  previewImageIndex = Math.max(0, Math.min(index, previewImages.length - 1));
  renderImagePreview(false);
  imagePreview.hidden = false;
  imagePreview.classList.remove('is-open');
  void imagePreview.offsetWidth;
  imagePreview.classList.add('is-open');
}

function renderImagePreview(animate = true) {
  imagePreviewImage.classList.remove('is-switching');
  imagePreviewImage.src = previewImages[previewImageIndex] || '';
  if (animate) {
    void imagePreviewImage.offsetWidth;
    imagePreviewImage.classList.add('is-switching');
  }
  imagePreviewCount.textContent = previewImages.length > 1 ? `${previewImageIndex + 1} / ${previewImages.length}` : '';
  imagePreviewPrevious.hidden = previewImages.length <= 1;
  imagePreviewNext.hidden = previewImages.length <= 1;
}

function moveImagePreview(offset) {
  if (previewImages.length <= 1) return;
  previewImageIndex = (previewImageIndex + offset + previewImages.length) % previewImages.length;
  renderImagePreview();
}

function closeImagePreview() {
  if (imagePreview.hidden) return;
  imagePreview.classList.remove('is-open');
  clearTimeout(imagePreviewCloseTimer);
  imagePreviewCloseTimer = setTimeout(() => {
    imagePreview.hidden = true;
    imagePreviewImage.removeAttribute('src');
    imagePreviewImage.classList.remove('is-switching');
    previewImages = [];
  }, 340);
}

function renderIdentity() {
  const person = state.people.find(p => p.id === identity);
  identityButton.textContent = person?.name || '选择身份';
  identityChoices.replaceChildren();
  for (const candidate of state.people) {
    const choice = document.createElement('button');
    choice.className = 'identity-choice';
    choice.type = 'button';
    choice.append(avatarNode(candidate), document.createTextNode(candidate.name));
    choice.addEventListener('click', () => chooseIdentity(candidate.id));
    identityChoices.append(choice);
  }
}

function renderIntro() {
  const intro = state.intro || { title: '今天，也在好好生活。', color: 'ink' };
  if (!editingIntro) introTitle.textContent = intro.title;
  introTitle.dataset.color = intro.color;
  for (const button of introColors.querySelectorAll('[data-title-color]')) {
    button.setAttribute('aria-pressed', String(button.dataset.titleColor === intro.color));
  }
}

function beginIntroEdit() {
  if (!state || editingIntro) return;
  editingIntro = true;
  introTitle.contentEditable = 'true';
  introTitle.classList.add('editing');
  introColors.hidden = false;
  introTitle.focus();
}

function finishIntroEdit(cancel = false) {
  if (!editingIntro) return;
  editingIntro = false;
  introTitle.contentEditable = 'false';
  introTitle.classList.remove('editing');
  if (cancel) {
    renderIntro();
    return;
  }
  const title = (introTitle.textContent || '').replace(/\s+/g, ' ').trim();
  if (!title) {
    toast('标题不能为空');
    renderIntro();
    return;
  }
  if (title.length > 50) {
    toast('标题不能超过 50 个字');
    renderIntro();
    return;
  }
  introTitle.textContent = title;
  if (title !== state.intro.title) queueAction({ type: 'setIntro', title, color: state.intro.color }).catch(() => {});
}

function renderPresence() {
  if (!state) return;
  for (const person of state.people) {
    const board = boardsEl.querySelector(`[data-person="${person.id}"]`);
    if (!board) continue;
    const current = presence[person.id] || { status: 'away', lastSeenAt: null };
    const sleeping = current.status === 'sleeping' || (identity === person.id && manuallySleeping);
    const displayStatus = sleeping ? 'sleeping' : current.status;
    board.dataset.presence = displayStatus;
    const badge = board.querySelector('.presence-badge');
    const label = displayStatus === 'online' ? '在线' : displayStatus === 'sleeping' ? '睡觉中' : '离开';
    badge.dataset.status = displayStatus;
    badge.querySelector('span').textContent = label;
    badge.title = displayStatus === 'online'
      ? '网页正在打开'
      : displayStatus === 'sleeping'
        ? '主动设置为睡觉中'
        : current.lastSeenAt ? `最后在线：${relativeTime(current.lastSeenAt)}` : '目前不在网页中';
    const toggle = board.querySelector('.presence-toggle');
    toggle.hidden = identity !== person.id;
    toggle.textContent = sleeping ? '☀️' : '🌙';
    toggle.classList.toggle('is-sleeping', sleeping);
    toggle.setAttribute('aria-label', sleeping ? '醒来并恢复在线' : '进入睡觉状态');
    toggle.title = sleeping ? '我醒了' : '去睡觉';
  }
}

function gpuMachineSummary(machine) {
  const gpus = machine.nodes.flatMap(node => node.gpus);
  const busy = gpus.filter(gpu => gpu.inUse).length;
  const memoryUsedMiB = gpus.reduce((total, gpu) => total + (gpu.memoryUsedMiB || 0), 0);
  const memoryTotalMiB = gpus.reduce((total, gpu) => total + (gpu.memoryTotalMiB || 0), 0);
  const utilizationPercent = gpus.length
    ? Math.round(gpus.reduce((total, gpu) => total + (gpu.utilizationPercent || 0), 0) / gpus.length)
    : 0;
  return { gpus, busy, idle: gpus.length - busy, memoryUsedMiB, memoryTotalMiB, utilizationPercent };
}

function formatGpuMemory(value) {
  const mib = Number(value) || 0;
  if (mib >= 1024) return `${(mib / 1024).toFixed(mib >= 10240 ? 0 : 1)} GB`;
  return `${Math.round(mib)} MB`;
}

function formatGpuIdleDuration(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return '不到 1 分钟';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function gpuMetric(label, value) {
  const item = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = value;
  item.append(strong, document.createTextNode(label));
  return item;
}

function gpuProgress(className, value) {
  const track = document.createElement('span');
  track.className = `gpu-progress ${className}`;
  const fill = document.createElement('i');
  fill.style.width = `${Math.max(0, Math.min(100, value || 0))}%`;
  track.append(fill);
  return track;
}

function gpuStatusNode(machine, className = 'gpu-machine-status') {
  const status = document.createElement('span');
  status.className = className;
  const dot = document.createElement('i');
  status.append(dot, document.createTextNode(machine.online ? '在线' : '断联'));
  return status;
}

function gpuCardRects() {
  return new Map([...gpuMachinesEl.querySelectorAll('.gpu-machine')].map(card => [card.dataset.machine, card.getBoundingClientRect()]));
}

function animateGpuCards(previousRects) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const card of gpuMachinesEl.querySelectorAll('.gpu-machine')) {
    const previous = previousRects.get(card.dataset.machine);
    if (!previous) continue;
    const current = card.getBoundingClientRect();
    const x = previous.left - current.left;
    const y = previous.top - current.top;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
    card.animate([
      { transform: `translate(${x}px, ${y}px)`, zIndex: 3 },
      { transform: 'translate(0, 0)', zIndex: 3 },
    ], { duration: 280, easing: 'cubic-bezier(.2,.78,.24,1)' });
  }
}

function gpuMachinesWithFreshData(order, fresh) {
  const byName = new Map(fresh.map(machine => [machine.name, machine]));
  return order.map(machine => byName.get(machine.name) || machine).filter(Boolean);
}

async function moveGpuMachine(sourceName, targetName, position) {
  if (gpuOrderSaving || sourceName === targetName) return;
  const previous = [...gpuMachines];
  const source = previous.find(machine => machine.name === sourceName);
  if (!source || !previous.some(machine => machine.name === targetName)) return;
  const next = previous.filter(machine => machine.name !== sourceName);
  let targetIndex = next.findIndex(machine => machine.name === targetName);
  if (position === 'after') targetIndex += 1;
  next.splice(targetIndex, 0, source);
  if (next.every((machine, index) => machine.name === previous[index]?.name)) return;

  const rects = gpuCardRects();
  gpuMachines = next;
  gpuOrderSaving = true;
  setStatus('正在保存顺序');
  renderGpuMachines(true);
  animateGpuCards(rects);
  requestAnimationFrame(() => {
    const moved = [...gpuMachinesEl.querySelectorAll('.gpu-machine')].find(card => card.dataset.machine === sourceName);
    moved?.querySelector('.gpu-machine-toggle')?.focus({ preventScroll: true });
  });
  try {
    const result = await api('/gpu/order', { method: 'POST', body: JSON.stringify({ machines: next.map(machine => machine.name) }) });
    const ordered = result.gpuMachines || next;
    gpuMachines = gpuMachinesWithFreshData(ordered, deferredGpuMachines || ordered);
    deferredGpuMachines = null;
    setStatus('已同步', 'saved');
  } catch (error) {
    const fresh = deferredGpuMachines || previous;
    gpuMachines = gpuMachinesWithFreshData(previous, fresh);
    deferredGpuMachines = null;
    renderGpuMachines(true);
    toast(error.message);
    setStatus('同步失败', 'error');
  } finally {
    gpuOrderSaving = false;
  }
}

function clearGpuDropTarget() {
  for (const card of gpuMachinesEl.querySelectorAll('[data-drop-position]')) delete card.dataset.dropPosition;
}

function activateGpuDrag(drag) {
  if (!drag || drag.active || gpuDragState !== drag) return;
  drag.active = true;
  drag.card.classList.add('drag-source');
  gpuMachinesEl.classList.add('is-reordering');
  document.body.classList.add('gpu-card-dragging');
  drag.ghost = drag.card.cloneNode(true);
  drag.ghost.className = 'gpu-machine gpu-drag-ghost';
  drag.ghost.removeAttribute('data-drop-position');
  drag.ghost.style.width = `${drag.width}px`;
  drag.ghost.style.left = `${drag.startX - drag.offsetX}px`;
  drag.ghost.style.top = `${drag.startY - drag.offsetY}px`;
  document.body.append(drag.ghost);
  try { drag.card.setPointerCapture(drag.pointerId); } catch {}
  if (drag.pointerType === 'touch') navigator.vibrate?.(12);
}

function beginGpuDrag(event, machine, card) {
  if (gpuDragState || gpuOrderSaving || !event.isPrimary || event.button > 0 || event.target.closest('.gpu-machine-delete')) return;
  delete card.dataset.justDragged;
  const bounds = card.getBoundingClientRect();
  const drag = {
    sourceName: machine.name, pointerId: event.pointerId, pointerType: event.pointerType, card,
    startX: event.clientX, startY: event.clientY,
    offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top,
    width: bounds.width, active: false, targetName: '', position: '', ghost: null, holdTimer: null,
  };
  gpuDragState = drag;
  // Capture only after a deliberate hold, so a normal click reaches its button.
  drag.holdTimer = setTimeout(() => activateGpuDrag(drag), 300);
}

function updateGpuDrag(event) {
  const drag = gpuDragState;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.active) {
    // Moving before the hold finishes is ordinary scrolling or pointer movement.
    if (distance > 8) clearTimeout(drag.holdTimer);
    return;
  }
  event.preventDefault();
  drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
  drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;

  const target = document.elementsFromPoint(event.clientX, event.clientY)
    .map(element => element.closest?.('.gpu-machine'))
    .find(element => element && element !== drag.card && !element.classList.contains('gpu-drag-ghost') && gpuMachinesEl.contains(element));
  clearGpuDropTarget();
  if (!target) {
    drag.targetName = '';
    return;
  }
  const bounds = target.getBoundingClientRect();
  const columns = getComputedStyle(gpuMachinesEl).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  const position = columns > 1
    ? (event.clientX > bounds.left + bounds.width / 2 ? 'after' : 'before')
    : (event.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before');
  target.dataset.dropPosition = position;
  drag.targetName = target.dataset.machine;
  drag.position = position;
}

function finishGpuDrag(event) {
  const drag = gpuDragState;
  if (!drag || event.pointerId !== drag.pointerId) return;
  clearTimeout(drag.holdTimer);
  const shouldMove = event.type !== 'pointercancel' && drag.active && drag.targetName;
  const { sourceName, targetName, position } = drag;
  if (drag.active) {
    drag.card.dataset.justDragged = 'true';
  }
  drag.card.classList.remove('drag-source');
  drag.ghost?.remove();
  clearGpuDropTarget();
  gpuMachinesEl.classList.remove('is-reordering');
  document.body.classList.remove('gpu-card-dragging');
  gpuDragState = null;
  // Let the following click finish before a reorder or poll replaces its target.
  setTimeout(() => {
    if (gpuDragState || gpuOrderSaving) return;
    if (shouldMove) moveGpuMachine(sourceName, targetName, position);
    else if (deferredGpuMachines) {
      gpuMachines = deferredGpuMachines;
      deferredGpuMachines = null;
      renderGpuMachines(true);
    }
  }, 0);
}

function moveGpuMachineByKeyboard(event, machineName) {
  if (!event.altKey || !['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key) || gpuOrderSaving) return;
  const index = gpuMachines.findIndex(machine => machine.name === machineName);
  const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  const targetIndex = index + (backwards ? -1 : 1);
  if (index < 0 || targetIndex < 0 || targetIndex >= gpuMachines.length) return;
  event.preventDefault();
  moveGpuMachine(machineName, gpuMachines[targetIndex].name, backwards ? 'before' : 'after');
}

function gpuCard(machine) {
  const summary = gpuMachineSummary(machine);
  const card = document.createElement('article');
  card.className = `gpu-machine${machine.online ? '' : ' offline'}`;
  card.dataset.machine = machine.name;
  card.title = '点击查看详情，按住后拖动调整顺序';
  card.addEventListener('pointerdown', event => beginGpuDrag(event, machine, card));
  card.addEventListener('click', event => {
    if (event.target.closest('.gpu-machine-delete')) return;
    // Pointer capture targets the card on drag release; keyboard clicks still work.
    if (event.detail && (card.dataset.justDragged || gpuDragState?.active)) return event.preventDefault();
    openGpuDetails(machine.name);
  });
  card.addEventListener('contextmenu', event => {
    if (gpuDragState?.card === card) event.preventDefault();
  });
  card.addEventListener('touchmove', event => {
    if (gpuDragState?.card === card && gpuDragState.active) event.preventDefault();
  }, { passive: false });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'gpu-machine-toggle';
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-label', `查看 ${machine.name} 的 GPU 详情；按住卡片可拖动，Alt 加方向键可调整顺序`);
  toggle.addEventListener('keydown', event => moveGpuMachineByKeyboard(event, machine.name));

  const titleRow = document.createElement('span');
  titleRow.className = 'gpu-machine-title-row';
  const title = document.createElement('strong');
  title.className = 'gpu-machine-name';
  title.textContent = machine.name;
  const openIcon = document.createElement('span');
  openIcon.className = 'gpu-open-icon';
  openIcon.textContent = '↗';
  titleRow.append(title, gpuStatusNode(machine), openIcon);

  const stats = document.createElement('span');
  stats.className = 'gpu-machine-stats';
  stats.append(
    gpuMetric('张卡', String(summary.gpus.length)),
    gpuMetric('占用', String(summary.busy)),
    gpuMetric('闲置', String(summary.idle)),
  );

  const load = document.createElement('span');
  load.className = 'gpu-machine-load';
  const memoryPercent = summary.memoryTotalMiB ? Math.round(summary.memoryUsedMiB / summary.memoryTotalMiB * 100) : 0;
  const utilRow = document.createElement('span');
  utilRow.append(document.createTextNode(`平均负载 ${summary.utilizationPercent}%`), gpuProgress('util', summary.utilizationPercent));
  const memoryRow = document.createElement('span');
  memoryRow.append(document.createTextNode(`显存 ${formatGpuMemory(summary.memoryUsedMiB)} / ${formatGpuMemory(summary.memoryTotalMiB)}`), gpuProgress('memory', memoryPercent));
  load.append(utilRow, memoryRow);

  const foot = document.createElement('span');
  foot.className = 'gpu-machine-foot';
  foot.textContent = `${machine.nodes.length} 个节点 · ${machine.online ? '更新于' : '最后上报'} ${relativeTime(machine.updatedAt)}`;
  toggle.append(titleRow, stats, load, foot);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'gpu-machine-delete';
  remove.textContent = '×';
  remove.title = `删除 ${machine.name}`;
  remove.setAttribute('aria-label', `删除机器 ${machine.name}`);
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      const result = await api('/gpu/machine', { method: 'DELETE', body: JSON.stringify({ machine: machine.name }) });
      gpuMachines = result.gpuMachines || [];
      if (openGpuMachineName === machine.name) closeGpuDetails();
      renderGpuMachines();
      toast(`${machine.name} 已从监控中删除`);
    } catch (error) {
      remove.disabled = false;
      toast(error.message);
    }
  });

  card.append(toggle, remove);
  return card;
}

function openGpuDetails(machineName) {
  clearTimeout(gpuDetailCloseTimer);
  openGpuMachineName = machineName;
  renderGpuDetail(true);
  gpuDetailModal.hidden = false;
  document.body.classList.add('gpu-detail-open');
  requestAnimationFrame(() => gpuDetailModal.classList.add('is-open'));
  setTimeout(() => gpuDetailClose.focus(), 80);
}

function closeGpuDetails() {
  if (gpuDetailModal.hidden) return;
  gpuDetailModal.classList.remove('is-open');
  document.body.classList.remove('gpu-detail-open');
  clearTimeout(gpuDetailCloseTimer);
  gpuDetailCloseTimer = setTimeout(() => {
    gpuDetailModal.hidden = true;
    openGpuMachineName = '';
    renderedGpuDetailKey = '';
    gpuDetailContent.replaceChildren();
  }, 240);
}

function renderGpuProcessList(gpu) {
  const area = document.createElement('section');
  area.className = `gpu-detail-processes${gpu.processes.length ? ' has-processes' : ''}`;
  const heading = document.createElement('div');
  heading.className = 'gpu-detail-process-heading';
  const label = document.createElement('strong');
  label.textContent = '占用进程';
  const count = document.createElement('span');
  count.textContent = gpu.processes.length ? `${gpu.processes.length} 个` : '无';
  heading.append(label, count);
  area.append(heading);

  if (!gpu.processes.length) {
    const empty = document.createElement('p');
    empty.textContent = gpu.inUse ? '显存正在使用，但未获取到计算进程' : '当前没有计算进程';
    area.append(empty);
    return area;
  }

  const list = document.createElement('div');
  list.className = 'gpu-detail-process-list';
  for (const process of gpu.processes) {
    const row = document.createElement('div');
    row.className = 'gpu-detail-process-row';
    const commandArea = document.createElement('div');
    commandArea.className = 'gpu-detail-process-command';
    const command = document.createElement('strong');
    command.textContent = process.command;
    command.title = process.command;
    commandArea.append(command);
    if (process.cwd) {
      const cwd = document.createElement('small');
      cwd.textContent = process.cwd;
      cwd.title = process.cwd;
      commandArea.append(cwd);
    }
    const meta = document.createElement('span');
    meta.textContent = `${process.user} · PID ${process.pid}${process.memoryUsedMiB === null ? '' : ` · ${formatGpuMemory(process.memoryUsedMiB)} 显存`}`;
    row.append(commandArea, meta);
    list.append(row);
  }
  area.append(list);
  return area;
}

function gpuDetailRow(gpu) {
  const row = document.createElement('article');
  row.className = `gpu-detail-gpu-row${gpu.inUse ? ' busy' : ''}`;

  const identityArea = document.createElement('div');
  identityArea.className = 'gpu-detail-gpu-identity';
  const titleRow = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `GPU ${gpu.index}`;
  const state = document.createElement('span');
  state.className = 'gpu-detail-gpu-state';
  const idleDuration = formatGpuIdleDuration(gpu.idleSince);
  state.textContent = gpu.inUse ? '占用中' : idleDuration ? `空闲 ${idleDuration}` : '空闲';
  if (!gpu.inUse && gpu.idleSince) state.title = `从 ${new Date(gpu.idleSince).toLocaleString('zh-CN')} 开始空闲`;
  titleRow.append(title, state);
  const model = document.createElement('span');
  model.className = 'gpu-detail-gpu-model';
  model.textContent = gpu.name;
  model.title = gpu.uuid || gpu.name;
  identityArea.append(titleRow, model);

  const performance = document.createElement('div');
  performance.className = 'gpu-detail-performance';
  const utilization = document.createElement('div');
  utilization.className = 'gpu-detail-meter';
  const utilizationText = document.createElement('span');
  utilizationText.append(document.createTextNode('利用率'), Object.assign(document.createElement('strong'), { textContent: `${Math.round(gpu.utilizationPercent || 0)}%` }));
  utilization.append(utilizationText, gpuProgress('util', gpu.utilizationPercent));

  const memory = document.createElement('div');
  memory.className = 'gpu-detail-meter';
  const memoryText = document.createElement('span');
  memoryText.append(document.createTextNode('显存'), Object.assign(document.createElement('strong'), { textContent: `${formatGpuMemory(gpu.memoryUsedMiB)} / ${formatGpuMemory(gpu.memoryTotalMiB)}` }));
  const memoryPercent = gpu.memoryTotalMiB ? gpu.memoryUsedMiB / gpu.memoryTotalMiB * 100 : 0;
  memory.append(memoryText, gpuProgress('memory', memoryPercent));

  const secondary = document.createElement('div');
  secondary.className = 'gpu-detail-secondary';
  if (gpu.temperatureC !== null) secondary.append(gpuMetric('温度', `${gpu.temperatureC}℃`));
  if (gpu.powerDrawW !== null) secondary.append(gpuMetric('功耗', gpu.powerLimitW === null ? `${gpu.powerDrawW} W` : `${gpu.powerDrawW} / ${gpu.powerLimitW} W`));
  performance.append(utilization, memory, secondary);

  row.append(identityArea, performance, renderGpuProcessList(gpu));
  return row;
}

function renderGpuDetail(force = false) {
  if (!openGpuMachineName) return;
  const machine = gpuMachines.find(item => item.name === openGpuMachineName);
  if (!machine) {
    closeGpuDetails();
    return;
  }

  const detailKey = `${machine.name}:${machine.updatedAt}:${machine.online}`;
  if (!force && detailKey === renderedGpuDetailKey) return;
  const previousScrollTop = gpuDetailContent.querySelector('.gpu-detail-body')?.scrollTop || 0;
  gpuDetailContent.replaceChildren();
  gpuDetailContent.classList.toggle('offline', !machine.online);
  const summary = gpuMachineSummary(machine);
  const header = document.createElement('header');
  header.className = 'gpu-detail-header';
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'GPU MONITOR';
  const titleRow = document.createElement('div');
  titleRow.className = 'gpu-detail-title-row';
  const title = document.createElement('h2');
  title.id = 'gpuDetailTitle';
  title.textContent = machine.name;
  titleRow.append(title, gpuStatusNode(machine, 'gpu-detail-status'));
  const meta = document.createElement('p');
  meta.className = 'gpu-detail-meta';
  meta.textContent = `${machine.nodes.length} 个节点 · ${machine.online ? '刚刚仍在上报' : `最后上报 ${relativeTime(machine.updatedAt)}`}`;

  const summaryBar = document.createElement('div');
  summaryBar.className = 'gpu-detail-summary';
  summaryBar.append(
    gpuMetric('节点', String(machine.nodes.length)),
    gpuMetric('GPU', String(summary.gpus.length)),
    gpuMetric('占用', String(summary.busy)),
    gpuMetric('空闲', String(summary.idle)),
    gpuMetric('平均负载', `${summary.utilizationPercent}%`),
  );
  header.append(eyebrow, titleRow, meta, summaryBar);

  const body = document.createElement('div');
  body.className = 'gpu-detail-body';
  if (!machine.nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'gpu-detail-empty';
    empty.textContent = '这台机器还没有上报节点。';
    body.append(empty);
  }
  for (const node of machine.nodes) {
    const section = document.createElement('section');
    section.className = 'gpu-detail-node';
    const nodeHeading = document.createElement('header');
    const nodeName = document.createElement('h3');
    nodeName.textContent = node.name;
    const nodeCount = document.createElement('span');
    const busy = node.gpus.filter(gpu => gpu.inUse).length;
    nodeCount.textContent = `${busy} / ${node.gpus.length} 张占用`;
    nodeHeading.append(nodeName, nodeCount);

    const rows = document.createElement('div');
    rows.className = 'gpu-detail-rows';
    if (!node.gpus.length) {
      const empty = document.createElement('p');
      empty.className = 'gpu-detail-empty';
      empty.textContent = '没有检测到 GPU';
      rows.append(empty);
    } else {
      for (const gpu of node.gpus) rows.append(gpuDetailRow(gpu));
    }
    section.append(nodeHeading, rows);
    body.append(section);
  }
  gpuDetailContent.append(header, body);
  body.scrollTop = previousScrollTop;
  renderedGpuDetailKey = detailKey;
}
function renderGpuMachines(force = false) {
  if (!force && (gpuDragState || gpuOrderSaving)) return;
  gpuMachinesEl.replaceChildren();
  const onlineCount = gpuMachines.filter(machine => machine.online).length;
  const totalCards = gpuMachines.reduce((total, machine) => total + gpuMachineSummary(machine).gpus.length, 0);
  gpuOverview.textContent = gpuMachines.length
    ? `${onlineCount} / ${gpuMachines.length} 台在线 · 共 ${totalCards} 张卡`
    : '等待机器上报';
  if (!gpuMachines.length) {
    const empty = document.createElement('div');
    empty.className = 'gpu-empty';
    empty.innerHTML = '<strong>还没有机器上报</strong><span>部署上报脚本后，机器会自动出现在这里。</span>';
    gpuMachinesEl.append(empty);
    if (openGpuMachineName) closeGpuDetails();
    return;
  }
  for (const machine of gpuMachines) gpuMachinesEl.append(gpuCard(machine));
  if (openGpuMachineName) renderGpuDetail();
}

function render() {
  if (!state) return;
  renderIntro();
  for (const person of state.people) renderBoard(person);
  renderIdentity();
  renderPresence();
  renderGpuMachines();
  renderWall();
}

function chooseIdentity(id) {
  const previousIdentity = identity;
  identity = id;
  localStorage.setItem('note-identity', id);
  identityModal.hidden = true;
  manuallySleeping = false;
  presenceStarted = true;
  renderIdentity();
  renderPresence();
  if (previousIdentity && previousIdentity !== id) sendPresence('away', previousIdentity);
  sendPresence('online', id);
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTodoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const options = date.getFullYear() === new Date().getFullYear()
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' };
  return date.toLocaleDateString('zh-CN', options);
}

function formatTodoDueAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === new Date().toDateString()) return `${time} 前`;
  return `${formatTodoDate(localDateKey(date))} ${time} 前`;
}

function todoSchedule(todo) {
  if (todo.recurrence === 'days' || todo.recurrence === 'daily') {
    return { text: formatTodoDate(todo.occurrenceDate), dateTime: todo.occurrenceDate };
  }
  if (todo.recurrence === 'hours') return { text: formatTodoDueAt(todo.dueAt), dateTime: todo.dueAt };
  return { text: '', dateTime: '' };
}

function recurrenceIntervalValue() {
  const value = Number(todoRecurrenceInterval.value);
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : 1;
}

function renderTodoRecurrencePreview() {
  const recurring = todoModalRecurring.checked;
  todoRecurrenceFields.hidden = !recurring;
  todoDatePreview.hidden = !recurring;
  if (!recurring) {
    todoDatePreview.textContent = '';
    return;
  }
  const interval = recurrenceIntervalValue();
  if (todoRecurrenceUnit.value === 'hours') {
    const dueAt = new Date(Date.now() + interval * 3600000).toISOString();
    todoDatePreview.textContent = `首次截止：${formatTodoDueAt(dueAt)}`;
  } else {
    todoDatePreview.textContent = `首次待办日期：${formatTodoDate(localDateKey())}`;
  }
}

function openTodoModal(personId) {
  const person = state.people.find(item => item.id === personId);
  if (!person) return;
  addingTodoPerson = personId;
  todoModalTitle.textContent = `给 ${person.name} 新增待办`;
  todoModalText.value = '';
  todoModalRecurring.checked = false;
  todoRecurrenceInterval.value = '1';
  todoRecurrenceUnit.value = 'days';
  todoModalImportant.checked = false;
  renderTodoRecurrencePreview();
  todoModal.hidden = false;
  setTimeout(() => todoModalText.focus(), 50);
}

function closeTodoModal() {
  todoModal.hidden = true;
  addingTodoPerson = undefined;
}

function openProfile(personId) {
  const person = state.people.find(p => p.id === personId);
  editingProfile = personId;
  pendingAvatar = null;
  avatarInput.value = '';
  profileName.value = person.name;
  setAvatarPreview(person.avatar, person);
  profileModal.hidden = false;
  setTimeout(() => profileName.focus(), 50);
}

function renderSloganPicker() {
  sloganText.dataset.color = editingSloganColor;
  for (const button of sloganColors.querySelectorAll('[data-slogan-color]')) {
    button.setAttribute('aria-pressed', String(button.dataset.sloganColor === editingSloganColor));
  }
}

function openSlogan(personId) {
  const person = state.people.find(item => item.id === personId);
  editingSloganPerson = personId;
  editingSloganColor = person.slogan?.color || 'neutral';
  sloganText.value = person.slogan?.text || '';
  renderSloganPicker();
  sloganModal.hidden = false;
  setTimeout(() => sloganText.focus(), 50);
}

function closeSlogan() {
  sloganModal.hidden = true;
  editingSloganPerson = undefined;
}

function setAvatarPreview(src, person) {
  avatarPreview.replaceChildren();
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    avatarPreview.append(img);
  } else {
    avatarPreview.textContent = initials(person);
  }
}

function closeProfile() {
  profileModal.hidden = true;
  pendingAvatar = null;
}

async function upload(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('仅支持 PNG、JPG、GIF 或 WebP 图片');
  if (file.size > 8 * 1024 * 1024) throw new Error('每张图片不能超过 8 MB');
  const result = await api('/upload', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || 'image') },
  });
  return result.url;
}

function addPendingFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (pendingImages.length >= 8) { toast('一次最多贴 8 张图片'); break; }
    pendingImages.push({ file, preview: URL.createObjectURL(file) });
  }
  renderPendingImages();
}

function renderPendingImages() {
  pendingImagesEl.replaceChildren();
  pendingImages.forEach((pending, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'pending-thumb';
    const img = document.createElement('img');
    img.src = pending.preview;
    img.alt = '待上传图片';
    img.addEventListener('click', () => openImagePreview(pendingImages.map(item => item.preview), index));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(pending.preview);
      pendingImages.splice(index, 1);
      renderPendingImages();
    });
    thumb.append(img, remove);
    pendingImagesEl.append(thumb);
  });
}

function clearPending() {
  pendingImages.forEach(item => URL.revokeObjectURL(item.preview));
  pendingImages = [];
  renderPendingImages();
}

function relativeTime(iso) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  if (abs < 60) return '刚刚';
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (abs < 604800) return formatter.format(Math.round(seconds / 86400), 'day');
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

document.querySelector('#pickImages').addEventListener('click', () => imageInput.click());
introTitle.addEventListener('pointerdown', beginIntroEdit);
introTitle.addEventListener('click', beginIntroEdit);
introTitle.addEventListener('focus', beginIntroEdit);
introTitle.addEventListener('blur', () => finishIntroEdit());
introTitle.addEventListener('keydown', event => {
  if (isImeConfirm(event)) return;
  if (event.key === 'Enter') { event.preventDefault(); introTitle.blur(); }
  if (event.key === 'Escape') { event.preventDefault(); finishIntroEdit(true); introColors.hidden = true; }
});
introColors.addEventListener('pointerdown', event => event.preventDefault());
introColors.addEventListener('click', async event => {
  const button = event.target.closest('[data-title-color]');
  if (!button) return;
  const title = (introTitle.textContent || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 50) return toast(title ? '标题不能超过 50 个字' : '标题不能为空');
  const previousColor = state.intro.color;
  introTitle.dataset.color = button.dataset.titleColor;
  try { await queueAction({ type: 'setIntro', title, color: button.dataset.titleColor }); }
  catch { introTitle.dataset.color = previousColor; renderIntro(); }
});
document.addEventListener('pointerdown', event => {
  if (!introEditor.contains(event.target)) introColors.hidden = true;
  if (!wallTools.contains(event.target)) {
    wallFilterPanel.hidden = true;
    wallFilterButton.setAttribute('aria-expanded', 'false');
  }
});
wallTools.querySelectorAll('[data-wall-view]').forEach(button => button.addEventListener('click', () => {
  wallView = button.dataset.wallView;
  localStorage.setItem('note-wall-view', wallView);
  visibleWallItems = WALL_PAGE_SIZES[wallView];
  renderWall();
}));
wallFilterButton.addEventListener('click', () => {
  wallFilterPanel.hidden = !wallFilterPanel.hidden;
  wallFilterButton.setAttribute('aria-expanded', String(!wallFilterPanel.hidden));
});
wallFilterPanel.addEventListener('click', event => {
  const kind = event.target.closest('[data-filter-kind]');
  const style = event.target.closest('[data-filter-style]');
  if (kind) wallFilters.kind = kind.dataset.filterKind;
  if (style) wallFilters.style = style.dataset.filterStyle;
  if (kind || style) { visibleWallItems = WALL_PAGE_SIZES[wallView]; renderWall(); }
});
filterFeatured.addEventListener('change', () => {
  wallFilters.featured = filterFeatured.checked;
  visibleWallItems = WALL_PAGE_SIZES[wallView];
  renderWall();
});
document.querySelector('#clearWallFilters').addEventListener('click', () => {
  wallFilters = { kind: 'all', style: 'all', featured: false };
  visibleWallItems = WALL_PAGE_SIZES[wallView];
  renderWall();
});
composer.querySelectorAll('[data-compose-kind]').forEach(button => button.addEventListener('click', () => {
  composeWallKind = button.dataset.composeKind;
  renderComposeWallOptions();
}));
composer.querySelectorAll('[data-compose-style]').forEach(button => button.addEventListener('click', () => {
  composeWallStyle = button.dataset.composeStyle;
  renderComposeWallOptions();
}));
imageInput.addEventListener('change', () => { addPendingFiles(imageInput.files); imageInput.value = ''; });
todoModalRecurring.addEventListener('change', renderTodoRecurrencePreview);
todoRecurrenceInterval.addEventListener('input', renderTodoRecurrencePreview);
todoRecurrenceUnit.addEventListener('change', renderTodoRecurrencePreview);
todoModalText.addEventListener('compositionstart', () => { todoModalIsComposing = true; });
todoModalText.addEventListener('compositionend', () => { todoModalIsComposing = false; });
todoModal.querySelectorAll('[data-close-todo]').forEach(element => element.addEventListener('click', closeTodoModal));
todoModalForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (todoModalIsComposing || !addingTodoPerson) return;
  const text = todoModalText.value.trim();
  if (!text) return toast('待办内容不能为空');
  const recurring = todoModalRecurring.checked;
  const recurrenceInterval = recurrenceIntervalValue();
  if (recurring && String(recurrenceInterval) !== todoRecurrenceInterval.value.trim()) return toast('请输入 1 到 10000 之间的整数间隔');
  const recurrence = recurring ? todoRecurrenceUnit.value : '';
  const button = document.querySelector('#saveTodo');
  button.disabled = true;
  try {
    await queueAction({
      type: 'addTodo', personId: addingTodoPerson, text,
      recurrence, recurrenceInterval,
      occurrenceDate: recurrence === 'days' ? localDateKey() : '',
      dueAt: recurrence === 'hours' ? new Date(Date.now() + recurrenceInterval * 3600000).toISOString() : '',
      important: todoModalImportant.checked,
    });
    closeTodoModal();
    toast(recurring ? '周期待办已经加入' : '待办已经加入');
  } catch {}
  finally { button.disabled = false; }
});
avatarPreview.addEventListener('click', () => avatarInput.click());
avatarInput.addEventListener('change', () => {
  const file = avatarInput.files[0];
  if (!file) return;
  pendingAvatar = file;
  setAvatarPreview(URL.createObjectURL(file), state.people.find(p => p.id === editingProfile));
});
document.querySelector('#saveProfile').addEventListener('click', async () => {
  const button = document.querySelector('#saveProfile');
  const name = profileName.value.trim();
  if (!name) return toast('名字不能为空');
  button.disabled = true;
  try {
    const person = state.people.find(p => p.id === editingProfile);
    const avatar = pendingAvatar ? await upload(pendingAvatar) : person.avatar;
    await queueAction({ type: 'setProfile', personId: editingProfile, name, avatar });
    closeProfile();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
profileModal.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeProfile));
sloganModal.querySelectorAll('[data-close-slogan]').forEach(el => el.addEventListener('click', closeSlogan));
wallEditModal.querySelectorAll('[data-close-wall-edit]').forEach(el => el.addEventListener('click', closeWallEditor));
document.querySelector('#addWallEditImages').addEventListener('click', () => wallEditImageInput.click());
wallEditImageInput.addEventListener('change', () => {
  addWallEditFiles(wallEditImageInput.files);
  wallEditImageInput.value = '';
});
for (const eventName of ['dragenter', 'dragover']) {
  wallEditImageArea.addEventListener(eventName, event => { event.preventDefault(); wallEditImageArea.classList.add('dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  wallEditImageArea.addEventListener(eventName, event => { event.preventDefault(); wallEditImageArea.classList.remove('dragging'); });
}
wallEditImageArea.addEventListener('drop', event => addWallEditFiles(event.dataTransfer.files));
wallEditModal.querySelectorAll('[data-edit-kind]').forEach(button => button.addEventListener('click', () => {
  editingWallKind = button.dataset.editKind;
  renderWallEditOptions();
}));
wallEditModal.querySelectorAll('[data-edit-style]').forEach(button => button.addEventListener('click', () => {
  editingWallStyle = button.dataset.editStyle;
  renderWallEditOptions();
}));
document.querySelector('#saveWallEdit').addEventListener('click', async () => {
  const button = document.querySelector('#saveWallEdit');
  const item = state.wall.find(entry => entry.id === editingWallId);
  if (!item) return closeWallEditor();
  const text = wallEditText.value.trim();
  if (!text && !editingWallImages.length) return toast('至少保留文字或一张图片');
  button.disabled = true;
  try {
    const images = [];
    const newImages = editingWallImages.filter(image => image.file);
    let uploaded = 0;
    for (const image of editingWallImages) {
      if (image.url) images.push(image.url);
      else {
        button.textContent = `上传图片 ${++uploaded}/${newImages.length}`;
        images.push(await upload(image.file));
      }
    }
    button.textContent = '正在保存…';
    await queueAction({ type: 'editWall', itemId: item.id, text, images, kind: editingWallKind, style: editingWallStyle, featured: wallEditFeatured.checked });
    closeWallEditor();
    toast('贴贴已经更新');
  } catch {}
  finally { button.disabled = false; button.textContent = '保存修改'; }
});
sloganColors.addEventListener('click', event => {
  const button = event.target.closest('[data-slogan-color]');
  if (!button) return;
  editingSloganColor = button.dataset.sloganColor;
  renderSloganPicker();
});
document.querySelector('#saveSlogan').addEventListener('click', async () => {
  const button = document.querySelector('#saveSlogan');
  if (!editingSloganPerson) return;
  button.disabled = true;
  try {
    await queueAction({ type: 'setSlogan', personId: editingSloganPerson, text: sloganText.value, color: editingSloganColor });
    closeSlogan();
  } catch {}
  finally { button.disabled = false; }
});
identityButton.addEventListener('click', () => { identityModal.hidden = false; });

for (const eventName of ['dragenter', 'dragover']) {
  composer.addEventListener(eventName, event => { event.preventDefault(); composer.classList.add('dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  composer.addEventListener(eventName, event => { event.preventDefault(); composer.classList.remove('dragging'); });
}
composer.addEventListener('drop', event => addPendingFiles(event.dataTransfer.files));
document.addEventListener('paste', event => {
  const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  if (files.length) {
    event.preventDefault();
    if (!wallEditModal.hidden) addWallEditFiles(files);
    else addPendingFiles(files);
    toast(`已粘贴 ${files.length} 张图片`);
  }
});

publishButton.addEventListener('click', async () => {
  const text = wallText.value.trim();
  if (!text && !pendingImages.length) return toast('写点什么或添加图片再贴上去');
  if (!identity) { identityModal.hidden = false; return; }
  publishButton.disabled = true;
  publishButton.textContent = pendingImages.length ? '正在上传…' : '正在贴上去…';
  try {
    const images = [];
    for (let i = 0; i < pendingImages.length; i++) {
      publishButton.textContent = `上传图片 ${i + 1}/${pendingImages.length}`;
      images.push(await upload(pendingImages[i].file));
    }
    await queueAction({ type: 'addWall', authorId: identity, text, images, kind: composeWallKind, style: composeWallStyle, featured: wallFeatured.checked });
    wallText.value = '';
    composeWallKind = 'note';
    wallFeatured.checked = false;
    renderComposeWallOptions();
    clearPending();
    toast('已经贴到墙上了');
  } catch (error) { toast(error.message); }
  finally { publishButton.disabled = false; publishButton.textContent = '贴上去'; }
});

showMoreButton.addEventListener('click', appendMoreWallItems);
window.addEventListener('resize', scheduleWallLayout);
imagePreview.addEventListener('click', event => {
  if (event.target.closest('.image-preview-nav')) return;
  closeImagePreview();
});
imagePreviewPrevious.addEventListener('click', () => moveImagePreview(-1));
imagePreviewNext.addEventListener('click', () => moveImagePreview(1));
gpuDetailModal.addEventListener('click', event => {
  if (event.target.closest('[data-close-gpu-detail]')) closeGpuDetails();
});
document.addEventListener('pointermove', updateGpuDrag);
document.addEventListener('pointerup', finishGpuDrag);
document.addEventListener('pointercancel', finishGpuDrag);
document.addEventListener('keydown', event => {
  if (!imagePreview.hidden) {
    if (event.key === 'ArrowLeft') moveImagePreview(-1);
    if (event.key === 'ArrowRight') moveImagePreview(1);
    if (event.key === 'Escape') closeImagePreview();
    return;
  }
  if (!gpuDetailModal.hidden) {
    if (event.key === 'Escape') closeGpuDetails();
    return;
  }
  if (event.key === 'Escape' && !profileModal.hidden) closeProfile();
  if (event.key === 'Escape' && !todoModal.hidden) closeTodoModal();
  if (event.key === 'Escape' && !sloganModal.hidden) closeSlogan();
  if (event.key === 'Escape' && !wallEditModal.hidden) closeWallEditor();
  if (event.key === 'Escape' && !wallFilterPanel.hidden) {
    wallFilterPanel.hidden = true;
    wallFilterButton.setAttribute('aria-expanded', 'false');
  }
});

renderComposeWallOptions();
renderWallControls();

async function refresh() {
  if (!token) {
    setStatus('缺少访问密钥', 'error');
    document.querySelector('main').style.opacity = '.45';
    toast('请使用包含访问密钥的完整链接');
    return;
  }
  try {
    const result = await api('/state');
    presence = result.presence || presence;
    const latestGpuMachines = result.gpuMachines || [];
    if (gpuDragState || gpuOrderSaving) deferredGpuMachines = latestGpuMachines;
    else gpuMachines = latestGpuMachines;
    if (!state || result.state.revision !== state.revision) {
      state = result.state;
      render();
    } else renderGpuMachines();
    renderPresence();
    setStatus('已同步', 'saved');
    if (!identity && identityModal.hidden) identityModal.hidden = false;
    if (identity && !presenceStarted) {
      presenceStarted = true;
      sendPresence('online');
    }
  } catch (error) {
    setStatus('连接失败', 'error');
    if (!state) toast(error.message);
  }
}

refresh();
setInterval(updateFocusTimers, 30_000);
setInterval(() => {
  if (presenceStarted && identity && !manuallySleeping) sendPresence('online');
}, 10_000);
setInterval(() => {
  if (document.visibilityState === 'visible' && ![...timers.values()].length) refresh();
}, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    if (presenceStarted && identity && !manuallySleeping) sendPresence('online');
  }
});
window.addEventListener('pagehide', () => {
  if (!presenceStarted || !identity || manuallySleeping || !token) return;
  const body = new Blob([JSON.stringify({ personId: identity, sessionId: presenceSessionId, status: 'away' })], { type: 'application/json' });
  navigator.sendBeacon('/notion/api/presence', body);
});
