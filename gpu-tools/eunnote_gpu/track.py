#!/usr/bin/env python3
"""Collect a cluster GPU snapshot, track idle time, and report to EunNote."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .collector import collect_node
from .common import atomic_write_json, is_local_node, read_config, state_dir


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _remote_collect(node: str, threshold: float, remote_python: str) -> dict:
    source = Path(__file__).with_name("collector.py").read_text(encoding="utf-8")
    result = subprocess.run(
        [
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=10", "-o", "LogLevel=ERROR", node,
            remote_python, "-", "--json", "--idle-memory-threshold-mib", str(threshold),
        ],
        input=source, capture_output=True, text=True, timeout=40,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"ssh exited {result.returncode}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid collector output: {result.stdout[:160]!r}") from error


def collect_one(node: str, config: dict) -> dict:
    threshold = float(config.get("idle_memory_threshold_mib", 256))
    if is_local_node(node):
        result = collect_node(threshold)
    else:
        result = _remote_collect(node, threshold, str(config.get("remote_python", "python3")))
    result["name"] = node
    return result


def collect_cluster(config: dict, selected_nodes: set[str] | None = None) -> tuple[list[dict], dict[str, str]]:
    hosts = [str(host) for host in config["hosts"] if not selected_nodes or str(host) in selected_nodes]
    nodes: dict[str, dict] = {}
    errors: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(16, max(1, len(hosts)))) as executor:
        pending = {executor.submit(collect_one, host, config): host for host in hosts}
        for future in as_completed(pending):
            host = pending[future]
            try:
                nodes[host] = future.result()
            except Exception as error:  # Each failed node should not suppress healthy nodes.
                errors[host] = str(error)
    return [nodes[host] for host in hosts if host in nodes], errors


def idle_state_path() -> Path:
    return state_dir() / "idle.json"


def load_idle_state() -> dict:
    try:
        value = json.loads(idle_state_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def apply_idle_tracking(nodes: list[dict], state: dict, now: str | None = None) -> dict:
    timestamp = now or utc_now()
    seen: set[str] = set()
    for node in nodes:
        for gpu in node.get("gpus", []):
            identity = str(gpu.get("uuid") or gpu.get("index"))
            key = f"{node['name']}\0{identity}"
            seen.add(key)
            previous = state.get(key) if isinstance(state.get(key), dict) else {}
            if gpu.get("inUse"):
                idle_since = None
            else:
                idle_since = previous.get("idleSince") or timestamp
            gpu["idleSince"] = idle_since
            state[key] = {"idleSince": idle_since, "lastSeenAt": timestamp}

    cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400
    for key in list(state):
        if key in seen or not isinstance(state.get(key), dict):
            continue
        try:
            last_seen = datetime.fromisoformat(str(state[key]["lastSeenAt"]).replace("Z", "+00:00")).timestamp()
        except (KeyError, TypeError, ValueError):
            last_seen = 0
        if last_seen < cutoff:
            state.pop(key, None)
    return state


def collect_tracked(config: dict, selected_nodes: set[str] | None = None) -> tuple[list[dict], dict[str, str]]:
    nodes, errors = collect_cluster(config, selected_nodes)
    state = load_idle_state()
    apply_idle_tracking(nodes, state)
    atomic_write_json(idle_state_path(), state)
    return nodes, errors


def post_report(config: dict, nodes: list[dict]) -> dict:
    payload = json.dumps({"machine": config["machine_name"], "nodes": nodes}, ensure_ascii=False).encode()
    request = Request(
        str(config["report_url"]), data=payload, method="POST",
        headers={
            "Authorization": f"Bearer {config['token']}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "EunNote-GPU-Track/1.0",
        },
    )
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                return json.loads(response.read())
        except HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:500]
            if error.code < 500 or attempt == 2:
                raise RuntimeError(f"report rejected with HTTP {error.code}: {detail}") from error
            last_error = error
        except URLError as error:
            last_error = error
            if attempt == 2:
                raise RuntimeError(f"cannot reach report URL: {error.reason}") from error
        time.sleep(2 ** attempt)
    raise RuntimeError(f"GPU report failed: {last_error}")


def run_once(config: dict, print_json: bool = False) -> int:
    nodes, errors = collect_tracked(config)
    if not nodes:
        print("GPU collection failed on every node", file=sys.stderr)
        for node, message in errors.items():
            print(f"  {node}: {message}", file=sys.stderr)
        return 1
    result = post_report(config, nodes)
    if print_json:
        print(json.dumps({"report": result, "nodeErrors": errors}, ensure_ascii=False, indent=2))
    elif errors:
        print("reported healthy nodes; collection errors: " + "; ".join(f"{node}: {error}" for node, error in errors.items()), file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="report once (default)")
    parser.add_argument("--watch", type=float, metavar="SECONDS", help="report continuously")
    parser.add_argument("--print", dest="print_json", action="store_true", help="print server response")
    args = parser.parse_args()
    try:
        config = read_config()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2
    if not args.watch:
        return run_once(config, args.print_json)
    if args.watch < 10:
        parser.error("--watch interval must be at least 10 seconds")
    while True:
        started = time.monotonic()
        try:
            run_once(config, args.print_json)
        except Exception as error:
            print(f"GPU report failed: {error}", file=sys.stderr)
        time.sleep(max(1, args.watch - (time.monotonic() - started)))


if __name__ == "__main__":
    raise SystemExit(main())
