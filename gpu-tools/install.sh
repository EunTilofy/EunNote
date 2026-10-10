#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALL_ROOT=${EUNNOTE_GPU_INSTALL_ROOT:-"$HOME/.local/share/eunnote-gpu"}
BIN_DIR=${EUNNOTE_GPU_BIN_DIR:-"$HOME/.local/bin"}
SYSTEMD_DIR=${EUNNOTE_GPU_SYSTEMD_DIR:-"$HOME/.config/systemd/user"}
MACHINE_NAME=
REPORT_URL=
HOSTS_OVERRIDE=
TOKEN_FILE=
TOKEN_STDIN=0
NO_SERVICE=0
INTERVAL=60

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Interactive use asks for the machine display name, EunNote report URL, and
private GPU report token. Nodes and GPU counts are detected automatically.

Options:
  --machine-name NAME  Non-interactive machine display name
  --report-url URL     EunNote base URL or /notion/api/gpu/report endpoint
  --hosts LIST         Comma-separated node override
  --token-file FILE    Read the private report token from FILE
  --token-stdin        Read the private report token from standard input
  --interval SECONDS   Report interval (minimum 10, default 60)
  --no-service         Install commands without enabling the user timer
  -h, --help           Show this help
EOF
}

while (($#)); do
  case "$1" in
    --machine-name) MACHINE_NAME=${2:?missing machine name}; shift 2;;
    --report-url) REPORT_URL=${2:?missing report URL}; shift 2;;
    --hosts) HOSTS_OVERRIDE=${2:?missing host list}; shift 2;;
    --token-file) TOKEN_FILE=${2:?missing token file}; shift 2;;
    --token-stdin) TOKEN_STDIN=1; shift;;
    --interval) INTERVAL=${2:?missing interval}; shift 2;;
    --no-service) NO_SERVICE=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2;;
  esac
done

[[ "$INTERVAL" =~ ^[0-9]+$ ]] && ((INTERVAL >= 10)) || {
  echo "--interval must be an integer of at least 10 seconds" >&2
  exit 2
}

PYTHON_BIN=${PYTHON_BIN:-$(command -v python3 || command -v python || true)}
[[ -n "$PYTHON_BIN" ]] || { echo "Python 3 is required." >&2; exit 1; }

mkdir -p "$INSTALL_ROOT/eunnote_gpu" "$BIN_DIR" "$SYSTEMD_DIR"
install -m 0644 "$SOURCE_DIR"/eunnote_gpu/*.py "$INSTALL_ROOT/eunnote_gpu/"

make_wrapper() {
  local name=$1 module=$2
  cat >"$BIN_DIR/$name" <<EOF
#!/bin/sh
PYTHONPATH="$INSTALL_ROOT" exec "$PYTHON_BIN" -m "$module" "\$@"
EOF
  chmod 0755 "$BIN_DIR/$name"
}
make_wrapper ggpu eunnote_gpu.ggpu
make_wrapper gpu-filler eunnote_gpu.filler_cli
make_wrapper gpu-track eunnote_gpu.track

ensure_user_path() {
  local file=$1
  local marker='# EunNote GPU tools'
  touch "$file"
  if ! grep -Fq "$marker" "$file"; then
    cat >>"$file" <<'EOF'

# EunNote GPU tools
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
EOF
  fi
}
ensure_user_path "$HOME/.profile"
ensure_user_path "$HOME/.bashrc"

if [[ -n "$HOSTS_OVERRIDE" ]]; then
  HOSTS=$(tr ',' '\n' <<<"$HOSTS_OVERRIDE" | awk 'NF && !seen[$0]++')
  DISCOVERY_SOURCE="--hosts"
else
  DISCOVERY_OUTPUT=$(PYTHONPATH="$INSTALL_ROOT" "$PYTHON_BIN" -m eunnote_gpu.common --discover --source)
  DISCOVERY_SOURCE=${DISCOVERY_OUTPUT%%$'\n'*}
  HOSTS=${DISCOVERY_OUTPUT#*$'\n'}
fi
NODE_COUNT=$(awk 'NF {count++} END {print count+0}' <<<"$HOSTS")
((NODE_COUNT > 0)) || { echo "No cluster nodes were detected." >&2; exit 1; }

if [[ -z "$MACHINE_NAME" ]]; then
  default_name=$(hostname)
  if [[ -t 0 ]]; then
    read -r -p "当前机器在 Note 中显示的名字 [$default_name]: " MACHINE_NAME
  fi
  MACHINE_NAME=${MACHINE_NAME:-$default_name}
fi
if [[ -z "$REPORT_URL" ]]; then
  default_url=http://123.59.6.243:6357/notion/api/gpu/report
  if [[ -t 0 ]]; then
    read -r -p "GPU 信息发送链接 [$default_url]: " REPORT_URL
  fi
  REPORT_URL=${REPORT_URL:-$default_url}
fi

if [[ -n "$TOKEN_FILE" ]]; then
  REPORT_TOKEN=$(<"$TOKEN_FILE")
elif ((TOKEN_STDIN)); then
  REPORT_TOKEN=$(cat)
elif [[ -t 0 ]]; then
  read -r -s -p "GPU 上报密钥: " REPORT_TOKEN
  echo
else
  echo "Non-interactive installation requires --token-file or --token-stdin." >&2
  exit 2
fi
REPORT_TOKEN=${REPORT_TOKEN//$'\r'/}
REPORT_TOKEN=${REPORT_TOKEN//$'\n'/}
[[ -n "$REPORT_TOKEN" ]] || { echo "GPU report token cannot be empty." >&2; exit 2; }

REMOTE_PYTHON=${REMOTE_PYTHON:-python3}
WORKER_PYTHON=${WORKER_PYTHON:-}
if [[ -z "$WORKER_PYTHON" ]]; then
  for candidate in "$PYTHON_BIN" /opt/miniconda3/bin/python3 /opt/miniconda3/bin/python "$(command -v python 2>/dev/null || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if "$candidate" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)' >/dev/null 2>&1; then
      WORKER_PYTHON=$candidate
      break
    fi
  done
fi
WORKER_PYTHON=${WORKER_PYTHON:-$PYTHON_BIN}

printf '%s' "$REPORT_TOKEN" | PYTHONPATH="$INSTALL_ROOT" "$PYTHON_BIN" -m eunnote_gpu.configure \
  --machine-name "$MACHINE_NAME" --report-url "$REPORT_URL" --hosts "$HOSTS" \
  --remote-python "$REMOTE_PYTHON" --worker-python "$WORKER_PYTHON" \
  --interval "$INTERVAL" --token-stdin >/dev/null
unset REPORT_TOKEN

install -m 0644 "$SOURCE_DIR/systemd/eunnote-gpu-track.service" "$SYSTEMD_DIR/eunnote-gpu-track.service"
sed "s/OnUnitInactiveSec=60s/OnUnitInactiveSec=${INTERVAL}s/" \
  "$SOURCE_DIR/systemd/eunnote-gpu-track.timer" >"$SYSTEMD_DIR/eunnote-gpu-track.timer"
if [[ "$INTERVAL" != 60 ]]; then
  sed -i '/^OnCalendar=/d' "$SYSTEMD_DIR/eunnote-gpu-track.timer"
fi
chmod 0644 "$SYSTEMD_DIR/eunnote-gpu-track.timer"

echo "Detected $NODE_COUNT node(s) from $DISCOVERY_SOURCE:"
sed 's/^/  - /' <<<"$HOSTS"
echo "Installed commands: $BIN_DIR/gpu-filler, $BIN_DIR/ggpu, $BIN_DIR/gpu-track"
echo "Filler Python: $WORKER_PYTHON"

if ((NO_SERVICE == 0)); then
  if systemctl --user daemon-reload >/dev/null 2>&1; then
    systemctl --user enable --now eunnote-gpu-track.timer
    if systemctl --user start eunnote-gpu-track.service; then
      echo "GPU tracking is active and reporting every ${INTERVAL}s."
    else
      echo "Installed, but the first report failed. Check: journalctl --user -u eunnote-gpu-track.service -n 30" >&2
      exit 1
    fi
  else
    echo "User systemd is unavailable. Run 'gpu-track --watch $INTERVAL' with your process supervisor." >&2
  fi
fi

echo
"$BIN_DIR/ggpu" || true
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "The commands are on PATH in new shells; run 'source ~/.bashrc' to use them in this shell."
fi
