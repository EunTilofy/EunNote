#!/usr/bin/env python3
"""Write a validated EunNote GPU configuration file."""

from __future__ import annotations

import argparse
import sys

from .common import atomic_write_json, config_path, normalize_report_url


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--machine-name", required=True)
    parser.add_argument("--report-url", required=True)
    parser.add_argument("--hosts", required=True, help="newline-separated nodes")
    parser.add_argument("--remote-python", default="python3")
    parser.add_argument("--worker-python", default="python3")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--token-stdin", action="store_true", required=True)
    args = parser.parse_args()
    machine = args.machine_name.strip()
    hosts = list(dict.fromkeys(host.strip() for host in args.hosts.splitlines() if host.strip()))
    token = sys.stdin.read().strip()
    if not machine or len(machine) > 80:
        parser.error("machine name must contain 1 to 80 characters")
    if not hosts or len(hosts) > 64:
        parser.error("between 1 and 64 nodes are required")
    if not token:
        parser.error("report token cannot be empty")
    if args.interval < 10:
        parser.error("interval must be at least 10 seconds")
    value = {
        "machine_name": machine,
        "report_url": normalize_report_url(args.report_url),
        "token": token,
        "hosts": hosts,
        "remote_python": args.remote_python,
        "worker_python": args.worker_python,
        "interval_seconds": args.interval,
        "idle_memory_threshold_mib": 256,
    }
    target = config_path()
    atomic_write_json(target, value)
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
