import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./notion/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function copilotReportTime(');
const end = source.indexOf('function updateCopilotTimes(', start);
const format = vm.runInNewContext(`${source.slice(start, end)}; copilotReportTime`);
const now = Date.parse('2026-10-22T08:30:00Z');

test('report ages advance using the original successful timestamp', () => {
  const account = { status: 'ok', updatedAt: '2026-10-22T08:29:30Z' };
  assert.equal(format(account, now).relative, '刚刚上报');
  assert.equal(format(account, now + 60_000).relative, '1 分钟前上报');
  assert.equal(format(account, now + 180_000).relative, '3 分钟前上报');
  assert.equal(format(account, now).iso, '2026-10-22T08:29:30.000Z');
  assert.ok(format(account, now).absolute.includes('29:30'));
});

test('a recent failed attempt cannot make old data look newly reported', () => {
  const info = format({ status: 'error', updatedAt: '2026-10-22T08:19:00Z', lastAttemptAt: '2026-10-22T08:30:00Z' }, now);
  assert.equal(info.relative, '11 分钟前上报');
  assert.equal(info.iso, '2026-10-22T08:19:00.000Z');
  assert.equal(info.delayed, true);
  assert.equal(format({ status: 'ok', updatedAt: '2026-10-22T08:22:59Z' }, now).delayed, true);
  assert.equal(format({ status: 'ok', updatedAt: '2026-10-22T08:27:00Z' }, now).delayed, false);
});

test('missing timestamps and small clock skew do not produce invented or negative ages', () => {
  for (const value of [undefined, null, '', 'not-a-date']) {
    const info = format({ status: 'ok', updatedAt: value }, now);
    assert.equal(info.relative, '尚未成功上报');
    assert.equal(info.iso, '');
    assert.equal(info.delayed, true);
  }
  assert.equal(format({ status: 'ok', updatedAt: '2026-10-22T08:30:10Z' }, now).relative, '刚刚上报');
});
