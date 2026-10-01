#!/usr/bin/env python3
"""Collect precise NVIDIA GPU and process information on one node."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import socket
import subprocess
import sys
from typing import Sequence


GPU_FIELDS = (
    "index", "uuid", "name", "utilization.gpu", "memory.used", "memory.total",
    "temperature.gpu", "power.draw", "power.limit",
)
SENSITIVE_OPTION = re.compile(
    r"(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|authorization)$",
    re.IGNORECASE,
)
FILLER_MARKERS = (
    "eunnote_gpu.filler_worker", "eunnote_gpu/filler_worker.py",
    "eunnote_gpu_filler_", "gpu_filler_", "fill.py --gpu-index",
)


def run_nvidia_smi(*arguments: str) -> str:
    return subprocess.run(
        ["nvidia-smi", *arguments], check=True, capture_output=True,
        text=True, timeout=20,
    ).stdout


def rows(output: str) -> list[list[str]]:
    return [[part.strip() for part in row] for row in csv.reader(output.splitlines()) if row]


def number(value: str, default: float | None = None) -> float | None:
    cleaned = value.strip()
    if not cleaned or cleaned.lower() in {"n/a", "[not supported]", "not supported"}:
        return default
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    return float(match.group()) if match else default


def integer(value: str, default: int = 0) -> int:
    parsed = number(value)
    return int(parsed) if parsed is not None else default


def redact_arguments(arguments: Sequence[str]) -> list[str]:
    result: list[str] = []
    hide_next = False
    for argument in arguments:
        if hide_next:
            result.append("<redacted>")
            hide_next = False
            continue
        if "=" in argument:
            key, value = argument.split("=", 1)
            if SENSITIVE_OPTION.search(key.lstrip("-")):
                result.append(f"{key}=<redacted>")
                continue
        if SENSITIVE_OPTION.search(argument.lstrip("-")):
            result.append(argument)
            hide_next = True
            continue
        if argument.lower().startswith("bearer "):
            result.append("Bearer <redacted>")
            continue
        result.append(argument)
    return result


def proc_arguments(pid: int) -> list[str]:
    try:
        content = Path(f"/proc/{pid}/cmdline").read_bytes()
        return [part.decode("utf-8", "replace") for part in content.split(b"\0") if part]
    except OSError:
        return []


def proc_user(pid: int) -> str:
    try:
        return pwd.getpwuid(os.stat(f"/proc/{pid}").st_uid).pw_name
    except (KeyError, OSError):
        return "未知"


def proc_cwd(pid: int) -> str:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return ""


def is_filler_command(arguments: Sequence[str] | str) -> bool:
    text = arguments if isinstance(arguments, str) else " ".join(arguments)
    return any(marker in text for marker in FILLER_MARKERS)


def filler_worker_indexes() -> set[int]:
    result: set[int] = set()
    try:
        entries = Path("/proc").iterdir()
    except OSError:
        return result
    for entry in entries:
        if not entry.name.isdigit():
            continue
        arguments = proc_arguments(int(entry.name))
        if not arguments or not is_filler_command(arguments):
            continue
        command = " ".join(arguments)
        match = re.search(r"(?:^|\s)--gpu-index(?:=|\s+)(\d+)(?:\s|$)", command)
        if match:
            result.add(int(match.group(1)))
    return result


def command_label(arguments: Sequence[str], fallback: str) -> str:
    if not arguments:
        return fallback or "未知程序"
    redacted = redact_arguments(arguments)
    label = shlex.join(redacted)
    if len(label) <= 240:
        return label
    return f"{label[:236]} ..."


def collect_processes() -> dict[str, list[dict]]:
    try:
        output = run_nvidia_smi(
            "--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory",
            "--format=csv,noheader,nounits",
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    result: dict[str, list[dict]] = {}
    for row in rows(output):
        if len(row) < 4:
            continue
        uuid, raw_pid, executable, raw_memory = row[:4]
        try:
            pid = int(raw_pid)
        except ValueError:
            continue
        arguments = proc_arguments(pid)
        item = {
            "pid": pid,
            "user": proc_user(pid),
            "command": command_label(arguments, executable),
            "cwd": proc_cwd(pid),
            "memoryUsedMiB": number(raw_memory),
            "filler": is_filler_command(arguments),
        }
        result.setdefault(uuid, []).append(item)
    return result


def collect_node(idle_memory_threshold_mib: float = 256) -> dict:
    processes_by_uuid = collect_processes()
    filler_indexes = filler_worker_indexes()
    output = run_nvidia_smi(
        f"--query-gpu={','.join(GPU_FIELDS)}", "--format=csv,noheader,nounits"
    )
    gpus: list[dict] = []
    for row in rows(output):
        if len(row) < len(GPU_FIELDS):
            continue
        index, uuid, name, utilization, used, total, temperature, power, power_limit = row[:len(GPU_FIELDS)]
        all_processes = processes_by_uuid.get(uuid, [])
        filler_processes: list[dict] = []
        real_processes: list[dict] = []
        for item in all_processes:
            (filler_processes if item.pop("filler", False) else real_processes).append(item)
        filler_memory = sum(item.get("memoryUsedMiB") or 0 for item in filler_processes)
        memory_used = number(used, 0) or 0
        effective_memory = max(0, memory_used - filler_memory)
        in_use = bool(real_processes) or effective_memory > idle_memory_threshold_mib
        for item in filler_processes:
            item.pop("cwd", None)
        gpus.append({
            "index": integer(index),
            "uuid": uuid,
            "name": name,
            "inUse": in_use,
            "utilizationPercent": number(utilization, 0) or 0,
            "memoryUsedMiB": memory_used,
            "memoryTotalMiB": number(total, 0) or 0,
            "temperatureC": number(temperature),
            "powerDrawW": number(power),
            "powerLimitW": number(power_limit),
            "fillerActive": bool(filler_processes),
            "fillerWaiting": integer(index) in filler_indexes and not filler_processes,
            "fillerMemoryUsedMiB": round(filler_memory, 1),
            "processes": real_processes,
        })
    return {"name": socket.gethostname(), "gpus": sorted(gpus, key=lambda gpu: gpu["index"])}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--idle-memory-threshold-mib", type=float, default=256)
    args = parser.parse_args()
    try:
        value = collect_node(args.idle_memory_threshold_mib)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"GPU collection failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False) if args.json else json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
