#!/usr/bin/env python3
"""Two-account premium_interactions monitor. Credentials never leave GitHub requests."""
import argparse
import concurrent.futures
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

ENDPOINT = 'https://api.github.com/copilot_internal/user'
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CACHE = ROOT / 'clipboard/data/copilot/usage.json'


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize(data, account_id, expected_login=None):
    login = data.get('login')
    if not isinstance(login, str) or not login or (expected_login and login.casefold() != expected_login.casefold()):
        raise ValueError('account_mismatch')
    quota = data.get('quota_snapshots', {}).get('premium_interactions')
    if not isinstance(quota, dict):
        raise ValueError('missing_quota')
    entitlement = quota.get('entitlement')
    unlimited = quota.get('unlimited') is True
    if not number(entitlement) or entitlement < 0:
        if not unlimited:
            raise ValueError('invalid_quota')
        entitlement = None
    used = quota.get('credits_used')
    if not number(used):
        remaining = quota.get('quota_remaining', quota.get('remaining'))
        if number(remaining) and entitlement is not None:
            used = max(0, entitlement - remaining)
        elif number(quota.get('percent_remaining')) and entitlement is not None:
            used = max(0, entitlement * (100 - quota['percent_remaining']) / 100)
        else:
            raise ValueError('missing_usage')
    if used < 0:
        raise ValueError('invalid_usage')
    reset = data.get('quota_reset_date_utc') or data.get('quota_reset_date')
    return dict(id=account_id, login=login, used=round(used, 4), quota=entitlement,
                percent=round(used / entitlement * 100, 4) if entitlement and not unlimited else None,
                unlimited=unlimited, resetAt=reset if isinstance(reset, str) else None)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def github_usage(token):
    if not isinstance(token, str) or not token.strip() or '\n' in token.strip() or '\r' in token:
        raise ValueError('invalid_credential')
    request = urllib.request.Request(ENDPOINT, headers={
        'Authorization': 'token ' + token.strip(),
        'User-Agent': 'GitHubCopilotChat/0.44.2',
        'X-GitHub-Api-Version': '2025-04-01',
        'Accept': 'application/json',
    })
    opener = urllib.request.build_opener(NoRedirects())
    with opener.open(request, timeout=25) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('invalid_response')
    return json.loads(raw)


def credentials(account_id, migration_token, copilot_config):
    if account_id == 'migration':
        return migration_token.read_text().strip(), None
    config = json.loads(copilot_config.read_text())
    user = config.get('lastLoggedInUser') or {}
    host = user.get('host', '').rstrip('/')
    login = user.get('login')
    if host != 'https://github.com' or not isinstance(login, str) or not login:
        raise ValueError('invalid_account')
    tokens = config.get('authTokens', {})
    entry = tokens.get(f'{host}:{login}:github') or tokens.get(f'{host}:{login}')
    if not isinstance(entry, dict):
        raise ValueError('missing_credential')
    return entry.get('token'), login


def failure_message(error):
    if isinstance(error, urllib.error.HTTPError):
        if error.code in (401, 403):
            return '认证失效或无权限，请重新授权'
        if error.code == 429:
            return '请求受限，稍后重试'
        return f'查询失败（HTTP {error.code}）'
    if isinstance(error, (FileNotFoundError, PermissionError)):
        return '无法读取本机登录凭据'
    if isinstance(error, (ValueError, KeyError, TypeError, AttributeError)):
        return '账号配置或额度数据不完整'
    return '连接失败，等待下次更新'


def collect_one(account_id, old, migration_token, copilot_config, fetcher=github_usage):
    attempted = utc_now()
    expected = None
    try:
        token, expected = credentials(account_id, migration_token, copilot_config)
        result = normalize(fetcher(token), account_id, expected)
        return {**result, 'status': 'ok', 'updatedAt': attempted, 'lastAttemptAt': attempted, 'error': None}
    except Exception as error:
        # Only carry known public fields forward. Never persist tokens or upstream bodies.
        keep = {key: old[key] for key in ('login', 'used', 'quota', 'percent', 'unlimited', 'resetAt', 'updatedAt') if key in old}
        keep.setdefault('login', expected or ('迁移账号' if account_id == 'migration' else 'Copilot 账号'))
        return {**keep, 'id': account_id, 'status': 'error', 'lastAttemptAt': attempted, 'error': failure_message(error)}


def read_cache(path):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) and isinstance(data.get('accounts'), list) else {'accounts': []}
    except (OSError, ValueError):
        return {'accounts': []}


def atomic_write(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.usage-', delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(data, handle, ensure_ascii=False, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def collector_lock(path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a') as handle:
        os.chmod(handle.name, 0o600)
        deadline = time.monotonic() + 60
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Another update is still running')
                time.sleep(.1)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def update(cache, migration_token, copilot_config):
    with collector_lock(cache):
        old = {account.get('id'): account for account in read_cache(cache)['accounts'] if isinstance(account, dict)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(collect_one, key, old.get(key, {}), migration_token, copilot_config) for key in ('migration', 'copilot')]
            accounts = [future.result() for future in futures]
        result = {'version': 1, 'updatedAt': utc_now(), 'accounts': accounts}
        atomic_write(cache, result)
        return result


def formatted(value):
    if not number(value):
        return '—'
    return f'{value:,.2f}'.rstrip('0').rstrip('.') if value % 1 else f'{value:,.0f}'


def color_line(percent, width):
    # ANSI background colors on spaces: a continuous colored band, no bar glyphs.
    colors = [(81, 173, 143), (87, 161, 188), (165, 135, 210), (231, 165, 96), (221, 108, 126)]
    filled = round(min(100, max(0, percent or 0)) / 100 * width)
    cells = []
    for i in range(width):
        if i < filled:
            position = i / max(1, width - 1) * (len(colors) - 1)
            left = min(len(colors) - 2, int(position))
            factor = position - left
            rgb = [round(colors[left][c] * (1 - factor) + colors[left + 1][c] * factor) for c in range(3)]
        else:
            rgb = [54, 60, 66]
        cells.append(f'\033[48;2;{rgb[0]};{rgb[1]};{rgb[2]}m ')
    return ''.join(cells) + '\033[0m'


def render(data, color=False):
    width = max(8, min(32, shutil.get_terminal_size((100, 24)).columns - 66))
    lines = []
    for account in data.get('accounts', []):
        used, quota, percent = account.get('used'), account.get('quota'), account.get('percent')
        label = account.get('login', account.get('id', '账号'))
        amount = f'{formatted(used)} / {"不限" if account.get("unlimited") else formatted(quota)}'
        percentage = f'{percent:.2f}%' if number(percent) else ('不限额' if account.get('unlimited') else '—')
        line = f'{label:<25} '
        if color:
            line += color_line(percent, width) + '  '
        line += f'{amount}  {percentage}'
        if account.get('status') != 'ok':
            line += '  [更新失败，保留上次数据]' if number(used) else '  [暂时无法查询]'
        lines.append(line)
    return '\n'.join(lines) or '尚无额度数据，请运行 usage 更新。'


def main():
    parser = argparse.ArgumentParser(description='查看两个账号的 premium_interactions 已用量 / 额度及百分比')
    parser.add_argument('--cached', action='store_true', help='只读最近一次后台结果')
    parser.add_argument('--refresh', action='store_true', help='立即更新（默认行为）')
    parser.add_argument('--quiet', action='store_true', help='更新缓存，不显示额度')
    parser.add_argument('--json', action='store_true', help='输出不含凭据的额度 JSON')
    parser.add_argument('--color', choices=['auto', 'always', 'never'], default='auto')
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    parser.add_argument('--migration-token', type=Path, default=Path.home() / 'copilot-api-migration/auth/github_token')
    parser.add_argument('--copilot-config', type=Path, default=Path.home() / '.copilot/config.json')
    args = parser.parse_args()
    try:
        data = read_cache(args.cache) if args.cached and not args.refresh else update(args.cache, args.migration_token, args.copilot_config)
    except Exception:
        print('额度更新失败，未修改登录配置。', file=sys.stderr)
        return 1
    if not args.quiet:
        color = args.color == 'always' or (args.color == 'auto' and sys.stdout.isatty() and 'NO_COLOR' not in os.environ and os.environ.get('TERM') != 'dumb')
        print(json.dumps(data, ensure_ascii=False) if args.json else render(data, color))
    return 1 if not data.get('accounts') or any(account.get('status') != 'ok' for account in data['accounts']) else 0


if __name__ == '__main__':
    raise SystemExit(main())
