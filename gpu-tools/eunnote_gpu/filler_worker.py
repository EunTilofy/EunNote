#!/usr/bin/env python3
"""Run one cooperative matrix-multiply filler that yields to real GPU work."""

from __future__ import annotations

import argparse
import ctypes
import fcntl
import math
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass


YIELD = 75
RETRY = 76
STOP = False
FILLER_MARKERS = (
    "eunnote_gpu.filler_worker", "eunnote_gpu/filler_worker.py",
    "eunnote_gpu_filler_", "gpu_filler_", "fill.py --gpu-index",
)


@dataclass(frozen=True)
class Gpu:
    index: int
    uuid: str
    name: str


@dataclass(frozen=True)
class GpuProcess:
    pid: int
    name: str


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpu-index", type=int, required=True)
    parser.add_argument("--rank", type=int, default=0)
    parser.add_argument("--world-size", type=int, default=1)
    parser.add_argument("--memory-gib", type=float, default=1.0)
    parser.add_argument("--check-interval", type=float, default=15.0)
    parser.add_argument("--yield-seconds", type=float, default=300.0)
    parser.add_argument("--error-retry-seconds", type=float, default=60.0)
    parser.add_argument("--batch-matmuls", type=int, default=4)
    parser.add_argument("--heartbeat", type=float, default=300.0)
    parser.add_argument("--duration", type=float, default=0.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.gpu_index < 0:
        parser.error("--gpu-index must be non-negative")
    if not 0.01 <= args.memory_gib <= 64:
        parser.error("--memory-gib must be in [0.01, 64]")
    if min(args.check_interval, args.yield_seconds, args.error_retry_seconds) <= 0:
        parser.error("check/yield/retry intervals must be positive")
    if args.batch_matmuls <= 0:
        parser.error("--batch-matmuls must be positive")
    if args.heartbeat < 0 or args.duration < 0:
        parser.error("--heartbeat and --duration must be non-negative")
    return args


def log(message: str, rank: int, gpu: Gpu) -> None:
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(
        f"[{timestamp} {socket.gethostname()} rank={rank} gpu={gpu.index}] {message}",
        flush=True,
    )


def nvidia_smi(*args: str) -> str:
    return subprocess.run(
        ["nvidia-smi", *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    ).stdout


def gpus() -> list[Gpu]:
    output = nvidia_smi(
        "--query-gpu=index,uuid,name", "--format=csv,noheader,nounits"
    )
    result: list[Gpu] = []
    for line in output.splitlines():
        if line.strip():
            index, uuid, name = (part.strip() for part in line.split(",", 2))
            result.append(Gpu(int(index), uuid, name))
    return sorted(result, key=lambda gpu: gpu.index)


def own_pids() -> set[int]:
    result = {os.getpid()}
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("NSpid:"):
                result.update(int(item) for item in line.split()[1:])
                break
    except (OSError, ValueError):
        pass
    return result


def is_filler_pid(pid: int) -> bool:
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return False
    return any(marker in command for marker in FILLER_MARKERS)


def processes(gpu_uuid: str, excluded: set[int] | None = None) -> list[GpuProcess]:
    output = nvidia_smi(
        "--query-compute-apps=gpu_uuid,pid,process_name",
        "--format=csv,noheader,nounits",
    )
    excluded = excluded or set()
    result: list[GpuProcess] = []
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",", 2)]
        if len(parts) != 3 or parts[0] != gpu_uuid:
            continue
        try:
            pid = int(parts[1])
        except ValueError:
            continue
        if pid not in excluded and not is_filler_pid(pid):
            result.append(GpuProcess(pid, parts[2]))
    return result


def describe(items: list[GpuProcess]) -> str:
    return ", ".join(f"pid={item.pid} ({item.name})" for item in items)


def install_signal_handlers() -> None:
    def request_stop(_signum: int, _frame: object) -> None:
        global STOP
        STOP = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)


def sleep_interruptibly(seconds: float, deadline: float | None = None) -> None:
    end = time.monotonic() + seconds
    if deadline is not None:
        end = min(end, time.monotonic() + max(0.0, deadline - time.time()))
    while not STOP and time.monotonic() < end:
        time.sleep(min(1.0, end - time.monotonic()))


def acquire_lock(gpu: Gpu, rank: int):
    inherited = os.environ.get("GPU_FILLER_LOCK_FD")
    if inherited is not None:
        try:
            lock = os.fdopen(int(inherited), "w", closefd=False)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, ValueError) as error:
            log(f"cannot restore GPU lock: {error}", rank, gpu)
            return None
    else:
        path = Path(f"/tmp/eunnote_gpu_filler_{gpu.uuid.replace('/', '_')}.lock")
        lock = path.open("w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log(f"another filler already owns {path}; not starting", rank, gpu)
            lock.close()
            return None
        os.set_inheritable(lock.fileno(), True)
        os.environ["GPU_FILLER_LOCK_FD"] = str(lock.fileno())

    lock.seek(0)
    lock.truncate()
    lock.write(f"pid={os.getpid()} host={socket.gethostname()} gpu={gpu.index}\n")
    lock.flush()
    return lock


def restart_without_cuda(wait_seconds: float, rank: int, gpu: Gpu, reason: str) -> None:
    """Self-exec releases CUDA but preserves the PID, nohup session, and GPU lock."""
    log(
        f"{reason}; released CUDA context; retry in {wait_seconds:g}s",
        rank,
        gpu,
    )
    environment = os.environ.copy()
    environment["GPU_FILLER_NOT_BEFORE"] = str(time.time() + wait_seconds)
    environment["PYTHONUNBUFFERED"] = "1"
    script = str(Path(__file__).resolve())
    os.execve(sys.executable, [sys.executable, "-u", script, *sys.argv[1:]], environment)


def matrix_shape(memory_gib: float) -> tuple[int, int]:
    dimension = int(math.sqrt(memory_gib * 2**30 / (3 * 4)))
    dimension -= dimension % 16
    byte_count = 3 * dimension * dimension * 4
    return dimension, byte_count


PTX = rb"""
.version 6.0
.target sm_52
.address_size 64

.visible .entry eunnote_spin(
    .param .u64 output
)
{
    .reg .pred %p;
    .reg .b32 %r<5>;
    .reg .b64 %rd<4>;
    .reg .f32 %f<4>;

    ld.param.u64 %rd0, [output];
    mov.u32 %r0, %tid.x;
    mov.u32 %r1, %ctaid.x;
    mad.lo.s32 %r2, %r1, 256, %r0;
    cvt.u64.u32 %rd1, %r2;
    mul.lo.u64 %rd2, %rd1, 4;
    add.u64 %rd3, %rd0, %rd2;
    ld.global.f32 %f0, [%rd3];
    mov.f32 %f1, 0f3F800001;
    mov.f32 %f2, 0f3DCCCCCD;
    mov.u32 %r3, 0;
loop:
    fma.rn.f32 %f0, %f0, %f1, %f2;
    add.u32 %r3, %r3, 1;
    setp.lt.u32 %p, %r3, 1000000;
    @%p bra loop;
    st.global.f32 [%rd3], %f0;
    ret;
}
"""


class CudaDriver:
    def __init__(self) -> None:
        self.library = ctypes.CDLL("libcuda.so.1")
        self.error_name = self._function("cuGetErrorName")
        self.error_name.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
        self.init = self._function("cuInit")
        self.init.argtypes = [ctypes.c_uint]
        self.device_get = self._function("cuDeviceGet")
        self.device_get.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_int]
        self.context_create = self._function("cuCtxCreate_v2", "cuCtxCreate")
        self.context_create.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint, ctypes.c_int]
        self.context_destroy = self._function("cuCtxDestroy_v2", "cuCtxDestroy")
        self.context_destroy.argtypes = [ctypes.c_void_p]
        self.memory_allocate = self._function("cuMemAlloc_v2", "cuMemAlloc")
        self.memory_allocate.argtypes = [ctypes.POINTER(ctypes.c_uint64), ctypes.c_size_t]
        self.memory_free = self._function("cuMemFree_v2", "cuMemFree")
        self.memory_free.argtypes = [ctypes.c_uint64]
        self.module_load = self._function("cuModuleLoadData")
        self.module_load.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        self.module_unload = self._function("cuModuleUnload")
        self.module_unload.argtypes = [ctypes.c_void_p]
        self.module_get_function = self._function("cuModuleGetFunction")
        self.module_get_function.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_char_p]
        self.launch = self._function("cuLaunchKernel")
        self.launch.argtypes = [
            ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
            ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ]
        self.synchronize = self._function("cuCtxSynchronize")

    def _function(self, *names: str):
        for name in names:
            try:
                function = getattr(self.library, name)
                function.restype = ctypes.c_int
                return function
            except AttributeError:
                pass
        raise RuntimeError(f"CUDA driver does not provide {' or '.join(names)}")

    def check(self, result: int, operation: str) -> None:
        if result == 0:
            return
        name = ctypes.c_char_p()
        self.error_name(result, ctypes.byref(name))
        description = name.value.decode("ascii", "replace") if name.value else f"error {result}"
        raise RuntimeError(f"{operation}: {description}")


def native_cuda_fill(gpu: Gpu, args: argparse.Namespace, deadline: float | None) -> int:
    """Dependency-free CUDA driver filler for hosts without PyTorch."""
    excluded = own_pids()
    competing = processes(gpu.uuid, excluded)
    if competing:
        log(f"competitor appeared before CUDA init: {describe(competing)}", args.rank, gpu)
        return YIELD

    driver = CudaDriver()
    device = ctypes.c_int()
    context = ctypes.c_void_p()
    module = ctypes.c_void_p()
    function = ctypes.c_void_p()
    allocation = ctypes.c_uint64()
    context_ready = module_ready = memory_ready = False
    try:
        driver.check(driver.init(0), "cuInit")
        driver.check(driver.device_get(ctypes.byref(device), 0), "cuDeviceGet")
        driver.check(driver.context_create(ctypes.byref(context), 0, device), "cuCtxCreate")
        context_ready = True

        competing = processes(gpu.uuid, excluded)
        if competing:
            log(f"competitor appeared during CUDA init: {describe(competing)}", args.rank, gpu)
            return YIELD

        byte_count = max(4 * 1024 * 1024, int(args.memory_gib * 2**30))
        driver.check(driver.memory_allocate(ctypes.byref(allocation), byte_count), "cuMemAlloc")
        memory_ready = True
        ptx_buffer = ctypes.create_string_buffer(PTX)
        driver.check(driver.module_load(ctypes.byref(module), ctypes.cast(ptx_buffer, ctypes.c_void_p)), "cuModuleLoadData")
        module_ready = True
        driver.check(driver.module_get_function(ctypes.byref(function), module, b"eunnote_spin"), "cuModuleGetFunction")
        buffer_argument = ctypes.c_uint64(allocation.value)
        parameters = (ctypes.c_void_p * 1)(ctypes.cast(ctypes.byref(buffer_argument), ctypes.c_void_p))
        log(
            f"active native CUDA filler memory={byte_count / 2**30:.3f}GiB "
            f"check_interval={args.check_interval:g}s",
            args.rank, gpu,
        )
        started = time.monotonic()
        next_check = started + args.check_interval
        next_heartbeat = started + args.heartbeat if args.heartbeat else float("inf")
        launches = 0
        while not STOP and (deadline is None or time.time() < deadline):
            for _ in range(args.batch_matmuls):
                driver.check(driver.launch(function, 4096, 1, 1, 256, 1, 1, 0, None, parameters, None), "cuLaunchKernel")
                launches += 1
            driver.check(driver.synchronize(), "cuCtxSynchronize")
            now = time.monotonic()
            if now >= next_check:
                competing = processes(gpu.uuid, excluded)
                if competing:
                    log(f"competitor detected: {describe(competing)}", args.rank, gpu)
                    return YIELD
                next_check = now + args.check_interval
            if now >= next_heartbeat:
                log(f"alive native_launches={launches}", args.rank, gpu)
                next_heartbeat = now + args.heartbeat
        return 0
    finally:
        if module_ready:
            driver.module_unload(module)
        if memory_ready:
            driver.memory_free(allocation)
        if context_ready:
            driver.context_destroy(context)


def matmul(gpu: Gpu, args: argparse.Namespace, deadline: float | None) -> int:
    os.environ["CUDA_VISIBLE_DEVICES"] = gpu.uuid
    excluded = own_pids()
    try:
        competing = processes(gpu.uuid, excluded)
        if competing:
            log(f"competitor appeared before CUDA init: {describe(competing)}", args.rank, gpu)
            return YIELD

        try:
            import torch
        except ImportError:
            log("PyTorch unavailable; using native CUDA driver filler", args.rank, gpu)
            return native_cuda_fill(gpu, args, deadline)

        if not torch.cuda.is_available():
            log("PyTorch CUDA unavailable; using native CUDA driver filler", args.rank, gpu)
            return native_cuda_fill(gpu, args, deadline)
        torch.cuda.set_device(0)
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.set_float32_matmul_precision("high")
        torch.cuda.init()

        competing = processes(gpu.uuid, excluded)
        if competing:
            log(f"competitor appeared during CUDA init: {describe(competing)}", args.rank, gpu)
            return YIELD

        dimension, byte_count = matrix_shape(args.memory_gib)
        left = torch.empty((dimension, dimension), dtype=torch.float32, device="cuda:0")
        right = torch.empty_like(left)
        output = torch.empty_like(left)
        left.uniform_(-0.01, 0.01)
        right.uniform_(-0.01, 0.01)
        torch.cuda.synchronize()
        log(
            f"active matrices={dimension}x{dimension}x3 "
            f"tensor_memory={byte_count / 2**30:.3f}GiB "
            f"check_interval={args.check_interval:g}s",
            args.rank,
            gpu,
        )

        started = time.monotonic()
        next_check = started + args.check_interval
        next_heartbeat = started + args.heartbeat if args.heartbeat else float("inf")
        iterations = 0
        with torch.inference_mode():
            while not STOP and (deadline is None or time.time() < deadline):
                for _ in range(args.batch_matmuls):
                    torch.mm(left, right, out=output)
                    iterations += 1
                torch.cuda.synchronize()
                now = time.monotonic()
                if now >= next_check:
                    competing = processes(gpu.uuid, excluded)
                    if competing:
                        log(f"competitor detected: {describe(competing)}", args.rank, gpu)
                        return YIELD
                    next_check = now + args.check_interval
                if now >= next_heartbeat:
                    elapsed = now - started
                    tflops = iterations * 2 * dimension**3 / elapsed / 1e12
                    log(f"alive iterations={iterations} avg={tflops:.1f}TFLOP/s", args.rank, gpu)
                    next_heartbeat = now + args.heartbeat
        return 0
    except (OSError, subprocess.SubprocessError) as error:
        log(f"GPU monitoring failed: {error}", args.rank, gpu)
        return RETRY
    except Exception as error:
        if "out of memory" in str(error).lower():
            log(f"CUDA OOM; treating GPU as busy: {error}", args.rank, gpu)
            return YIELD
        log(f"worker failed: {type(error).__name__}: {error}", args.rank, gpu)
        return RETRY


def main() -> int:
    args = arguments()
    inventory = gpus()
    gpu = next((item for item in inventory if item.index == args.gpu_index), None)
    if gpu is None:
        raise RuntimeError(
            f"GPU index {args.gpu_index} is invalid; nvidia-smi reported {len(inventory)} GPUs"
        )

    if args.dry_run:
        competing = processes(gpu.uuid)
        state = describe(competing) if competing else "idle"
        log(f"dry-run rank={args.rank}/{args.world_size} {gpu.uuid} {gpu.name!r} {state}", args.rank, gpu)
        return 0

    install_signal_handlers()
    lock = acquire_lock(gpu, args.rank)
    if lock is None:
        return 2

    started_at = float(os.environ.setdefault("GPU_FILLER_STARTED_AT", str(time.time())))
    deadline = started_at + args.duration if args.duration else None
    not_before = float(os.environ.pop("GPU_FILLER_NOT_BEFORE", "0"))
    if not_before > time.time():
        log(f"waiting {not_before - time.time():.0f}s before next attempt", args.rank, gpu)
        sleep_interruptibly(not_before - time.time(), deadline)

    while not STOP and (deadline is None or time.time() < deadline):
        try:
            competing = processes(gpu.uuid)
        except (OSError, subprocess.SubprocessError) as error:
            log(f"GPU monitoring failed; retry in {args.error_retry_seconds:g}s: {error}", args.rank, gpu)
            sleep_interruptibly(args.error_retry_seconds, deadline)
            continue

        if competing:
            log(f"GPU busy ({describe(competing)}); retry in {args.yield_seconds:g}s", args.rank, gpu)
            sleep_interruptibly(args.yield_seconds, deadline)
            continue

        outcome = matmul(gpu, args, deadline)
        if outcome == YIELD:
            restart_without_cuda(args.yield_seconds, args.rank, gpu, "competitor detected")
        if outcome == RETRY:
            restart_without_cuda(args.error_retry_seconds, args.rank, gpu, "worker/monitor error")
        break

    lock.close()
    log("stopped", args.rank, gpu)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
