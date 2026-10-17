import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCopilotUsageReader } from './copilot-usage.mjs';

test('only quota data reaches the browser, with derived percentages and isolated cache refreshes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-public-'));
  try {
    const path = join(directory, 'usage.json');
    const read = createCopilotUsageReader(path);
    assert.deepEqual(read(), { updatedAt: null, accounts: [] });
    writeFileSync(path, JSON.stringify({ updatedAt: '2026-10-17T00:00:00Z', token: 'never-expose', accounts: [
      { id: 'migration', login: 'first', used: 25, quota: 100, percent: 99, status: 'ok', updatedAt: '2026-10-17T00:00:00Z', secret: 'never-expose' },
      { id: 'copilot', login: 'second', used: 0, quota: 0, percent: 100, status: 'error' },
    ] }));
    let result = read();
    assert.equal(result.accounts.length, 2);
    assert.equal(result.accounts[0].percent, 25);
    assert.equal(result.accounts[1].percent, null);
    assert.equal(result.accounts[1].status, 'error');
    assert.ok(!JSON.stringify(result).includes('never-expose'));
    assert.strictEqual(read(), result, 'unchanged cache uses the same sanitized snapshot');
    writeFileSync(path, '{broken');
    assert.deepEqual(read(), { updatedAt: null, accounts: [] });
    writeFileSync(path, JSON.stringify({ accounts: [{ id: 'migration', login: 'updated', used: 125, quota: 100, unlimited: false, status: 'ok' }] }));
    result = read();
    assert.equal(result.accounts[0].percent, 125, 'overage is visible rather than hidden');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
