# Copilot premium usage

This collector shows only `quota_snapshots.premium_interactions` for two accounts:

- The GitHub token in `~/copilot-api-migration/auth/github_token`.
- The current `lastLoggedInUser` in `~/.copilot/config.json`, using its GitHub authentication entry.

No Codex settings are read or modified. No API proxy, Docker container, public
port, or LLM request is needed. The upstream endpoint is the same GitHub usage
endpoint used by the migration package. It is an internal GitHub API and can
change; missing quota data is shown as unavailable rather than zero usage.

```bash
ln -s ~/EunNote/copilot-usage/usage ~/.local/bin/usage
usage                 # refresh both accounts, show two rows
usage --cached        # display the latest background result immediately
usage --json          # sanitized quota JSON, never credentials
usage --color always  # force ANSI color for terminal previews
```

In a terminal the bar uses ANSI RGB background colors on spaces, not block
characters or ASCII art. Redirected output defaults to plain text. Usage is
`credits_used` when present; otherwise it is calculated from the exact remaining
quota, with percentage calculated from used / entitlement. Unlimited and zero
entitlement are displayed without inventing percentages. The numeric usage can
exceed the quota; only the visual line is capped at 100%.

The cache is written atomically with mode 0600 at
`clipboard/data/copilot/usage.json`. It contains account names, quota values,
reset dates, timestamps and safe error messages only. On a failed refresh the
last successful result and its original timestamp are preserved. Transient
connection failures and upstream HTTP 5xx errors are retried up to three times
with bounded timeouts and backoff; authentication failures are not retried. The frontend
marks failed refreshes or results older than 11 minutes as delayed.

## Five-minute background collection

Create `~/EunNote/clipboard/data/copilot` as `zzx` with mode 0700. Install
`deploy/systemd/eunnote-copilot-usage.{service,timer}` into `/etc/systemd/system`,
then enable the timer and run the service once. The system service runs as `zzx`
with filesystem restrictions and no capabilities. Optional outbound proxy
settings belong in root-owned `/etc/eunnote/copilot-usage-network.env` (0600).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eunnote-copilot-usage.timer
sudo systemctl start eunnote-copilot-usage.service
systemctl status eunnote-copilot-usage.timer
```

The Note gateway reads only the sanitized cache, never the authentication files.
Note displays the quota section immediately below GPU usage. Existing GPU
reporting schedules are unchanged.

Tests: `python3 -m unittest discover -s copilot-usage -p 'test_*.py'` and
`node --test clipboard/copilot-usage.test.mjs`.
