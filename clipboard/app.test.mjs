import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(hash = '#key=test-key') {
  const elements = Object.fromEntries(['text', 'status', 'count', 'save', 'copy'].map((id) => [id, {
    value: '', disabled: true, dataset: {}, handlers: {}, textContent: '',
    selectionStart: 0, selectionEnd: 0,
    addEventListener(name, handler) { this.handlers[name] = handler; },
    focus() {}, select() { this.selected = true; }, setSelectionRange() {},
  }]));
  const timeouts = new Map();
  const intervals = [];
  const state = { text: 'initial', revision: 0, updatedAt: null };
  const control = { offline: false, writes: 0, copies: 0 };
  let nextTimer = 0;
  const context = {
    document: {
      querySelector: (selector) => elements[selector.slice(1)],
      addEventListener() {},
      visibilityState: 'visible',
      execCommand(command) { assert.equal(command, 'copy'); control.copies++; return true; },
    },
    location: { hash }, navigator: {},
    window: { isSecureContext: false, addEventListener() {} },
    URLSearchParams, AbortSignal, Blob,
    setInterval(fn) { intervals.push(fn); },
    setTimeout(fn) { timeouts.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timeouts.delete(id); },
    async fetch(path, options) {
      assert.equal(path, '/api/text');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      if (control.offline) throw new Error('Network offline');
      if (options.method === 'PUT') {
        state.text = options.body;
        state.revision++;
        state.updatedAt = new Date().toISOString();
        control.writes++;
      }
      const snapshot = { ...state };
      return { ok: true, json: async () => snapshot };
    },
  };
  vm.runInNewContext(source, context);
  return {
    elements, state, control,
    async type(value) {
      elements.text.value = value;
      elements.text.handlers.input();
    },
    async runTimers() {
      const callbacks = [...timeouts.values()];
      timeouts.clear();
      for (const fn of callbacks) await fn();
      await settle();
    },
    async poll() { for (const fn of intervals) fn(); await settle(); },
  };
}

test('editor loads, saves pasted text, syncs remote changes and copies over HTTP', async () => {
  const app = setup();
  await settle();
  assert.equal(app.elements.text.value, 'initial');
  assert.equal(app.elements.text.disabled, false);
  await app.type('粘贴内容\n<script>plain text</script>');
  app.state.text = 'remote while dirty';
  app.state.revision++;
  await app.poll();
  assert.equal(app.elements.text.value, '粘贴内容\n<script>plain text</script>');
  await app.runTimers();
  assert.equal(app.state.text, app.elements.text.value);
  assert.equal(app.control.writes, 1);
  assert.equal(app.elements.status.dataset.kind, 'saved');
  app.state.text = 'latest from another device';
  app.state.revision++;
  await app.poll();
  assert.equal(app.elements.text.value, app.state.text);
  await app.elements.copy.handlers.click();
  assert.equal(app.control.copies, 1);
  await app.type('');
  await app.runTimers();
  assert.equal(app.state.text, '');
});

test('failed saves retain local text and retry without remote overwrite', async () => {
  const app = setup();
  await settle();
  app.control.offline = true;
  await app.type('unsaved draft');
  await app.runTimers();
  assert.equal(app.elements.status.dataset.kind, 'error');
  assert.equal(app.elements.text.value, 'unsaved draft');
  app.control.offline = false;
  await app.poll();
  assert.equal(app.elements.text.value, 'unsaved draft');
  await app.runTimers();
  assert.equal(app.state.text, 'unsaved draft');
  assert.equal(app.elements.status.dataset.kind, 'saved');
});

test('missing key keeps editor disabled', async () => {
  const app = setup('');
  await settle();
  assert.equal(app.elements.text.disabled, true);
  assert.equal(app.elements.status.dataset.kind, 'error');
});
