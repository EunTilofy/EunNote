#!/usr/bin/env python3
"""Start, stop, and inspect cooperative EunNote GPU filler workers."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import shlex
import subprocess
import sys

from .common import is_local_node, read_config, state_dir
from .ggpu import render
from .track import collect_tracked


WORKER = Path(__file__).with_name("filler_worker.py")


def shell(node: str, script: str, timeout: int = 40) -> subprocess.CompletedProcess[str]:
    if is_local_node(node):
        return subprocess.run(["bash", "-s"], input=script, capture_output=True, text=True, timeout=timeout)
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "LogLevel=ERROR", node, "bash", "-s"],
        input=script, capture_output=True, text=True, timeout=timeout,
    )


def safe_name(node: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", node)


def stage_worker(node: str) -> str:
    if is_local_node(node):
        return str(WORKER)
    digest = hashlib.sha256(WORKER.read_bytes()).hexdigest()[:16]
    relative = f".local/share/eunnote-gpu/filler-worker-{digest}.py"
    prepared = shell(node, "mkdir -p \"$HOME/.local/share/eunnote-gpu\"\n")
    if prepared.returncode:
        raise RuntimeError(prepared.stderr.strip() or "cannot create remote worker directory")
    copied = subprocess.run(
        ["scp", "-q", "-p", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", str(WORKER), f"{node}:{relative}"],
        capture_output=True, text=True, timeout=30,
    )
    if copied.returncode:
        raise RuntimeError(copied.stderr.strip() or "cannot stage filler worker")
    return f"$HOME/{relative}"


def selected_hosts(config: dict, requested: list[str] | None) -> list[str]:
    hosts = [str(item) for item in config["hosts"]]
    if not requested:
        return hosts
    unknown = [item for item in requested if item not in hosts]
    if unknown:
        raise RuntimeError(f"unknown configured node(s): {', '.join(unknown)}")
    return requested


def gpu_indexes(node: dict, value: str) -> list[int]:
    available = [int(gpu["index"]) for gpu in node.get("gpus", [])]
    if value == "all":
        return available
    try:
        requested = list(dict.fromkeys(int(item.strip()) for item in value.split(",") if item.strip()))
    except ValueError as error:
        raise RuntimeError("--gpus must be 'all' or comma-separated indexes") from error
    missing = [index for index in requested if index not in available]
    if missing:
        raise RuntimeError(f"{node['name']} does not have GPU index(es): {missing}")
    return requested


def worker_arguments(args: argparse.Namespace, gpu: int, rank: int, world_size: int) -> list[str]:
    values = [
        "--gpu-index", str(gpu), "--rank", str(rank), "--world-size", str(world_size),
        "--memory-gib", str(args.memory_gib), "--check-interval", str(args.check_interval),
        "--yield-seconds", str(args.yield_seconds), "--error-retry-seconds", str(args.error_retry_seconds),
        "--batch-matmuls", str(args.batch_matmuls), "--heartbeat", str(args.heartbeat),
        "--duration", str(args.duration),
    ]
    if args.dry_run:
        values.append("--dry-run")
    return values


def start(config: dict, args: argparse.Namespace) -> int:
    hosts = selected_hosts(config, args.node)
    nodes, errors = collect_tracked(config, set(hosts))
    if errors:
        for node, message in errors.items():
            print(f"{node}: GPU detection failed: {message}", file=sys.stderr)
    inventory = [(node, gpu) for node in nodes for gpu in gpu_indexes(node, args.gpus)]
    if not inventory:
        print("no GPUs found", file=sys.stderr)
        return 1
    worker_python = str(config.get("worker_python", config.get("remote_python", "python3")))
    started = skipped = failed = 0
    staged: dict[str, str] = {}
    for rank, (node, gpu) in enumerate(inventory):
        host = str(node["name"])
        try:
            if host not in staged:
                staged[host] = stage_worker(host)
            worker = staged[host]
            command = [worker_python, "-u", worker, *worker_arguments(args, gpu, rank, len(inventory))]
            quoted = " ".join("$HOME/" + shlex.quote(part[6:]) if part.startswith("$HOME/") else shlex.quote(part) for part in command)
            node_state = safe_name(host)
            script = f'''set -eu
state_dir="$HOME/.local/state/eunnote-gpu/filler/{node_state}"
mkdir -p "$state_dir"
pid_file="$state_dir/gpu{gpu}.pid"
log_file="$state_dir/gpu{gpu}.log"
if [ -r "$pid_file" ]; then
  old_pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    old_command=$(tr '\\0' ' ' <"/proc/$old_pid/cmdline" 2>/dev/null || true)
    case "$old_command" in *filler_worker*"--gpu-index {gpu}"*) echo "SKIPPED pid=$old_pid log=$log_file"; exit 0;; esac
  fi
fi
'''
            if args.dry_run:
                script += f"{quoted}\n"
            else:
                script += f'''nohup {quoted} >>"$log_file" 2>&1 </dev/null &
new_pid=$!
printf '%s\n' "$new_pid" >"$pid_file"
sleep 1
if kill -0 "$new_pid" 2>/dev/null; then
  echo "STARTED pid=$new_pid log=$log_file"
else
  echo "FAILED pid=$new_pid log=$log_file"
  tail -n 12 "$log_file" >&2 || true
  exit 1
fi
'''
            result = shell(host, script, timeout=50)
            output = result.stdout.strip()
            if result.returncode:
                failed += 1
                print(f"{host} GPU {gpu}: FAILED\n{result.stderr.strip()}", file=sys.stderr)
            elif output.startswith("SKIPPED"):
                skipped += 1
                print(f"{host} GPU {gpu}: {output}")
            else:
                started += 1
                print(f"{host} GPU {gpu}: {output or 'OK'}")
        except Exception as error:
            failed += 1
            print(f"{host} GPU {gpu}: FAILED: {error}", file=sys.stderr)
    label = "checked" if args.dry_run else "started"
    print(f"filler start complete: {label}={started} existing={skipped} failed={failed} total={len(inventory)}")
    return 1 if failed else 0


def stop(config: dict, args: argparse.Namespace) -> int:
    hosts = selected_hosts(config, args.node)
    failed = 0
    for host in hosts:
        node_state = safe_name(host)
        indexes = args.gpus
        script = f'''set -eu
state_dir="$HOME/.local/state/eunnote-gpu/filler/{node_state}"
[ -d "$state_dir" ] || {{ echo "no filler state"; exit 0; }}
for pid_file in "$state_dir"/gpu*.pid; do
  [ -e "$pid_file" ] || continue
  gpu=${{pid_file##*gpu}}; gpu=${{gpu%.pid}}
  case ",{indexes}," in *,all,*|*,"$gpu",*) ;; *) continue;; esac
  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    command=$(tr '\\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    case "$command" in *filler_worker*"--gpu-index $gpu"*) kill -TERM "$pid"; echo "STOPPED GPU $gpu pid=$pid";; *) echo "IGNORED GPU $gpu stale pid=$pid";; esac
  else
    echo "INACTIVE GPU $gpu"
  fi
  rm -f "$pid_file"
done
'''
        result = shell(host, script)
        if result.returncode:
            failed += 1
            print(f"{host}: {result.stderr.strip()}", file=sys.stderr)
        else:
            for line in result.stdout.splitlines() or ["no active fillers"]:
                print(f"{host}: {line}")
    return 1 if failed else 0


def status(config: dict, args: argparse.Namespace) -> int:
    hosts = selected_hosts(config, args.node)
    nodes, errors = collect_tracked(config, set(hosts))
    print(render(nodes, errors, args.wide))
    return 1 if errors and not nodes else 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    actions = root.add_subparsers(dest="action", required=True)
    start_parser = actions.add_parser("start", help="start fillers (default action)")
    start_parser.add_argument("--node", action="append")
    start_parser.add_argument("--gpus", default="all")
    start_parser.add_argument("--memory-gib", type=float, default=1.0)
    start_parser.add_argument("--check-interval", type=float, default=15)
    start_parser.add_argument("--yield-seconds", type=float, default=300)
    start_parser.add_argument("--error-retry-seconds", type=float, default=60)
    start_parser.add_argument("--batch-matmuls", type=int, default=4)
    start_parser.add_argument("--heartbeat", type=float, default=300)
    start_parser.add_argument("--duration", type=float, default=0)
    start_parser.add_argument("--dry-run", action="store_true")
    stop_parser = actions.add_parser("stop", help="stop fillers")
    stop_parser.add_argument("--node", action="append")
    stop_parser.add_argument("--gpus", default="all")
    status_parser = actions.add_parser("status", help="show GPU and filler state")
    status_parser.add_argument("--node", action="append")
    status_parser.add_argument("--wide", action="store_true")
    return root


def main() -> int:
    arguments = sys.argv[1:]
    if not arguments or arguments[0] not in {"start", "stop", "status", "-h", "--help"}:
        arguments.insert(0, "start")
    args = parser().parse_args(arguments)
    try:
        config = read_config()
        if args.action == "start":
            return start(config, args)
        if args.action == "stop":
            return stop(config, args)
        return status(config, args)
    except (RuntimeError, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
