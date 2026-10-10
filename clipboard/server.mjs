import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.CLIPBOARD_STATE_DIR || join(root, 'data');
const notionDir = join(dataDir, 'notion');
const mediaDir = join(notionDir, 'media');
const textLimit = 2 * 1024 * 1024;
const jsonLimit = 1024 * 1024;
const imageLimit = 8 * 1024 * 1024;
const gpuReportLimit = 1024 * 1024;
const gpuOfflineTimeout = Math.max(50, Number(process.env.GPU_MONITOR_TIMEOUT_MS) || 5 * 60_000);
const wallKinds = ['note', 'diary'];
const wallStyles = ['paper', 'warm', 'sage', 'moon', 'plum'];
const linkIcons = ['globe', 'book', 'code', 'heart', 'spark', 'music', 'bookmark', 'lab', 'coffee', 'cloud'];
mkdirSync(mediaDir, { recursive: true, mode: 0o700 });

function readOrCreate(path, initial) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = initial();
    writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
    return value;
  }
}

const token = readOrCreate(join(dataDir, 'access-token'), () => randomBytes(24).toString('hex')).trim();
if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('Invalid access token file');
const gpuMonitorToken = readOrCreate(join(dataDir, 'gpu-monitor-token'), () => randomBytes(32).toString('hex')).trim();
if (!/^[a-f0-9]{64}$/.test(gpuMonitorToken)) throw new Error('Invalid GPU monitor token file');

const clipboardStatePath = join(dataDir, 'text.json');
let clipboardState = JSON.parse(readOrCreate(clipboardStatePath, () => JSON.stringify({ text: '', updatedAt: null, revision: 0 })));
if (typeof clipboardState.text !== 'string' || !Number.isSafeInteger(clipboardState.revision) || !(clipboardState.updatedAt === null || typeof clipboardState.updatedAt === 'string')) throw new Error('Invalid clipboard state');

const notionStatePath = join(notionDir, 'state.json');
const gpuStatePath = join(notionDir, 'gpu-machines.json');
let gpuState = JSON.parse(readOrCreate(gpuStatePath, () => JSON.stringify({ machines: [] })));
validateGpuState(gpuState);
function initialNotionState() {
  return { revision: 0, updatedAt: null, intro: { title: '今天，也在好好生活。', color: 'ink' }, people: [
    { id: 'left', name: '左边的人', avatar: '', note: '', slogan: { text: '', color: 'neutral' }, sleeping: false, focuses: [], todos: [] },
    { id: 'right', name: '右边的人', avatar: '', note: '', slogan: { text: '', color: 'neutral' }, sleeping: false, focuses: [], todos: [] },
  ], wall: [], links: [] };
}
let notionState = JSON.parse(readOrCreate(notionStatePath, () => JSON.stringify(initialNotionState())));
const presenceTimeout = Math.max(50, Number(process.env.NOTION_PRESENCE_TIMEOUT_MS) || 35_000);
const notionPresence = new Map(notionState.people.map(person => [person.id, { sleeping: person.sleeping === true, lastSeenAt: null, sessions: new Map() }]));
let stateMigrated = false;
if (!Object.hasOwn(notionState, 'links')) { notionState.links = []; stateMigrated = true; }
if (!notionState.intro) { notionState.intro = { title: '今天，也在好好生活。', color: 'ink' }; stateMigrated = true; }
for (const person of notionState.people) {
  if (!person.slogan) { person.slogan = { text: '', color: 'neutral' }; stateMigrated = true; }
  if (typeof person.sleeping !== 'boolean') { person.sleeping = false; stateMigrated = true; }
  if (!Array.isArray(person.focuses)) {
    person.focuses = [];
    if (person.focus?.title) person.focuses.push({ id: randomBytes(8).toString('hex'), title: person.focus.title, endsAt: person.focus.endsAt || '', todoId: person.focus.todoId || null, startedAt: person.focus.startedAt || notionState.updatedAt || new Date().toISOString() });
    delete person.focus;
    stateMigrated = true;
  }
  for (const todo of person.todos) {
    if (!todo.status) { todo.status = todo.done ? 'done' : 'todo'; stateMigrated = true; }
    if (!Object.hasOwn(todo, 'completedAt')) { todo.completedAt = todo.status === 'done' ? (todo.createdAt || notionState.updatedAt || new Date().toISOString()) : null; stateMigrated = true; }
    if (todo.recurrence === 'daily') { todo.recurrence = 'days'; stateMigrated = true; }
    if (!['', 'hours', 'days'].includes(todo.recurrence)) { todo.recurrence = ''; stateMigrated = true; }
    if (!Object.hasOwn(todo, 'recurrence')) { todo.recurrence = ''; stateMigrated = true; }
    if (!Number.isInteger(todo.recurrenceInterval) || todo.recurrenceInterval < 0) { todo.recurrenceInterval = todo.recurrence ? 1 : 0; stateMigrated = true; }
    if (typeof todo.occurrenceDate !== 'string') { todo.occurrenceDate = ''; stateMigrated = true; }
    if (typeof todo.dueAt !== 'string') { todo.dueAt = ''; stateMigrated = true; }
    if (todo.recurrence === 'days' && !validDateKey(todo.occurrenceDate)) { todo.occurrenceDate = (todo.createdAt || new Date().toISOString()).slice(0, 10); stateMigrated = true; }
    if (todo.recurrence === 'hours' && Number.isNaN(new Date(todo.dueAt).getTime())) { todo.dueAt = new Date(new Date(todo.createdAt || Date.now()).getTime() + todo.recurrenceInterval * 3600000).toISOString(); stateMigrated = true; }
    if (todo.recurrence && !todo.seriesId) { todo.seriesId = randomBytes(8).toString('hex'); stateMigrated = true; }
    if (typeof todo.seriesId !== 'string') { todo.seriesId = ''; stateMigrated = true; }
    if (typeof todo.important !== 'boolean') { todo.important = false; stateMigrated = true; }
    if (todo.status === 'doing' && !person.focuses.some(focus => focus.todoId === todo.id)) { todo.status = 'todo'; stateMigrated = true; }
    todo.done = todo.status === 'done';
  }
}
for (const item of notionState.wall) {
  if (!wallKinds.includes(item.kind)) { item.kind = 'note'; stateMigrated = true; }
  if (!wallStyles.includes(item.style)) { item.style = 'paper'; stateMigrated = true; }
  if (typeof item.featured !== 'boolean') { item.featured = false; stateMigrated = true; }
  if (!Array.isArray(item.images)) { item.images = []; stateMigrated = true; }
}
if (stateMigrated) {
  writeFileSync(`${notionStatePath}.tmp`, JSON.stringify(notionState), { mode: 0o600 });
  renameSync(`${notionStatePath}.tmp`, notionStatePath);
}
validateNotionState(notionState);

const homePage = readFileSync(join(root, 'home.html'));
const homeStyle = readFileSync(join(root, 'home.css'));
const homeScript = readFileSync(join(root, 'home.js'));
const clipboardPage = readFileSync(join(root, 'index.html'));
const clipboardScript = readFileSync(join(root, 'app.js'));
const notionPage = readFileSync(join(root, 'notion', 'index.html'));
const notionScript = readFileSync(join(root, 'notion', 'app.js'));
const notionStyle = readFileSync(join(root, 'notion', 'style.css'));

function reply(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function secureEqual(actual, expected) {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function authorized(req) {
  const bearer = req.headers.authorization || '';
  const cookieValue = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('note_key='))?.slice('note_key='.length) || '';
  return secureEqual(bearer, `Bearer ${token}`) || secureEqual(cookieValue, token);
}
function gpuAuthorized(req) {
  return secureEqual(req.headers.authorization || '', `Bearer ${gpuMonitorToken}`);
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const error = new Error('请求内容过大。'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function validateNotionState(value) {
  if (!value || !Number.isSafeInteger(value.revision) || !value.intro || typeof value.intro.title !== 'string' || !['ink', 'coral', 'sage', 'blue', 'plum', 'amber'].includes(value.intro.color) || !Array.isArray(value.people) || value.people.length !== 2 || !Array.isArray(value.wall)) throw new Error('Invalid note state');
  for (const person of value.people) {
    if (!['left', 'right'].includes(person.id) || typeof person.name !== 'string' || typeof person.avatar !== 'string' || typeof person.note !== 'string' || !person.slogan || typeof person.slogan.text !== 'string' || !['neutral', 'coral', 'sage', 'blue', 'plum', 'amber'].includes(person.slogan.color) || typeof person.sleeping !== 'boolean' || !Array.isArray(person.focuses) || !Array.isArray(person.todos)) throw new Error('Invalid person state');
    if (person.focuses.some(focus => typeof focus.id !== 'string' || typeof focus.title !== 'string' || typeof focus.endsAt !== 'string' || typeof focus.startedAt !== 'string')) throw new Error('Invalid focus state');
    if (person.todos.some(todo => !todo || typeof todo.id !== 'string' || typeof todo.text !== 'string' || !['todo', 'doing', 'done'].includes(todo.status) || typeof todo.done !== 'boolean' || typeof todo.createdAt !== 'string' || !(todo.completedAt === null || typeof todo.completedAt === 'string') || !['', 'hours', 'days'].includes(todo.recurrence) || !Number.isInteger(todo.recurrenceInterval) || todo.recurrenceInterval < 0 || typeof todo.occurrenceDate !== 'string' || typeof todo.dueAt !== 'string' || typeof todo.seriesId !== 'string' || typeof todo.important !== 'boolean' || (todo.recurrence === 'days' && !validDateKey(todo.occurrenceDate)) || (todo.recurrence === 'hours' && Number.isNaN(new Date(todo.dueAt).getTime())))) throw new Error('Invalid todo state');
  }
  if (value.wall.some(item => !item || typeof item.id !== 'string' || !['left', 'right'].includes(item.authorId) || typeof item.text !== 'string' || !Array.isArray(item.images) || typeof item.createdAt !== 'string' || !wallKinds.includes(item.kind) || !wallStyles.includes(item.style) || typeof item.featured !== 'boolean')) throw new Error('Invalid wall state');
  if (!Array.isArray(value.links) || value.links.length > 60 || new Set(value.links.map(link => link?.id)).size !== value.links.length || value.links.some(link => !link || typeof link.id !== 'string' || typeof link.name !== 'string' || !link.name.trim() || link.name.length > 40 || !linkIcons.includes(link.icon) || !validLinkUrl(link.url))) throw new Error('Invalid links state');
}
function saveNotionState() {
  notionState.revision += 1;
  notionState.updatedAt = new Date().toISOString();
  writeFileSync(`${notionStatePath}.tmp`, JSON.stringify(notionState), { mode: 0o600 });
  renameSync(`${notionStatePath}.tmp`, notionStatePath);
}
function bad(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function cleanText(value, max, label) {
  if (typeof value !== 'string') throw bad(`${label}格式不正确。`);
  const result = value.trim();
  if (result.length > max) throw bad(`${label}不能超过 ${max} 个字。`);
  return result;
}
function validLinkUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
function linkFields(action) {
  const name = cleanText(action.name, 40, '链接名字');
  if (!name) throw bad('链接名字不能为空。');
  let url = cleanText(action.url, 2048, '链接地址');
  if (!url) throw bad('链接地址不能为空。');
  if (url.startsWith('//')) url = `https:${url}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  if (!validLinkUrl(url)) throw bad('请输入有效的 http 或 https 网址。');
  if (!linkIcons.includes(action.icon)) throw bad('链接图标无效。');
  const normalizedUrl = new URL(url).href;
  if (!validLinkUrl(normalizedUrl)) throw bad('链接地址太长，请缩短后再保存。');
  return { name, url: normalizedUrl, icon: action.icon };
}
function gpuString(value, max, label, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw bad(`${label}格式不正确。`);
  const result = value.trim();
  if (result.length > max) throw bad(`${label}不能超过 ${max} 个字。`);
  return result;
}
function gpuNumber(value, min, max, label, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw bad(`${label}数值无效。`);
  return Math.round(result * 10) / 10;
}
function gpuIso(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw bad(`${label}格式不正确。`);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw bad(`${label}格式不正确。`);
  return timestamp.toISOString();
}
function validateGpuState(value) {
  if (!value || !Array.isArray(value.machines) || value.machines.length > 100) throw new Error('Invalid GPU monitor state');
  for (const machine of value.machines) {
    if (!machine || typeof machine.name !== 'string' || typeof machine.firstSeenAt !== 'string' || typeof machine.updatedAt !== 'string' || !(machine.order === undefined || Number.isSafeInteger(machine.order) && machine.order >= 0) || !Array.isArray(machine.nodes)) throw new Error('Invalid GPU machine state');
    if (machine.nodes.some(node => !node || typeof node.name !== 'string' || !Array.isArray(node.gpus))) throw new Error('Invalid GPU node state');
    if (machine.nodes.some(node => node.gpus.some(gpu => !gpu || !Number.isInteger(gpu.index) || typeof gpu.name !== 'string' || typeof gpu.uuid !== 'string' || typeof gpu.inUse !== 'boolean' || !Array.isArray(gpu.processes) || !(gpu.idleSince === undefined || gpu.idleSince === null || typeof gpu.idleSince === 'string') || !(gpu.fillerActive === undefined || typeof gpu.fillerActive === 'boolean') || !(gpu.fillerMemoryUsedMiB === undefined || typeof gpu.fillerMemoryUsedMiB === 'number')))) throw new Error('Invalid GPU state');
  }
}
function sanitizeGpuReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('GPU 上报格式不正确。');
  const name = cleanText(value.machine, 80, '机器名');
  if (!name) throw bad('机器名不能为空。');
  if (!Array.isArray(value.nodes) || value.nodes.length > 64) throw bad('节点列表无效，最多支持 64 个节点。');
  const seenNodes = new Set();
  const nodes = value.nodes.map((rawNode, nodeIndex) => {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) throw bad('节点信息格式不正确。');
    const nodeName = gpuString(rawNode.name, 80, '节点名', `node-${nodeIndex + 1}`) || `node-${nodeIndex + 1}`;
    if (seenNodes.has(nodeName)) throw bad(`节点名重复：${nodeName}`);
    seenNodes.add(nodeName);
    if (!Array.isArray(rawNode.gpus) || rawNode.gpus.length > 64) throw bad(`${nodeName} 的 GPU 列表无效，最多支持 64 张卡。`);
    const seenGpuIndexes = new Set();
    const gpus = rawNode.gpus.map((rawGpu, gpuIndex) => {
      if (!rawGpu || typeof rawGpu !== 'object' || Array.isArray(rawGpu)) throw bad(`${nodeName} 的 GPU 信息格式不正确。`);
      const index = rawGpu.index === undefined ? gpuIndex : Number(rawGpu.index);
      if (!Number.isInteger(index) || index < 0 || index > 1024 || seenGpuIndexes.has(index)) throw bad(`${nodeName} 的 GPU 编号无效或重复。`);
      seenGpuIndexes.add(index);
      if (!Array.isArray(rawGpu.processes) || rawGpu.processes.length > 128) throw bad(`${nodeName} GPU ${index} 的进程列表无效。`);
      const processes = rawGpu.processes.map(rawProcess => {
        if (!rawProcess || typeof rawProcess !== 'object' || Array.isArray(rawProcess)) throw bad(`${nodeName} GPU ${index} 的进程信息格式不正确。`);
        const pid = Number(rawProcess.pid);
        if (!Number.isInteger(pid) || pid < 0 || pid > 2_147_483_647) throw bad(`${nodeName} GPU ${index} 的进程 PID 无效。`);
        return {
          pid,
          user: gpuString(rawProcess.user, 64, '进程用户', '未知') || '未知',
          command: gpuString(rawProcess.command, 240, '程序名', '未知程序') || '未知程序',
          cwd: gpuString(rawProcess.cwd, 300, '工作目录'),
          memoryUsedMiB: gpuNumber(rawProcess.memoryUsedMiB, 0, 10_000_000, '进程显存', null),
        };
      });
      const memoryUsedMiB = gpuNumber(rawGpu.memoryUsedMiB, 0, 10_000_000, '已用显存', 0);
      const memoryTotalMiB = gpuNumber(rawGpu.memoryTotalMiB, 0, 10_000_000, '总显存', 0);
      if (memoryTotalMiB && memoryUsedMiB > memoryTotalMiB * 1.05) throw bad(`${nodeName} GPU ${index} 的显存数据无效。`);
      const fillerActive = rawGpu.fillerActive === true;
      const fillerMemoryUsedMiB = gpuNumber(rawGpu.fillerMemoryUsedMiB, 0, 10_000_000, 'Filler 显存', 0);
      const inferredInUse = processes.length > 0 || Math.max(0, memoryUsedMiB - fillerMemoryUsedMiB) > 256;
      const inUse = rawGpu.inUse === true || inferredInUse;
      return {
        index,
        uuid: gpuString(rawGpu.uuid, 96, 'GPU UUID'),
        name: gpuString(rawGpu.name, 100, 'GPU 型号', 'NVIDIA GPU') || 'NVIDIA GPU',
        inUse,
        idleSince: inUse ? null : gpuIso(rawGpu.idleSince, 'GPU 空闲时间'),
        utilizationPercent: gpuNumber(rawGpu.utilizationPercent, 0, 100, 'GPU 利用率', 0),
        memoryUsedMiB,
        memoryTotalMiB,
        temperatureC: gpuNumber(rawGpu.temperatureC, -50, 200, 'GPU 温度', null),
        powerDrawW: gpuNumber(rawGpu.powerDrawW, 0, 10_000, 'GPU 功耗', null),
        powerLimitW: gpuNumber(rawGpu.powerLimitW, 0, 10_000, 'GPU 功耗上限', null),
        fillerActive,
        fillerMemoryUsedMiB,
        processes,
      };
    });
    return { name: nodeName, gpus };
  });
  return { name, nodes };
}
function saveGpuState() {
  validateGpuState(gpuState);
  writeFileSync(`${gpuStatePath}.tmp`, JSON.stringify(gpuState), { mode: 0o600 });
  renameSync(`${gpuStatePath}.tmp`, gpuStatePath);
}
function updateGpuMachine(report) {
  const sanitized = sanitizeGpuReport(report);
  const now = new Date().toISOString();
  const existing = gpuState.machines.find(machine => machine.name === sanitized.name);
  for (const node of sanitized.nodes) {
    const previousNode = existing?.nodes.find(item => item.name === node.name);
    for (const gpu of node.gpus) {
      if (gpu.inUse || gpu.idleSince) continue;
      const previous = previousNode?.gpus.find(item => (gpu.uuid && item.uuid === gpu.uuid) || (!gpu.uuid && item.index === gpu.index));
      gpu.idleSince = previous && !previous.inUse && previous.idleSince ? previous.idleSince : now;
    }
  }
  if (existing) {
    existing.nodes = sanitized.nodes;
    existing.updatedAt = now;
  } else {
    if (gpuState.machines.length >= 100) throw bad('监控机器数量已达到上限。');
    const order = gpuState.machines.reduce((maximum, machine, index) => Math.max(maximum, Number.isSafeInteger(machine.order) ? machine.order : index), -1) + 1;
    gpuState.machines.push({ ...sanitized, order, firstSeenAt: now, updatedAt: now });
  }
  saveGpuState();
  const gpuCount = sanitized.nodes.reduce((total, node) => total + node.gpus.length, 0);
  return { machine: sanitized.name, nodes: sanitized.nodes.length, gpus: gpuCount, receivedAt: now };
}
function gpuSnapshot() {
  const now = Date.now();
  return gpuState.machines
    .map((machine, index) => ({ ...machine, order: Number.isSafeInteger(machine.order) ? machine.order : index, online: now - new Date(machine.updatedAt).getTime() <= gpuOfflineTimeout }))
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, 'zh-CN'));
}
function reorderGpuMachines(namesValue) {
  if (!Array.isArray(namesValue) || namesValue.length > 100 || namesValue.some(name => typeof name !== 'string')) throw bad('GPU 机器顺序格式不正确。');
  const names = namesValue.map(name => cleanText(name, 80, '机器名'));
  if (new Set(names).size !== names.length) throw bad('GPU 机器顺序中有重复项目。');
  const byName = new Map(gpuState.machines.map(machine => [machine.name, machine]));
  if (names.some(name => !byName.has(name))) throw bad('GPU 机器顺序中包含不存在的机器。');
  const ordered = names.map(name => byName.get(name));
  for (const machine of gpuSnapshot()) {
    if (!names.includes(machine.name)) ordered.push(byName.get(machine.name));
  }
  ordered.forEach((machine, order) => { machine.order = order; });
  gpuState.machines = ordered;
  saveGpuState();
}
function deleteGpuMachine(nameValue) {
  const name = cleanText(nameValue, 80, '机器名');
  const previousLength = gpuState.machines.length;
  gpuState.machines = gpuState.machines.filter(machine => machine.name !== name);
  if (gpuState.machines.length === previousLength) throw bad('这台机器已经不存在了。', 404);
  saveGpuState();
}
function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function nextDateKey(value, interval = 1) {
  if (!validDateKey(value)) throw bad('周期待办日期无效。');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + interval);
  return date.toISOString().slice(0, 10);
}
function createNextRecurringTodo(person, todo) {
  if (!['hours', 'days'].includes(todo.recurrence)) return;
  const occurrenceDate = todo.recurrence === 'days' ? nextDateKey(todo.occurrenceDate, todo.recurrenceInterval) : '';
  const dueAt = todo.recurrence === 'hours' ? new Date(Math.max(Date.now(), new Date(todo.dueAt).getTime()) + todo.recurrenceInterval * 3600000).toISOString() : '';
  if (person.todos.some(item => item.seriesId === todo.seriesId && (occurrenceDate ? item.occurrenceDate === occurrenceDate : item.dueAt === dueAt))) return;
  const createdAt = new Date().toISOString();
  person.todos.unshift({
    id: randomBytes(8).toString('hex'), text: todo.text, status: 'todo', done: false, createdAt, completedAt: null,
    recurrence: todo.recurrence, recurrenceInterval: todo.recurrenceInterval, occurrenceDate, dueAt, seriesId: todo.seriesId, important: todo.important,
  });
}
function getPerson(id) {
  const person = notionState.people.find(item => item.id === id);
  if (!person) throw bad('找不到这个记事板。');
  return person;
}
function updatePresence(value) {
  if (!value || typeof value !== 'object') throw bad('在线状态格式不正确。');
  const person = getPerson(value.personId);
  const sessionId = cleanText(value.sessionId, 80, '会话标识');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) throw bad('会话标识无效。');
  if (!['wake', 'online', 'sleeping', 'away'].includes(value.status)) throw bad('在线状态无效。');
  const entry = notionPresence.get(person.id);
  const now = Date.now();
  if (value.status === 'sleeping') {
    entry.sleeping = true;
    entry.sessions.clear();
    entry.lastSeenAt = new Date(now).toISOString();
    if (!person.sleeping) { person.sleeping = true; saveNotionState(); }
  } else if (value.status === 'away') {
    entry.sessions.delete(sessionId);
    entry.lastSeenAt = new Date(now).toISOString();
  } else if (value.status === 'wake') {
    entry.sleeping = false;
    entry.sessions.set(sessionId, now);
    entry.lastSeenAt = new Date(now).toISOString();
    if (person.sleeping) { person.sleeping = false; saveNotionState(); }
  } else if (!entry.sleeping) {
    entry.sessions.set(sessionId, now);
    entry.lastSeenAt = new Date(now).toISOString();
  }
}
function presenceSnapshot() {
  const now = Date.now();
  const result = {};
  for (const person of notionState.people) {
    const entry = notionPresence.get(person.id);
    for (const [sessionId, seenAt] of entry.sessions) {
      if (now - seenAt > presenceTimeout) entry.sessions.delete(sessionId);
    }
    result[person.id] = {
      status: entry.sleeping ? 'sleeping' : entry.sessions.size ? 'online' : 'away',
      lastSeenAt: entry.lastSeenAt,
    };
  }
  return result;
}
function validMediaUrl(value) { return value === '' || /^\/notion\/media\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(value); }
function removeMedia(url) {
  const match = /^\/notion\/media\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/.exec(url || '');
  if (!match) return;
  const stillUsed = notionState.people.some(person => person.avatar === url) || notionState.wall.some(item => item.images?.includes(url));
  if (stillUsed) return;
  try { unlinkSync(join(mediaDir, match[1])); } catch (error) { if (error.code !== 'ENOENT') console.error(error); }
}

function applyAction(action) {
  if (!action || typeof action.type !== 'string') throw bad('操作格式不正确。');
  if (action.type === 'addLink') {
    const fields = linkFields(action);
    if (notionState.links.length >= 60) throw bad('最多保存 60 个链接，请先整理一下已有链接。');
    notionState.links.push({ id: randomBytes(8).toString('hex'), ...fields });
    saveNotionState(); return;
  }
  if (action.type === 'updateLink') {
    const link = notionState.links.find(item => item.id === action.linkId);
    if (!link) throw bad('这条链接已经不存在了。', 404);
    Object.assign(link, linkFields(action));
    saveNotionState(); return;
  }
  if (action.type === 'deleteLink') {
    const index = notionState.links.findIndex(item => item.id === action.linkId);
    if (index < 0) throw bad('这条链接已经不存在了。', 404);
    notionState.links.splice(index, 1);
    saveNotionState(); return;
  }
  if (action.type === 'setIntro') {
    const title = cleanText(action.title, 50, '标题');
    if (!title) throw bad('标题不能为空。');
    if (!['ink', 'coral', 'sage', 'blue', 'plum', 'amber'].includes(action.color)) throw bad('标题颜色无效。');
    notionState.intro = { title, color: action.color };
    saveNotionState(); return;
  }
  if (action.type === 'setSlogan') {
    const person = getPerson(action.personId);
    const text = cleanText(action.text, 120, 'Slogan');
    if (!['neutral', 'coral', 'sage', 'blue', 'plum', 'amber'].includes(action.color)) throw bad('Slogan 颜色无效。');
    person.slogan = { text, color: action.color };
    saveNotionState(); return;
  }
  if (action.type === 'setProfile') {
    const person = getPerson(action.personId); const name = cleanText(action.name, 20, '名字');
    if (!name) throw bad('名字不能为空。');
    if (typeof action.avatar !== 'string' || !validMediaUrl(action.avatar)) throw bad('头像地址无效。');
    const oldAvatar = person.avatar; person.name = name; person.avatar = action.avatar; saveNotionState();
    if (oldAvatar !== person.avatar) removeMedia(oldAvatar);
    return;
  }
  if (action.type === 'setNote') {
    const person = getPerson(action.personId);
    if (typeof action.note !== 'string' || action.note.length > 5000) throw bad('随手记不能超过 5000 个字。');
    person.note = action.note; saveNotionState(); return;
  }
  if (action.type === 'addFocus') {
    const person = getPerson(action.personId); const title = cleanText(action.title, 100, '当前事项'); let endsAt = '';
    if (!title) throw bad('当前事项不能为空。');
    if (person.focuses.length >= 30) throw bad('同时进行的事项太多了，请先完成一些。');
    if (action.endsAt) { const date = new Date(action.endsAt); if (Number.isNaN(date.getTime())) throw bad('预计结束时间无效。'); endsAt = date.toISOString(); }
    person.focuses.unshift({ id: randomBytes(8).toString('hex'), title, endsAt, todoId: null, startedAt: new Date().toISOString() }); saveNotionState(); return;
  }
  if (action.type === 'updateFocus') {
    const person = getPerson(action.personId); const focus = person.focuses.find(item => item.id === action.focusId);
    if (!focus) throw bad('这条正在做的事项已经不存在了。', 404);
    const title = cleanText(action.title, 100, '当前事项'); let endsAt = '';
    if (!title) throw bad('当前事项不能为空。');
    if (action.endsAt) { const date = new Date(action.endsAt); if (Number.isNaN(date.getTime())) throw bad('预计结束时间无效。'); endsAt = date.toISOString(); }
    focus.title = title; focus.endsAt = endsAt;
    const linked = person.todos.find(todo => todo.id === focus.todoId); if (linked) linked.text = title;
    saveNotionState(); return;
  }
  if (action.type === 'moveFocus') {
    const person = getPerson(action.personId);
    const focus = person.focuses.find(item => item.id === action.focusId);
    const target = person.focuses.find(item => item.id === action.targetId);
    if (!focus || !target) throw bad('要调整的进行中事项已经不存在了。', 404);
    if (focus.id === target.id) return;
    const from = person.focuses.indexOf(focus); person.focuses.splice(from, 1);
    const targetIndex = person.focuses.indexOf(target);
    person.focuses.splice(action.position === 'after' ? targetIndex + 1 : targetIndex, 0, focus);
    saveNotionState(); return;
  }
  if (action.type === 'addTodo') {
    const person = getPerson(action.personId); const text = cleanText(action.text, 120, '待办');
    if (!text) throw bad('待办不能为空。');
    if (person.todos.length >= 300) throw bad('待办太多了，请先清理一些。');
    const recurrence = action.recurrence === 'daily' ? 'days' : (action.recurrence || '');
    if (!['', 'hours', 'days'].includes(recurrence)) throw bad('周期类型无效。');
    if (action.important !== undefined && typeof action.important !== 'boolean') throw bad('重要状态无效。');
    const recurrenceInterval = recurrence ? Number(action.recurrenceInterval || 1) : 0;
    if (recurrence && (!Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 10000)) throw bad('周期间隔无效。');
    const occurrenceDate = recurrence === 'days' ? action.occurrenceDate : '';
    const dueAt = recurrence === 'hours' ? action.dueAt : '';
    if (recurrence === 'days' && !validDateKey(occurrenceDate)) throw bad('周期待办日期无效。');
    if (recurrence === 'hours' && Number.isNaN(new Date(dueAt).getTime())) throw bad('周期待办截止时间无效。');
    person.todos.unshift({
      id: randomBytes(8).toString('hex'), text, status: 'todo', done: false, createdAt: new Date().toISOString(), completedAt: null,
      recurrence, recurrenceInterval, occurrenceDate, dueAt, seriesId: recurrence ? randomBytes(8).toString('hex') : '', important: action.important === true,
    }); saveNotionState(); return;
  }
  if (action.type === 'editTodo') {
    const person = getPerson(action.personId); const todo = person.todos.find(item => item.id === action.todoId);
    if (!todo) throw bad('这条待办已经不存在了。', 404);
    const text = cleanText(action.text, 120, '待办'); if (!text) throw bad('待办不能为空。');
    todo.text = text;
    const focus = person.focuses.find(item => item.todoId === todo.id); if (focus) focus.title = text;
    saveNotionState(); return;
  }
  if (action.type === 'moveTodo') {
    const person = getPerson(action.personId);
    const todo = person.todos.find(item => item.id === action.todoId);
    const target = person.todos.find(item => item.id === action.targetId);
    if (!todo || !target) throw bad('要调整的待办已经不存在了。', 404);
    if (todo.status !== 'todo' || target.status !== 'todo' || todo.id === target.id) throw bad('只能调整待办清单中的顺序。');
    const from = person.todos.indexOf(todo); person.todos.splice(from, 1);
    const targetIndex = person.todos.indexOf(target);
    const insertAt = action.position === 'after' ? targetIndex + 1 : targetIndex;
    person.todos.splice(insertAt, 0, todo); saveNotionState(); return;
  }
  if (action.type === 'toggleTodo') {
    const person = getPerson(action.personId); const todo = person.todos.find(item => item.id === action.todoId);
    if (!todo) throw bad('这条待办已经不存在了。', 404);
    const complete = Boolean(action.done);
    todo.status = complete ? 'done' : 'todo'; todo.done = complete; todo.completedAt = complete ? new Date().toISOString() : null;
    person.focuses = person.focuses.filter(focus => focus.todoId !== todo.id);
    if (complete) createNextRecurringTodo(person, todo);
    saveNotionState(); return;
  }
  if (action.type === 'startTodo') {
    const person = getPerson(action.personId); const todo = person.todos.find(item => item.id === action.todoId);
    if (!todo) throw bad('这条待办已经不存在了。', 404);
    if (person.focuses.some(focus => focus.todoId === todo.id)) throw bad('这条待办已经在做了。');
    if (person.focuses.length >= 30) throw bad('同时进行的事项太多了，请先完成一些。');
    todo.status = 'doing'; todo.done = false; todo.completedAt = null;
    person.focuses.unshift({ id: randomBytes(8).toString('hex'), title: todo.text, endsAt: '', todoId: todo.id, startedAt: new Date().toISOString() }); saveNotionState(); return;
  }
  if (action.type === 'completeFocus') {
    const person = getPerson(action.personId); const focus = person.focuses.find(item => item.id === action.focusId);
    if (!focus) throw bad('这条正在做的事项已经不存在了。', 404);
    const title = cleanText(focus.title, 100, '当前事项');
    const completedAt = new Date().toISOString();
    const linked = person.todos.find(item => item.id === focus.todoId);
    if (linked) { linked.text = title; linked.status = 'done'; linked.done = true; linked.completedAt = completedAt; createNextRecurringTodo(person, linked); }
    else person.todos.unshift({ id: randomBytes(8).toString('hex'), text: title, status: 'done', done: true, createdAt: completedAt, completedAt, recurrence: '', recurrenceInterval: 0, occurrenceDate: '', dueAt: '', seriesId: '', important: false });
    person.focuses = person.focuses.filter(item => item.id !== focus.id); saveNotionState(); return;
  }
  if (action.type === 'clearFocus') {
    const person = getPerson(action.personId); const focus = person.focuses.find(item => item.id === action.focusId);
    if (!focus) throw bad('这条正在做的事项已经不存在了。', 404);
    const linked = person.todos.find(item => item.id === focus.todoId);
    if (linked) { linked.status = 'todo'; linked.done = false; linked.completedAt = null; }
    else person.todos.unshift({ id: randomBytes(8).toString('hex'), text: focus.title, status: 'todo', done: false, createdAt: focus.startedAt || new Date().toISOString(), completedAt: null, recurrence: '', recurrenceInterval: 0, occurrenceDate: '', dueAt: '', seriesId: '', important: false });
    person.focuses = person.focuses.filter(item => item.id !== focus.id); saveNotionState(); return;
  }
  if (action.type === 'deleteFocus') {
    const person = getPerson(action.personId); const focus = person.focuses.find(item => item.id === action.focusId);
    if (!focus) throw bad('这条正在做的事项已经不存在了。', 404);
    if (focus.todoId) person.todos = person.todos.filter(item => item.id !== focus.todoId);
    person.focuses = person.focuses.filter(item => item.id !== focus.id); saveNotionState(); return;
  }
  if (action.type === 'deleteTodo') {
    const person = getPerson(action.personId); const length = person.todos.length;
    person.todos = person.todos.filter(item => item.id !== action.todoId);
    if (person.todos.length === length) throw bad('这条待办已经不存在了。', 404);
    person.focuses = person.focuses.filter(focus => focus.todoId !== action.todoId);
    saveNotionState(); return;
  }
  if (action.type === 'addWall') {
    getPerson(action.authorId); const text = cleanText(action.text || '', 1000, '内容');
    if (!Array.isArray(action.images) || action.images.length > 8 || action.images.some(url => typeof url !== 'string' || !validMediaUrl(url) || !url)) throw bad('图片列表无效。');
    const kind = action.kind === undefined ? 'note' : action.kind;
    const style = action.style === undefined ? 'paper' : action.style;
    if (!wallKinds.includes(kind)) throw bad('贴贴类型无效。');
    if (!wallStyles.includes(style)) throw bad('贴贴风格无效。');
    if (action.featured !== undefined && typeof action.featured !== 'boolean') throw bad('精华状态无效。');
    if (!text && !action.images.length) throw bad('内容不能为空。');
    if (notionState.wall.length >= 1000) throw bad('贴贴墙已经很满了，请先取下一些旧内容。');
    notionState.wall.unshift({ id: randomBytes(8).toString('hex'), authorId: action.authorId, text, images: action.images, kind, style, featured: action.featured === true, createdAt: new Date().toISOString() }); saveNotionState(); return;
  }
  if (action.type === 'editWall') {
    const item = notionState.wall.find(entry => entry.id === action.itemId);
    if (!item) throw bad('这条内容已经不存在了。', 404);
    const text = cleanText(action.text || '', 1000, '内容');
    const images = action.images === undefined ? item.images : action.images;
    if (!Array.isArray(images) || images.length > 8 || images.some(url => typeof url !== 'string' || !validMediaUrl(url) || !url)) throw bad('图片列表无效。');
    if (!text && !images.length) throw bad('内容不能为空。');
    if (!wallKinds.includes(action.kind)) throw bad('贴贴类型无效。');
    if (!wallStyles.includes(action.style)) throw bad('贴贴风格无效。');
    if (typeof action.featured !== 'boolean') throw bad('精华状态无效。');
    const oldImages = item.images;
    item.text = text; item.images = images; item.kind = action.kind; item.style = action.style; item.featured = action.featured;
    saveNotionState(); oldImages.filter(url => !images.includes(url)).forEach(removeMedia); return;
  }
  if (action.type === 'deleteWall') {
    const item = notionState.wall.find(entry => entry.id === action.itemId);
    if (!item) throw bad('这条内容已经不存在了。', 404);
    const images = item.images || []; notionState.wall = notionState.wall.filter(entry => entry.id !== action.itemId); saveNotionState(); images.forEach(removeMedia); return;
  }
  throw bad('不支持这个操作。');
}

const mediaTypes = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const uploadTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const shujiTarget = { hostname: '127.0.0.1', port: 6358 };

function shujiPath(rawUrl = '/') {
  const stripped = rawUrl.replace(/^\/shuji(?=\/|\?|$)/, '');
  return stripped || '/';
}

function shujiHeaders(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return {
    ...req.headers,
    host: `${shujiTarget.hostname}:${shujiTarget.port}`,
    'x-forwarded-for': forwarded ? `${forwarded}, ${remote}` : remote,
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http',
  };
}

function proxyShuji(req, res) {
  const proxy = http.request({ ...shujiTarget, method: req.method, path: shujiPath(req.url), headers: shujiHeaders(req) }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', error => {
    console.error('Shuji proxy failed:', error.message);
    if (!res.headersSent) reply(res, 502, { error: '数迹服务暂时不可用。' });
    else res.destroy();
  });
  req.pipe(proxy);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); const path = url.pathname;
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', path.startsWith('/notion')
    ? "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    : path.startsWith('/shuji')
      ? "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  try {
    if (req.method === 'GET' && path === '/') return reply(res, 200, homePage, 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/home.css') return reply(res, 200, homeStyle, 'text/css; charset=utf-8');
    if (req.method === 'GET' && path === '/home.js') return reply(res, 200, homeScript, 'text/javascript; charset=utf-8');
    if (path === '/clipboard' && req.method === 'GET') { res.writeHead(308, { Location: '/clipboard/' }); return res.end(); }
    if (req.method === 'GET' && path === '/clipboard/') return reply(res, 200, clipboardPage, 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/clipboard/app.js') return reply(res, 200, clipboardScript, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/app.js') return reply(res, 200, clipboardScript, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/healthz') return reply(res, 200, { ok: true });
    if (path === '/shuji' && req.method === 'GET') { res.writeHead(308, { Location: '/shuji/' }); return res.end(); }
    if (path.startsWith('/shuji/')) return proxyShuji(req, res);
    if (path === '/notion' && req.method === 'GET') { res.writeHead(308, { Location: '/notion/' }); return res.end(); }
    if (req.method === 'GET' && path === '/notion/') return reply(res, 200, notionPage, 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/notion/app.js') return reply(res, 200, notionScript, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/notion/style.css') return reply(res, 200, notionStyle, 'text/css; charset=utf-8');
    if (path.startsWith('/notion/media/') && req.method === 'GET') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      const match = /^\/notion\/media\/([a-f0-9]{32}\.(png|jpg|gif|webp))$/.exec(path);
      if (!match) return reply(res, 404, { error: '图片不存在。' });
      const filePath = join(mediaDir, match[1]); let size;
      try { size = statSync(filePath).size; } catch (error) { if (error.code === 'ENOENT') return reply(res, 404, { error: '图片不存在。' }); throw error; }
      res.writeHead(200, { 'Content-Type': mediaTypes[match[2]], 'Content-Length': size, 'Cache-Control': 'private, max-age=86400' });
      return createReadStream(filePath).pipe(res);
    }
    if (path === '/notion/api/gpu/report' && req.method === 'POST') {
      if (!gpuAuthorized(req)) return reply(res, 401, { error: 'GPU 上报密钥无效。' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw bad('请提交 JSON。', 415);
      const result = updateGpuMachine(JSON.parse((await readBody(req, gpuReportLimit)).toString('utf8')));
      return reply(res, 202, { ok: true, ...result, offlineAfterSeconds: Math.round(gpuOfflineTimeout / 1000) });
    }
    if (path === '/notion/api/state' && req.method === 'GET') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      res.setHeader('Set-Cookie', `note_key=${token}; Path=/notion; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      return reply(res, 200, { state: notionState, presence: presenceSnapshot(), gpuMachines: gpuSnapshot() });
    }
    if (path === '/notion/api/gpu/machine' && req.method === 'DELETE') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw bad('不允许跨站删除。', 403);
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw bad('请提交 JSON。', 415);
      const body = JSON.parse((await readBody(req, jsonLimit)).toString('utf8'));
      deleteGpuMachine(body?.machine);
      return reply(res, 200, { gpuMachines: gpuSnapshot() });
    }
    if (path === '/notion/api/gpu/order' && req.method === 'POST') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw bad('不允许跨站排序。', 403);
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw bad('请提交 JSON。', 415);
      const body = JSON.parse((await readBody(req, jsonLimit)).toString('utf8'));
      reorderGpuMachines(body?.machines);
      return reply(res, 200, { gpuMachines: gpuSnapshot() });
    }
    if (path === '/notion/api/presence' && req.method === 'POST') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw bad('不允许跨站更新状态。', 403);
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw bad('请提交 JSON。', 415);
      updatePresence(JSON.parse((await readBody(req, jsonLimit)).toString('utf8')));
      return reply(res, 200, { presence: presenceSnapshot() });
    }
    if (path === '/notion/api/action' && req.method === 'POST') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw bad('不允许跨站保存。', 403);
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw bad('请提交 JSON。', 415);
      applyAction(JSON.parse((await readBody(req, jsonLimit)).toString('utf8')));
      return reply(res, 200, { state: notionState });
    }
    if (path === '/notion/api/upload' && req.method === 'POST') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw bad('不允许跨站上传。', 403);
      const type = req.headers['content-type']?.split(';')[0]; const extension = uploadTypes[type];
      if (!extension) throw bad('仅支持 PNG、JPG、GIF 或 WebP 图片。', 415);
      const image = await readBody(req, imageLimit); if (!image.length) throw bad('图片内容为空。');
      const filename = `${randomBytes(16).toString('hex')}.${extension}`;
      writeFileSync(join(mediaDir, filename), image, { mode: 0o600, flag: 'wx' });
      return reply(res, 201, { url: `/notion/media/${filename}` });
    }
    if (path === '/api/text') {
      if (!authorized(req)) return reply(res, 401, { error: '访问密钥无效，请使用完整链接。' });
      if (req.method === 'GET') return reply(res, 200, clipboardState);
      if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); return reply(res, 405, { error: 'Method not allowed' }); }
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw bad('不允许跨站保存。', 403);
      if (req.headers['content-type']?.split(';')[0] !== 'text/plain') throw bad('请提交纯文本。', 415);
      const next = { text: (await readBody(req, textLimit)).toString('utf8'), updatedAt: new Date().toISOString(), revision: clipboardState.revision + 1 };
      writeFileSync(`${clipboardStatePath}.tmp`, JSON.stringify(next), { mode: 0o600 }); renameSync(`${clipboardStatePath}.tmp`, clipboardStatePath); clipboardState = next;
      return reply(res, 200, { revision: clipboardState.revision, updatedAt: clipboardState.updatedAt });
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof SyntaxError) return reply(res, 400, { error: 'JSON 格式不正确。' });
    if (!error.status || error.status >= 500) console.error('Request failed:', error);
    if (!res.headersSent && !res.destroyed) return reply(res, error.status || 500, { error: error.status ? error.message : '保存失败，请稍后重试。' });
  }
});
server.requestTimeout = 30_000; server.headersTimeout = 15_000;
server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (!path.startsWith('/shuji/socket.io/')) return socket.destroy();
  const proxy = http.request({ ...shujiTarget, method: req.method, path: shujiPath(req.url), headers: shujiHeaders(req) });
  proxy.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
    const headers = [];
    for (let index = 0; index < upstream.rawHeaders.length; index += 2) headers.push(`${upstream.rawHeaders[index]}: ${upstream.rawHeaders[index + 1]}`);
    socket.write(`HTTP/1.1 ${upstream.statusCode || 101} ${upstream.statusMessage || 'Switching Protocols'}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  proxy.on('response', response => {
    socket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  });
  proxy.on('error', () => socket.destroy());
  proxy.end();
});
server.listen(Number(process.env.PORT || 6357), process.env.HOST || '0.0.0.0', () => console.log(`Clipboard and note listening on port ${server.address().port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
