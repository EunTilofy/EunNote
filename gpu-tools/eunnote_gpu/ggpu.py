#!/usr/bin/env python3
"""Show real GPU occupancy, processes, filler state, and recent idle time."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import sys
import time

from .common import read_config
from .track import collect_tracked


def duration_since(value: str | None) -> str:
    if not value:
        return "-"
    try:
        started = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return "-"
    seconds = max(0, int((datetime.now(timezone.utc) - started).total_seconds()))
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    if hours < 48:
        return f"{hours}h{minutes:02d}m"
    days, hours = divmod(hours, 24)
    return f"{days}d{hours:02d}h"


def memory(value: float | int | None) -> str:
    amount = float(value or 0)
    return f"{amount / 1024:.1f}G" if amount >= 1024 else f"{amount:.0f}M"


def shorten(value: str, width: int) -> str:
    if width <= 0 or len(value) <= width:
        return value
    return value[:max(1, width - 1)] + "…"


def render(nodes: list[dict], errors: dict[str, str], wide: bool = False) -> str:
    lines = [f"{'NODE':<16} {'GPU':>3} {'STATE':<6} {'IDLE':>8} {'UTIL':>5} {'MEMORY':>15} {'TEMP':>5} {'FILLER':<6} PROCESS"]
    process_width = 0 if wide else 78
    for node in nodes:
        if not node.get("gpus"):
            lines.append(f"{node['name']:<16}   - {'NO GPU':<6}")
        for gpu in node.get("gpus", []):
            state = "占用" if gpu.get("inUse") else "空闲"
            idle = "-" if gpu.get("inUse") else duration_since(gpu.get("idleSince"))
            processes = []
            for process in gpu.get("processes", []):
                detail = f"{process.get('user', '?')}:{process.get('pid', '?')} {process.get('command', '未知程序')}"
                if process.get("cwd"):
                    detail += f" [{process['cwd']}]"
                processes.append(detail)
            process_text = " | ".join(processes) or "-"
            temperature = "-" if gpu.get("temperatureC") is None else f"{gpu['temperatureC']:.0f}C"
            filler = "RUN" if gpu.get("fillerActive") else "WAIT" if gpu.get("fillerWaiting") else "-"
            lines.append(
                f"{shorten(str(node['name']), 16):<16} {gpu.get('index', 0):>3} {state:<6} {idle:>8} "
                f"{float(gpu.get('utilizationPercent') or 0):>4.0f}% "
                f"{memory(gpu.get('memoryUsedMiB')):>6}/{memory(gpu.get('memoryTotalMiB')):<8} "
                f"{temperature:>5} "
                f"{filler:<6} {shorten(process_text, process_width)}"
            )
    for node, error in errors.items():
        lines.append(f"! {node}: {error}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--watch", nargs="?", const=5.0, type=float, metavar="SECONDS")
    parser.add_argument("--node", action="append", help="only inspect this configured node")
    parser.add_argument("--wide", action="store_true", help="do not truncate process details")
    args = parser.parse_args()
    if args.watch is not None and args.watch < 1:
        parser.error("--watch interval must be at least one second")
    try:
        config = read_config()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2
    selected = set(args.node) if args.node else None
    while True:
        nodes, errors = collect_tracked(config, selected)
        output = json.dumps({"machine": config["machine_name"], "nodes": nodes, "errors": errors}, ensure_ascii=False, indent=2) if args.json else render(nodes, errors, args.wide)
        if args.watch is not None and os.isatty(sys.stdout.fileno()):
            print("\033[2J\033[H", end="")
        print(output, flush=True)
        if args.watch is None:
            return 1 if errors and not nodes else 0
        time.sleep(args.watch)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        sys.stdout.close()
        raise SystemExit(0)
