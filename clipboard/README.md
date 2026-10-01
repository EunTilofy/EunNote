# Online clipboard and note

A single shared plain-text editor on port 6357. Node.js 22+; no third-party
dependencies. Changes auto-save after 400 ms, and idle clients poll every two
seconds. Concurrent edits use last-save-wins semantics, not collaborative merge.
Only the current text is retained, using atomic on-disk replacement.

## Run

```sh
node server.mjs
```

The default bind address is `0.0.0.0`; `HOST` and `PORT` override it.
`CLIPBOARD_STATE_DIR` overrides the default `data/` directory.
The service generates a private access key in `data/access-token`. Open:

```text
http://SERVER_IP:6357/clipboard/#key=ACCESS_TOKEN
```

The two-person shared note space is available at:

```text
http://SERVER_IP:6357/notion/#key=ACCESS_TOKEN
```

The root URL is a launcher for the clipboard, note, and the locally hosted 数迹 app:

```text
http://SERVER_IP:6357/#key=ACCESS_TOKEN
```

It includes two persistent scratchpads, current focus and expected finish time,
todo lists, profiles, light/dark themes, and a shared text and image wall. Images
can be selected, dragged in, or pasted from the clipboard. Note state and media
are stored under `data/notion/`; each image is limited to 8 MiB.

The fragment is not sent in HTTP URLs; the app passes the key in an authorization
header. Anyone with the link can read and overwrite the shared text. This is
HTTP, not encrypted transport; do not use it for sensitive data. Maximum text
size is 2 MiB in UTF-8. Clipboard copying falls back to selection-based copying
on HTTP. Failed saves remain in the editor with an error and automatic retries;
wait for the saved indicator before closing. There is no version history.

## GPU reporting

The Note GPU panel accepts authenticated reports at:

```text
POST /notion/api/gpu/report
Authorization: Bearer GPU_MONITOR_TOKEN
```

The private token is generated in `data/gpu-monitor-token`. The repository's
`gpu-tools/install.sh` configures a host or cluster, detects its nodes and GPUs,
installs `ggpu` and `gpu-filler`, and enables periodic reporting. Filler
processes are excluded from real occupancy, while raw utilization remains
visible. Each GPU also retains the time when its latest idle period began.

## Installed service

```sh
systemctl --user status clipboard.service
systemctl --user restart clipboard.service
journalctl --user -u clipboard.service -n 30 --no-pager
```

To rotate the link, stop the service, remove `data/access-token`, then restart.
The saved text is in `data/text.json`. No text or access keys are logged.

## Tests

```sh
node --test app.test.mjs server.test.mjs
```
