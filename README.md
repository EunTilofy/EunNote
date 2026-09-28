# EunNote

EunNote is the source tree for the services published on port 6357:

- `/` — the launcher for all functions
- `/clipboard/` — the shared clipboard
- `/notion/` — the two-person note space and GPU monitor
- `/shuji/` — the 数迹 number game, proxied from its private local service

## Repository layout

```text
EunNote/
├── clipboard/       # launcher, clipboard, note, GPU ingestion API
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
- systemd user services for the production setup

## Install and test

```bash
cd ~/EunNote/shuji
npm ci
npm test

cd ~/EunNote/clipboard
node --test app.test.mjs server.test.mjs notion.test.mjs
```

The clipboard service has no third-party runtime dependencies. 数迹 uses the
dependencies pinned in `shuji/package-lock.json`.

## Production services

The deployment on this host runs the public gateway on port 6357 and 数迹 on
the private loopback port 6358. The gateway proxies `/shuji/` to that private
service.

Service templates are in `deploy/systemd/`. After copying them into the user
systemd directory, reload and restart them with:

```bash
systemctl --user daemon-reload
systemctl --user enable --now shuji.service clipboard.service
```

The live access key is generated in `clipboard/data/access-token`. Never add
runtime data or access keys to Git.
