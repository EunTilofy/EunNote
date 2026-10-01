#!/usr/bin/env python3
"""Shared configuration and cluster discovery for EunNote GPU tools."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
from typing import Iterable


APP_NAME = "eunnote-gpu"


def config_path() -> Path:
    override = os.environ.get("EUNNOTE_GPU_CONFIG")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / APP_NAME / "config.json"


def state_dir() -> Path:
    override = os.environ.get("EUNNOTE_GPU_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local" / "state" / APP_NAME


def read_config(path: Path | None = None) -> dict:
    target = path or config_path()
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError(f"configuration not found: {target}; run install.sh first") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid configuration: {target}")
    for key in ("machine_name", "report_url", "token", "hosts"):
        if key not in value:
            raise RuntimeError(f"configuration is missing {key!r}: {target}")
    if not isinstance(value["hosts"], list) or not value["hosts"]:
        raise RuntimeError("configuration must contain at least one node")
    return value


def atomic_write_json(path: Path, value: object, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, mode)
    temporary.replace(path)


def _unique(items: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in items:
        item = raw.strip().split()[0] if raw.strip() else ""
        if not item or item.startswith("#") or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def _split_hosts(value: str) -> list[str]:
    normalized = value.replace(";", ",").replace("\n", ",")
    return _unique(normalized.split(","))


def _hostfile_nodes(path: Path) -> list[str]:
    try:
        return _unique(
            line for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
    except (OSError, UnicodeError):
        return []


def discover_nodes() -> tuple[list[str], str]:
    """Return cluster nodes and the source used to discover them."""
    for env_name in ("EUNNOTE_GPU_HOSTS", "GPU_TRACK_HOSTS"):
        nodes = _split_hosts(os.environ.get(env_name, ""))
        if nodes:
            return nodes, env_name

    candidates: list[Path] = []
    if os.environ.get("HOSTFILE"):
        candidates.append(Path(os.environ["HOSTFILE"]).expanduser())
    candidates.extend([
        Path.home() / "hostfile",
        Path("/home/aiscuser/hostfile"),
        Path("/etc/mpi/hostfile"),
    ])
    visited: set[Path] = set()
    for path in candidates:
        if path in visited:
            continue
        visited.add(path)
        nodes = _hostfile_nodes(path)
        if nodes:
            return nodes, str(path)

    slurm_nodes = os.environ.get("SLURM_JOB_NODELIST")
    if slurm_nodes:
        try:
            output = subprocess.run(
                ["scontrol", "show", "hostnames", slurm_nodes], check=True,
                capture_output=True, text=True, timeout=10,
            ).stdout
            nodes = _unique(output.splitlines())
            if nodes:
                return nodes, "SLURM_JOB_NODELIST"
        except (OSError, subprocess.SubprocessError):
            pass

    for env_name in ("AZ_BATCH_HOST_LIST", "AZ_BATCH_NODE_LIST"):
        nodes = _split_hosts(os.environ.get(env_name, ""))
        if nodes:
            return nodes, env_name

    for env_name in ("NODE_COUNT", "AZUREML_NODE_COUNT"):
        raw = os.environ.get(env_name, "")
        if raw.isdigit() and int(raw) > 0:
            return [f"node-{index}" for index in range(int(raw))], env_name

    return [socket.gethostname()], "local hostname"


def is_local_node(node: str) -> bool:
    aliases = {"localhost", "127.0.0.1", "::1", socket.gethostname(), socket.getfqdn()}
    try:
        aliases.update(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None))
    except socket.gaierror:
        pass
    return node in aliases


def normalize_report_url(value: str) -> str:
    result = value.strip().rstrip("/")
    if not result:
        raise ValueError("report URL cannot be empty")
    if result.endswith("/notion/api/gpu/report"):
        return result
    if result.endswith("/notion"):
        return f"{result}/api/gpu/report"
    return f"{result}/notion/api/gpu/report"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--discover", action="store_true", help="print discovered nodes")
    parser.add_argument("--source", action="store_true", help="also print discovery source")
    args = parser.parse_args()
    if args.discover:
        nodes, source = discover_nodes()
        if args.source:
            print(source)
        print("\n".join(nodes))
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
