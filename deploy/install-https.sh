#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run this deployment script with system administrator privileges.' >&2; exit 1; }
SERVER_ADDRESS=${1:?Usage: install-https.sh PUBLIC_IP}
python3 - "$SERVER_ADDRESS" <<'PY'
import ipaddress, sys
ipaddress.ip_address(sys.argv[1])
PY
DEPLOY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(dirname "$DEPLOY_ROOT")
[[ "$PROJECT_ROOT" == /home/zzx/EunNote ]] || { echo 'Review service paths before deploying from another directory.' >&2; exit 1; }
[[ -x /opt/eunnote-certbot/bin/certbot ]] || { echo 'Install Certbot >=5.4 in /opt/eunnote-certbot first.' >&2; exit 1; }
install -d -m 0755 /var/lib/eunnote-acme /usr/local/lib/eunnote /etc/eunnote
install -m 0755 "$DEPLOY_ROOT/restrict-web-ports.sh" /usr/local/lib/eunnote/restrict-web-ports
install -m 0755 "$DEPLOY_ROOT/reload-nginx.sh" /usr/local/lib/eunnote/reload-nginx

# Serve only the ACME challenge before the certificate is available.
cat > /etc/nginx/sites-available/eunnote <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $SERVER_ADDRESS;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/eunnote-acme;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 403; }
}
EOF
python3 - <<'PY'
from pathlib import Path
default = Path('/etc/nginx/sites-enabled/default')
if default.is_symlink():
    default.unlink()
enabled = Path('/etc/nginx/sites-enabled/eunnote')
if not enabled.exists():
    enabled.symlink_to('/etc/nginx/sites-available/eunnote')
config = Path('/etc/nginx/nginx.conf')
text = config.read_text().replace('worker_processes auto;', 'worker_processes 2;')
config.write_text(text)
PY
nginx -t
nginx -s reload
/opt/eunnote-certbot/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot --webroot-path /var/lib/eunnote-acme --preferred-profile shortlived \
  --ip-address "$SERVER_ADDRESS" --cert-name "$SERVER_ADDRESS" --keep-until-expiring

# Rotate compromised application credentials. Values never appear in deployment output.
runuser -u zzx -- python3 - "$PROJECT_ROOT" <<'PY'
import os, secrets, sys
from pathlib import Path
root = Path(sys.argv[1]) / 'clipboard/data'
for name, count in [('access-token', 24), ('gpu-monitor-token', 32)]:
    path = root / name
    temporary = root / ('.' + name + '.rotation')
    temporary.write_text(secrets.token_hex(count) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)
PY

# Disable only the old website units. Other user services are untouched.
runuser -u zzx -- python3 - <<'PY'
from pathlib import Path
root = Path.home() / '.config/systemd/user'
for name in ['clipboard.service', 'shuji.service']:
    wanted = root / 'default.target.wants' / name
    if wanted.is_symlink():
        wanted.unlink()
    unit = root / name
    backup = root / (name + '.before-https')
    if unit.is_file() and not unit.is_symlink():
        if not backup.exists():
            unit.rename(backup)
        else:
            unit.unlink()
    if not unit.exists():
        unit.symlink_to('/dev/null')
PY
# Identify exact old application entrypoints, without killing unrelated Node jobs.
python3 - "$PROJECT_ROOT" <<'PY'
import os, pwd, signal, sys, time
from pathlib import Path
uid = pwd.getpwnam('zzx').pw_uid
scripts = {str(Path(sys.argv[1]) / 'clipboard/server.mjs'), str(Path(sys.argv[1]) / 'shuji/server.js')}
old = []
for directory in Path('/proc').iterdir():
    if not directory.name.isdigit():
        continue
    try:
        args = directory.joinpath('cmdline').read_bytes().split(b'\0')
        if directory.stat().st_uid == uid and any(os.fsdecode(arg) in scripts for arg in args):
            old.append(int(directory.name))
            os.kill(int(directory.name), signal.SIGTERM)
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
deadline = time.monotonic() + 7
while any(Path('/proc', str(pid)).exists() for pid in old) and time.monotonic() < deadline:
    time.sleep(.1)
for pid in old:
    try:
        directory = Path('/proc', str(pid))
        args = directory.joinpath('cmdline').read_bytes().split(b'\0')
        if directory.stat().st_uid == uid and any(os.fsdecode(arg) in scripts for arg in args):
            os.kill(pid, signal.SIGKILL)
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
PY
for unit in eunnote-gateway.service eunnote-shuji.service eunnote-web-ports.service eunnote-cert-renew.service eunnote-cert-renew.timer; do
    sed "s/SERVER_ADDRESS/$SERVER_ADDRESS/g" "$DEPLOY_ROOT/systemd/$unit" > "/etc/systemd/system/$unit"
    chmod 0644 "/etc/systemd/system/$unit"
done
sed "s/SERVER_ADDRESS/$SERVER_ADDRESS/g" "$DEPLOY_ROOT/nginx/eunnote-proxy.conf" > /etc/nginx/eunnote-proxy.conf
sed "s/SERVER_ADDRESS/$SERVER_ADDRESS/g" "$DEPLOY_ROOT/nginx/eunnote.conf" > /etc/nginx/sites-available/eunnote
nginx -t
systemctl daemon-reload
systemctl enable --now eunnote-web-ports.service eunnote-shuji.service eunnote-gateway.service eunnote-cert-renew.timer nginx.service
systemctl restart eunnote-shuji.service eunnote-gateway.service
nginx -s reload
systemctl is-active eunnote-gateway.service eunnote-shuji.service nginx.service eunnote-cert-renew.timer
echo "HTTPS deployment complete: https://$SERVER_ADDRESS/eunnote/"
