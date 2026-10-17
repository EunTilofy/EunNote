import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('quota_usage', Path(__file__).with_name('usage.py'))
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


class UsageTests(unittest.TestCase):
    def payload(self, **quota):
        return {'login': 'account', 'quota_snapshots': {'premium_interactions': {
            'entitlement': 1000, 'remaining': 900, 'unlimited': False, **quota}}}

    def test_uses_credits_before_rounded_or_outdated_remaining(self):
        row = usage.normalize(self.payload(credits_used=116.021, remaining=884, percent_remaining=88.4), 'copilot', 'account')
        self.assertEqual(row['used'], 116.021)
        self.assertEqual(row['percent'], 11.6021)
        self.assertEqual(usage.normalize(self.payload(quota_remaining=883.75), 'migration')['used'], 116.25)

    def test_zero_unlimited_and_overage_do_not_mislead(self):
        zero = usage.normalize(self.payload(entitlement=0, credits_used=0), 'copilot')
        self.assertIsNone(zero['percent'])
        unlimited = usage.normalize(self.payload(unlimited=True, credits_used=14), 'migration')
        self.assertIsNone(unlimited['percent'])
        self.assertTrue(unlimited['unlimited'])
        overage = usage.normalize(self.payload(credits_used=1200), 'copilot')
        self.assertEqual(overage['percent'], 120)
        self.assertIn('120.00%', usage.render({'accounts': [overage]}))

    def test_missing_or_invalid_data_is_not_a_fake_zero(self):
        for data in ({'login': 'account'}, self.payload(entitlement=float('inf')), self.payload(credits_used=-1)):
            with self.assertRaises(ValueError):
                usage.normalize(data, 'copilot')
        with self.assertRaises(ValueError):
            usage.normalize(self.payload(), 'copilot', 'another-account')

    def test_tokens_are_selected_for_current_account_without_changing_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            config = {'lastLoggedInUser': {'host': 'https://github.com', 'login': 'account'},
                      'authTokens': {'https://github.com:account': {'token': 'legacy-secret'},
                                     'https://github.com:account:github': {'token': 'github-secret'}}}
            path.write_text(json.dumps(config))
            before = path.read_bytes()
            token, login = usage.credentials('copilot', Path(directory)/'unused', path)
            self.assertEqual((token, login), ('github-secret', 'account'))
            self.assertEqual(before, path.read_bytes())
            config['lastLoggedInUser']['host'] = 'https://untrusted.invalid'
            path.write_text(json.dumps(config))
            with self.assertRaises(ValueError):
                usage.credentials('copilot', Path(directory)/'unused', path)

    def test_failure_preserves_last_good_usage_without_secrets_or_body(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'github_token'
            token.write_text('sensitive-test-value')
            old = {'used': 15, 'quota': 100, 'percent': 15, 'login': 'account', 'updatedAt': '2026-10-17T00:00:00Z', 'token': 'old-secret'}
            def fail(_token):
                raise urllib.error.HTTPError(usage.ENDPOINT, 401, 'sensitive-test-value', {}, None)
            row = usage.collect_one('migration', old, token, Path(directory)/'unused', fail)
            self.assertEqual(row['used'], 15)
            self.assertEqual(row['updatedAt'], old['updatedAt'])
            self.assertEqual(row['status'], 'error')
            self.assertNotIn('secret', json.dumps(row))
            self.assertNotIn('sensitive-test-value', json.dumps(row))
            self.assertEqual(row['error'], '认证失效或无权限，请重新授权')

    def test_transient_network_failures_retry_but_auth_errors_do_not(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(self.payload()).encode()
        opener = MagicMock()
        opener.open.side_effect = [urllib.error.URLError('reset'), TimeoutError(), response]
        with patch.object(usage.urllib.request, 'build_opener', return_value=opener), patch.object(usage.time, 'sleep') as sleep:
            result = usage.github_usage('private-test-token')
        self.assertEqual(result['login'], 'account')
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        opener.open.reset_mock()
        opener.open.side_effect = urllib.error.HTTPError(usage.ENDPOINT, 401, 'Unauthorized', {}, None)
        with patch.object(usage.urllib.request, 'build_opener', return_value=opener), patch.object(usage.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                usage.github_usage('private-test-token')
        self.assertEqual(opener.open.call_count, 1)
        sleep.assert_not_called()

    def test_atomic_private_cache_and_ansi_band_without_bar_characters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private/usage.json'
            usage.atomic_write(path, {'accounts': []})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(usage.read_cache(path)['accounts'], [])
        band = usage.color_line(50, 20)
        self.assertIn('\033[48;2;', band)
        self.assertNotIn('█', band)
        self.assertNotIn('#', band)


if __name__ == '__main__':
    unittest.main()
