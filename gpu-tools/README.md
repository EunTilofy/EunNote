# EunNote GPU tools

This directory packages a cooperative GPU filler and a precise GPU tracker for
the GPU monitor above the Note wall. It keeps the useful behavior from the ICLR
`scripts/fill.py`, `fill.sh`, and `gpu.sh` tools while adding persistent idle
tracking, Note reporting, multi-environment node discovery, and user-level
installation.

## Install

Run on the controller/login node of each machine or cluster:

```bash
./install.sh
```

The installer asks for:

1. The machine name shown in Note.
2. The EunNote URL. A base URL such as `http://123.59.6.243:6357` is accepted;
   the installer adds `/notion/api/gpu/report`.
3. The private GPU report token from the EunNote server's
   `clipboard/data/gpu-monitor-token` file.

It discovers nodes from `EUNNOTE_GPU_HOSTS`, `GPU_TRACK_HOSTS`, `HOSTFILE`, the
usual hostfile locations, Slurm, Azure Batch/AzureML variables, or the local
hostname. It then installs everything under `~/.local`, enables a user systemd
timer, and sends the first report. Configuration is stored with mode `0600` in
`~/.config/eunnote-gpu/config.json`.

The default timer also runs each calendar minute, so reporting resumes after a
reboot even when an earlier timer trigger was missed. Custom intervals run after
each report finishes, with a startup trigger to resume reporting.

For unattended installation, keep the token off the command line:

```bash
cat /secure/path/gpu-monitor-token | ./install.sh \
  --machine-name my-cluster \
  --report-url http://123.59.6.243:6357 \
  --token-stdin
```

## Commands

```bash
# Show every node and GPU, real process, working directory, idle time, and filler state
ggpu
ggpu --watch 3
ggpu --wide

# Start one cooperative filler per GPU on all discovered nodes
gpu-filler
gpu-filler start --gpus 0,1 --memory-gib 1 --duration 3600

# Inspect or stop filler workers
gpu-filler status
gpu-filler stop
gpu-filler stop --gpus 0,1

# Force one immediate report
gpu-track --once --print
```

The filler checks NVIDIA compute processes before CUDA initialization and while
running. When a real workload appears, it releases its CUDA context and waits
before retrying. Per-GPU locks prevent duplicate fillers. Filler processes are
removed from the reported process list and do not mark a GPU as occupied; the
raw utilization and memory measurements remain visible, and `ggpu` shows
filler state in its own column (`WAIT` while yielding, `RUN` while active).

PyTorch is used for the original matrix-multiply workload when available. On a
machine without PyTorch, the same command automatically uses a dependency-free
NVIDIA Driver API kernel, so installing a large Python package is unnecessary.

Idle time means time since the last non-filler workload disappeared. The value
survives tracker restarts in `~/.local/state/eunnote-gpu/idle.json`.

Process reporting uses NVIDIA's compute-app query plus `/proc` to include the
user, PID, full command, working directory, and per-process GPU memory whenever
permissions allow. Common password, token, secret, and API-key arguments are
redacted before reporting.
