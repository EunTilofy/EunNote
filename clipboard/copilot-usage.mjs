import { readFileSync, statSync } from 'node:fs';

// Expose only quota fields; the gateway never opens Copilot authentication files.
export function createCopilotUsageReader(path) {
  let previousStamp;
  let previous;
  return function readUsage() {
    try {
      const stat = statSync(path);
      if (stat.size > 65536) throw new Error('Invalid quota cache');
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === previousStamp) return previous;
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
      const accounts = ['migration', 'copilot'].map(id => {
        const item = data.accounts?.find(account => account.id === id) || {};
        const quota = numeric(item.quota);
        const used = numeric(item.used);
        return {
          id,
          login: typeof item.login === 'string' ? item.login.slice(0, 100) : (id === 'migration' ? '迁移账号' : 'Copilot 账号'),
          used, quota,
          percent: quota && used !== null && item.unlimited !== true ? used / quota * 100 : null,
          unlimited: item.unlimited === true,
          resetAt: date(item.resetAt), updatedAt: date(item.updatedAt),
          status: item.status === 'ok' ? 'ok' : 'error',
        };
      });
      previous = { updatedAt: date(data.updatedAt), accounts };
      previousStamp = stamp;
      return previous;
    } catch {
      return { updatedAt: null, accounts: [] };
    }
  };
}
