import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('note supports two boards, profiles, todos, wall images and restart persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'note-test-'));
  let child;
  let base;
  let key;
  let gpuKey;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: import.meta.dirname,
      env: { ...process.env, CLIPBOARD_STATE_DIR: dir, HOST: '127.0.0.1', PORT: '0', NOTION_PRESENCE_TIMEOUT_MS: '80', GPU_MONITOR_TIMEOUT_MS: '80' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const output = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
      child.stdout.once('data', data => resolve(data.toString()));
    });
    base = `http://127.0.0.1:${output.match(/port (\d+)/)[1]}`;
    key = (await readFile(join(dir, 'access-token'), 'utf8')).trim();
    gpuKey = (await readFile(join(dir, 'gpu-monitor-token'), 'utf8')).trim();
  }
  async function stop() {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    child = null;
  }
  const auth = () => ({ Authorization: `Bearer ${key}` });
  const snapshot = async () => {
    const response = await fetch(`${base}/notion/api/state`, { headers: auth() });
    assert.equal(response.status, 200);
    return response.json();
  };
  const state = async () => (await snapshot()).state;
  const action = async body => fetch(`${base}/notion/api/action`, {
    method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await start();
    assert.equal((await fetch(`${base}/notion`)).status, 200);
    const notePage = await (await fetch(`${base}/notion/`)).text();
    assert.match(notePage, /<title>note<\/title>/);
    assert.match(notePage, /id="todoModalForm"/);
    assert.match(notePage, /id="gpuMachines"/);
    assert.match(notePage, /id="gpuDetailModal"/);
    const noteScript = await (await fetch(`${base}/notion/app.js`)).text();
    assert.match(noteScript, /gpu-machine-drag/);
    assert.match(noteScript, /\/gpu\/order/);
    assert.equal((await fetch(`${base}/notion/api/state`)).status, 401);
    assert.equal((await state()).people.length, 2);
    const gpuPayload = {
      machine: 'lab-cluster',
      nodes: [
        { name: 'node-a', gpus: [
          { index: 0, uuid: 'GPU-aaa', name: 'NVIDIA A100', utilizationPercent: 87, memoryUsedMiB: 30000, memoryTotalMiB: 40960, temperatureC: 67, powerDrawW: 242, powerLimitW: 300, processes: [{ pid: 1234, user: 'alice', command: 'python train.py', cwd: '/work/experiment', memoryUsedMiB: 29500 }] },
          { index: 1, uuid: 'GPU-bbb', name: 'NVIDIA A100', inUse: false, idleSince: '2026-01-02T03:04:05Z', utilizationPercent: 99, memoryUsedMiB: 12000, memoryTotalMiB: 40960, temperatureC: 61, powerDrawW: 220, powerLimitW: 300, fillerActive: true, fillerMemoryUsedMiB: 11800, processes: [] },
        ] },
        { name: 'node-b', gpus: [
          { index: 0, uuid: 'GPU-ccc', name: 'NVIDIA A100', inUse: false, utilizationPercent: 0, memoryUsedMiB: 0, memoryTotalMiB: 40960, temperatureC: 29, powerDrawW: 39, powerLimitW: 300, processes: [] },
        ] },
      ],
    };
    const reportGpu = () => fetch(`${base}/notion/api/gpu/report`, {
      method: 'POST', headers: { Authorization: `Bearer ${gpuKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(gpuPayload),
    });
    assert.equal((await fetch(`${base}/notion/api/gpu/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gpuPayload) })).status, 401);
    assert.equal((await reportGpu()).status, 202);
    let gpuMachines = (await snapshot()).gpuMachines;
    assert.equal(gpuMachines.length, 1);
    assert.equal(gpuMachines[0].online, true);
    assert.equal(gpuMachines[0].nodes[0].gpus[0].inUse, true);
    assert.equal(gpuMachines[0].nodes[0].gpus[0].processes[0].command, 'python train.py');
    assert.equal(gpuMachines[0].nodes[0].gpus[0].processes[0].cwd, '/work/experiment');
    assert.equal(gpuMachines[0].nodes[0].gpus[1].inUse, false);
    assert.equal(gpuMachines[0].nodes[0].gpus[1].fillerActive, true);
    assert.equal(gpuMachines[0].nodes[0].gpus[1].processes.length, 0);
    assert.equal(gpuMachines[0].nodes[0].gpus[1].idleSince, '2026-01-02T03:04:05.000Z');
    const secondGpuPayload = { ...gpuPayload, machine: 'backup-cluster' };
    assert.equal((await fetch(`${base}/notion/api/gpu/report`, {
      method: 'POST', headers: { Authorization: `Bearer ${gpuKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(secondGpuPayload),
    })).status, 202);
    assert.equal((await fetch(`${base}/notion/api/gpu/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machines: ['backup-cluster', 'lab-cluster'] }),
    })).status, 401);
    const reorderGpu = await fetch(`${base}/notion/api/gpu/order`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ machines: ['backup-cluster', 'lab-cluster'] }),
    });
    assert.equal(reorderGpu.status, 200);
    assert.deepEqual((await reorderGpu.json()).gpuMachines.map(machine => machine.name), ['backup-cluster', 'lab-cluster']);
    assert.equal((await fetch(`${base}/notion/api/gpu/order`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ machines: ['lab-cluster', 'lab-cluster'] }),
    })).status, 400);
    await stop();
    await start();
    assert.deepEqual((await snapshot()).gpuMachines.map(machine => machine.name), ['backup-cluster', 'lab-cluster']);
    const deleteBackupGpu = await fetch(`${base}/notion/api/gpu/machine`, {
      method: 'DELETE', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ machine: 'backup-cluster' }),
    });
    assert.equal(deleteBackupGpu.status, 200);
    assert.deepEqual((await snapshot()).gpuMachines.map(machine => machine.name), ['lab-cluster']);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal((await snapshot()).gpuMachines[0].online, false);
    const deleteGpu = await fetch(`${base}/notion/api/gpu/machine`, {
      method: 'DELETE', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ machine: 'lab-cluster' }),
    });
    assert.equal(deleteGpu.status, 200);
    assert.equal((await snapshot()).gpuMachines.length, 0);
    assert.equal((await reportGpu()).status, 202);
    gpuMachines = (await snapshot()).gpuMachines;
    assert.equal(gpuMachines.length, 1);
    assert.equal(gpuMachines[0].online, true);
    const sessionId = 'presence-test-session';
    const setPresence = async status => fetch(`${base}/notion/api/presence`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: 'left', sessionId, status }),
    });
    assert.equal((await snapshot()).presence.left.status, 'away');
    assert.equal((await setPresence('wake')).status, 200);
    assert.equal((await snapshot()).presence.left.status, 'online');
    assert.equal((await setPresence('sleeping')).status, 200);
    assert.equal((await snapshot()).presence.left.status, 'sleeping');
    assert.equal((await setPresence('online')).status, 200);
    assert.equal((await snapshot()).presence.left.status, 'sleeping');
    await stop();
    await start();
    assert.equal((await snapshot()).presence.left.status, 'sleeping');
    assert.equal((await setPresence('online')).status, 200);
    assert.equal((await snapshot()).presence.left.status, 'sleeping');
    assert.equal((await setPresence('wake')).status, 200);
    assert.equal((await snapshot()).presence.left.status, 'online');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal((await snapshot()).presence.left.status, 'away');

    assert.equal((await action({ type: 'setIntro', title: '今天也一起加油。', color: 'plum' })).status, 200);
    assert.equal((await action({ type: 'setIntro', title: '无效颜色', color: 'neon' })).status, 400);

    assert.equal((await action({ type: 'setProfile', personId: 'left', name: '小左', avatar: '' })).status, 200);
    assert.equal((await action({ type: 'setSlogan', personId: 'left', text: '慢一点，也是在前进。', color: 'sage' })).status, 200);
    assert.equal((await action({ type: 'setSlogan', personId: 'left', text: '无效', color: 'rainbow' })).status, 400);
    assert.equal((await action({ type: 'setNote', personId: 'left', note: '今天的随手记' })).status, 200);
    const startedAfter = Date.now();
    assert.equal((await action({ type: 'addFocus', personId: 'right', title: '整理房间', endsAt: '2026-09-13T18:00:00.000Z' })).status, 200);
    assert.equal((await action({ type: 'addFocus', personId: 'right', title: '等洗衣机', endsAt: '' })).status, 200);
    const beforeFocusMove = await state();
    assert.deepEqual(beforeFocusMove.people[1].focuses.map(focus => focus.title), ['等洗衣机', '整理房间']);
    const roomFocus = beforeFocusMove.people[1].focuses.find(focus => focus.title === '整理房间');
    const laundryFocus = beforeFocusMove.people[1].focuses.find(focus => focus.title === '等洗衣机');
    assert.equal((await action({ type: 'moveFocus', personId: 'right', focusId: roomFocus.id, targetId: laundryFocus.id, position: 'before' })).status, 200);
    assert.deepEqual((await state()).people[1].focuses.map(focus => focus.title), ['整理房间', '等洗衣机']);
    assert.equal((await action({ type: 'clearFocus', personId: 'right', focusId: laundryFocus.id })).status, 200);
    const movedToTodo = await state();
    assert.ok(movedToTodo.people[1].todos.some(todo => todo.text === '等洗衣机' && todo.status === 'todo'));
    assert.equal((await action({ type: 'deleteFocus', personId: 'right', focusId: roomFocus.id })).status, 200);
    assert.equal((await state()).people[1].focuses.length, 0);
    assert.equal((await action({ type: 'addTodo', personId: 'left', text: '买牛奶' })).status, 200);
    const withTodo = await state();
    const todoId = withTodo.people[0].todos[0].id;
    assert.equal((await action({ type: 'editTodo', personId: 'left', todoId, text: '买燕麦奶' })).status, 200);
    assert.equal((await action({ type: 'addTodo', personId: 'left', text: '洗衣服' })).status, 200);
    const beforeMove = await state();
    const laundryId = beforeMove.people[0].todos.find(todo => todo.text === '洗衣服').id;
    assert.equal((await action({ type: 'moveTodo', personId: 'left', todoId, targetId: laundryId, position: 'before' })).status, 200);
    assert.deepEqual((await state()).people[0].todos.slice(0, 2).map(todo => todo.text), ['买燕麦奶', '洗衣服']);
    assert.equal((await action({ type: 'startTodo', personId: 'left', todoId })).status, 200);
    const doing = await state();
    const focusId = doing.people[0].focuses[0].id;
    assert.ok(new Date(doing.people[0].focuses[0].startedAt).getTime() >= startedAfter);
    assert.equal((await action({ type: 'completeFocus', personId: 'left', focusId })).status, 200);
    assert.equal((await action({ type: 'toggleTodo', personId: 'left', todoId, done: false })).status, 200);
    const restored = (await state()).people[0].todos.find(todo => todo.id === todoId);
    assert.equal(restored.status, 'todo');
    assert.equal(restored.done, false);
    assert.equal(restored.completedAt, null);
    assert.equal((await action({ type: 'toggleTodo', personId: 'left', todoId, done: true })).status, 200);

    assert.equal((await action({ type: 'addTodo', personId: 'right', text: '隔天复盘', recurrence: 'days', recurrenceInterval: 2, occurrenceDate: '2026-09-21', important: true })).status, 200);
    assert.equal((await action({ type: 'addTodo', personId: 'right', text: '错误日期', recurrence: 'days', recurrenceInterval: 1, occurrenceDate: '2026-02-30', important: false })).status, 400);
    const dailyTodo = (await state()).people[1].todos.find(todo => todo.text === '隔天复盘');
    assert.equal(dailyTodo.recurrence, 'days');
    assert.equal(dailyTodo.recurrenceInterval, 2);
    assert.equal(dailyTodo.occurrenceDate, '2026-09-21');
    assert.equal(dailyTodo.important, true);
    assert.ok(dailyTodo.seriesId);
    assert.equal((await action({ type: 'toggleTodo', personId: 'right', todoId: dailyTodo.id, done: true })).status, 200);
    const afterDailyCompletion = await state();
    const dailySeries = afterDailyCompletion.people[1].todos.filter(todo => todo.seriesId === dailyTodo.seriesId);
    assert.equal(dailySeries.length, 2);
    assert.ok(dailySeries.some(todo => todo.occurrenceDate === '2026-09-21' && todo.status === 'done'));
    assert.ok(dailySeries.some(todo => todo.occurrenceDate === '2026-09-23' && todo.status === 'todo' && todo.important));

    const firstDueAt = '2099-09-21T12:00:00.000Z';
    assert.equal((await action({ type: 'addTodo', personId: 'right', text: '喝水', recurrence: 'hours', recurrenceInterval: 6, dueAt: firstDueAt, important: false })).status, 200);
    const hourlyTodo = (await state()).people[1].todos.find(todo => todo.text === '喝水');
    assert.equal(hourlyTodo.dueAt, firstDueAt);
    assert.equal((await action({ type: 'toggleTodo', personId: 'right', todoId: hourlyTodo.id, done: true })).status, 200);
    const hourlySeries = (await state()).people[1].todos.filter(todo => todo.seriesId === hourlyTodo.seriesId);
    assert.ok(hourlySeries.some(todo => todo.dueAt === '2099-09-21T18:00:00.000Z' && todo.status === 'todo'));

    const upload = await fetch(`${base}/notion/api/upload`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'image/png' }, body: Buffer.from('small-test-image'),
    });
    assert.equal(upload.status, 201);
    const imageUrl = (await upload.json()).url;
    assert.match(imageUrl, /^\/notion\/media\/[a-f0-9]{32}\.png$/);
    assert.equal((await action({ type: 'addWall', authorId: 'left', text: '今日份照片', images: [imageUrl] })).status, 200);
    const wallId = (await state()).wall[0].id;
    const secondUpload = await fetch(`${base}/notion/api/upload`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'image/webp' }, body: Buffer.from('second-small-test-image'),
    });
    assert.equal(secondUpload.status, 201);
    const secondImageUrl = (await secondUpload.json()).url;
    assert.equal((await action({ type: 'editWall', itemId: wallId, text: '今日份小日记', images: [imageUrl, secondImageUrl], kind: 'diary', style: 'moon', featured: true })).status, 200);
    assert.equal((await state()).wall[0].images.length, 2);
    assert.equal((await action({ type: 'editWall', itemId: wallId, text: '今日份小日记', images: [secondImageUrl], kind: 'diary', style: 'moon', featured: true })).status, 200);
    assert.equal((await fetch(`${base}${imageUrl}`, { headers: auth() })).status, 404);
    assert.equal((await action({ type: 'editWall', itemId: wallId, text: '无效风格', kind: 'note', style: 'sparkle', featured: false })).status, 400);
    assert.equal((await fetch(`${base}${secondImageUrl}`)).status, 401);
    assert.equal((await fetch(`${base}${secondImageUrl}`, { headers: auth() })).status, 200);

    const saved = await state();
    assert.deepEqual(saved.intro, { title: '今天也一起加油。', color: 'plum' });
    assert.equal(saved.people[0].name, '小左');
    assert.deepEqual(saved.people[0].slogan, { text: '慢一点，也是在前进。', color: 'sage' });
    assert.equal(saved.people[0].note, '今天的随手记');
    const completedTodo = saved.people[0].todos.find(todo => todo.id === todoId);
    assert.equal(completedTodo.done, true);
    assert.equal(completedTodo.text, '买燕麦奶');
    assert.ok(completedTodo.completedAt);
    assert.equal(saved.people[1].focuses.length, 0);
    assert.deepEqual(saved.wall[0].images, [secondImageUrl]);
    assert.deepEqual({ text: saved.wall[0].text, kind: saved.wall[0].kind, style: saved.wall[0].style, featured: saved.wall[0].featured }, { text: '今日份小日记', kind: 'diary', style: 'moon', featured: true });
    await stop();
    await start();
    assert.equal((await snapshot()).gpuMachines[0].name, 'lab-cluster');
    assert.deepEqual((await state()).intro, { title: '今天也一起加油。', color: 'plum' });
    assert.deepEqual((await state()).people[0].slogan, { text: '慢一点，也是在前进。', color: 'sage' });
    assert.equal((await state()).wall[0].text, '今日份小日记');
    assert.equal((await state()).wall[0].featured, true);
    assert.equal((await fetch(`${base}${secondImageUrl}`, { headers: auth() })).status, 200);
  } finally {
    if (child) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('existing single-focus data migrates to the multi-focus model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'note-migration-'));
  const notionDir = join(dir, 'notion');
  await mkdir(notionDir, { recursive: true });
  const oldState = {
    revision: 4,
    updatedAt: '2026-09-13T12:00:00.000Z',
    people: [
      { id: 'left', name: '左', avatar: '', note: '', focus: { title: '旧的进行中事项', endsAt: '', todoId: null }, todos: [{ id: 'oldtodo01', text: '已经做过', done: true, createdAt: '2026-09-12T10:00:00.000Z' }] },
      { id: 'right', name: '右', avatar: '', note: '', focus: { title: '', endsAt: '', todoId: null }, todos: [] },
    ],
    wall: [],
  };
  await writeFile(join(notionDir, 'state.json'), JSON.stringify(oldState));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, CLIPBOARD_STATE_DIR: dir, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const output = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
      child.stdout.once('data', data => resolve(data.toString()));
    });
    const base = `http://127.0.0.1:${output.match(/port (\d+)/)[1]}`;
    const key = (await readFile(join(dir, 'access-token'), 'utf8')).trim();
    const response = await fetch(`${base}/notion/api/state`, { headers: { Authorization: `Bearer ${key}` } });
    const migrated = (await response.json()).state;
    assert.equal(migrated.people[0].focuses[0].title, '旧的进行中事项');
    assert.ok(migrated.people[0].focuses[0].startedAt);
    assert.equal(migrated.people[0].todos[0].status, 'done');
    assert.ok(migrated.people[0].todos[0].completedAt);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    await rm(dir, { recursive: true, force: true });
  }
});
