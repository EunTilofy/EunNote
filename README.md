# EunNote

EunNote is the source tree for the private tools published through HTTPS:

- `/eunnote/` — the launcher for all functions
- `/eunnote/clipboard/` — the shared clipboard
- `/eunnote/notion/` — the two-person note space and GPU monitor
- `/eunnote/shuji/` — the 数迹 number game, proxied from its private local service

## Repository layout

```text
EunNote/
├── clipboard/       # launcher, clipboard, note, GPU ingestion API
├── copilot-usage/   # two-account premium usage CLI and five-minute collector
├── gpu-tools/       # GPU filler, tracker, ggpu, and installer
├── shuji/           # 数迹 server, client, and tests
└── deploy/systemd/  # service unit templates used by this host
```

The live state stays beside the applications in `clipboard/data/` and
`shuji/data/`. Those directories contain access keys, uploaded images, notes,
profiles, histories, and GPU reports, so Git intentionally ignores their
contents. Only the placeholder files are committed.

## Requirements

- Node.js 20 or newer
- npm for installing 数迹 dependencies
- Nginx, Certbot >=5.4, and systemd system services for HTTPS production hosting

## Install and test

```bash
cd ~/EunNote/shuji
npm ci
npm test

cd ~/EunNote/clipboard
node --test app.test.mjs server.test.mjs notion.test.mjs security.test.mjs copilot-usage.test.mjs
```

The clipboard service has no third-party runtime dependencies. 数迹 uses the
dependencies pinned in `shuji/package-lock.json`.

GPU hosts can install the monitoring and cooperative filler commands with
`gpu-tools/install.sh`. See `gpu-tools/README.md` for node discovery, reporting,
`ggpu`, and `gpu-filler` usage.

## Production services

Public access is `https://123.59.6.243/eunnote/`, without an explicit port. Nginx serves
HTTPS on 443 and redirects HTTP on 80; port 80 also serves the ACME certificate
challenge. The public launcher lives under `/eunnote/`; legacy page links redirect there.
Both application services use `PUBLIC_BASE_PATH=/eunnote`. The application still listens on `0.0.0.0:6357`, and 数迹 still
listens on `127.0.0.1:6358`. A dedicated IPv4/IPv6 firewall chain blocks direct
public access to these two backend ports without changing their bind addresses.

The new website services are `eunnote-gateway.service` and
`eunnote-shuji.service`. They run as `zzx` under the system service manager with
filesystem restrictions, no capabilities, and no access to the user's SSH
directory, configuration directory, or agent sockets. Only application data
directories are writable. The legacy user website units are masked during
deployment; GPU reporting remains separately paused.

Install Nginx and create a root-owned Certbot virtual environment first:

```bash
sudo apt-get install nginx python3-venv
sudo python3 -m venv /opt/eunnote-certbot
sudo /opt/eunnote-certbot/bin/pip install 'certbot>=5.4,<6'
sudo bash ~/EunNote/deploy/install-https.sh 123.59.6.243
```

The deployment script rotates both application access keys, requests a trusted
IP certificate, installs the reverse proxy and backend port filter, and enables
the certificate renewal timer. Re-running it rotates access keys again and
restarts the website. Certificate issuance needs public access to port 80.
Optional network proxy settings for Certbot belong in root-owned
`/etc/eunnote/certbot-network.env`, not in Git. Certificates and private keys
remain in `/etc/letsencrypt` and never enter the repository.

## Access and credentials

The login form exchanges the website access code for a random HttpOnly,
Secure, SameSite=Strict cookie. Only session-token hashes are stored on disk.
Sessions expire after 30 days, survive restarts, and are revoked on logout.
Logout also disconnects authenticated game WebSockets. Rotating the access code
invalidates existing sessions. Closing the browser does not sign out. The long-lived code is no longer forwarded in
navigation URLs or stored in a browser cookie. HTTP APIs and game transports
require authentication; cross-origin requests, invalid host headers, excessive
login attempts, oversized bodies and invalid image formats are rejected.

Read the access code from `clipboard/data/access-token` on a trusted device
over SSH. It is separate from the Linux account password. Do not put it in
chat, Git, command-line URLs or shared logs. To rotate it, replace the file with
a fresh 24-byte hexadecimal value with mode 0600, then restart both website
services. GPU reporters must use the HTTPS endpoint
`https://123.59.6.243/eunnote/notion/api/gpu/report` with the independent token from
`clipboard/data/gpu-monitor-token`; the previous GPU token is revoked during
deployment. Reporting on 242–245 stays paused until explicitly re-enabled.

The renewal timer checks short-lived IP certificates every six hours and
reloads Nginx after renewal. Check its status with
`systemctl status eunnote-cert-renew.timer`. Website hardening does not replace
host recovery or revocation of previously exposed SSH keys.

## Copilot quota monitor

`usage` shows the two accounts' premium usage as colored terminal lines with
used / quota and percentages. `usage --cached` reads the five-minute background
snapshot. Note shows the same two accounts below GPU usage. See
[`copilot-usage/README.md`](copilot-usage/README.md) for installation, credential
sources and error handling. Both accounts are read from separate private
`config.json` files; the Copilot API migration package is not required.
Authentication files remain outside Git and the
web server only reads sanitized quota data. Codex configuration is unchanged.
