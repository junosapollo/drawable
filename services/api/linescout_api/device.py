"""CUDA/CPU detection.

Torch is an optional dependency until Milestone 4, so this module must work
when it is not installed. It reports enough for the health endpoint and for
the "CPU fallback — slower search" notice in the UI.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
from dataclasses import dataclass

from linescout_api.config import DevicePolicy

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class DeviceInfo:
    kind: str  # "cuda" | "cpu"
    cuda_available: bool
    torch_installed: bool
    torch_version: str | None
    gpu_name: str | None
    vram_total_mb: int | None
    warning: str | None

    @property
    def is_cuda(self) -> bool:
        return self.kind == "cuda"


def detect_device(policy: DevicePolicy = DevicePolicy.AUTO) -> DeviceInfo:
    torch_spec = importlib.util.find_spec("torch")
    if torch_spec is None:
        warning = (
            None if policy is DevicePolicy.CPU else "PyTorch is not installed; running CPU fallback"
        )
        if policy is DevicePolicy.CUDA:
            warning = "LINESCOUT_DEVICE=cuda but PyTorch is not installed"
        return DeviceInfo("cpu", False, False, None, None, None, warning)

    torch = importlib.import_module("torch")
    torch_version = str(getattr(torch, "__version__", "unknown"))
    cuda_available = bool(torch.cuda.is_available())

    if policy is DevicePolicy.CPU:
        return DeviceInfo("cpu", cuda_available, True, torch_version, None, None, None)

    if not cuda_available:
        warning = (
            "LINESCOUT_DEVICE=cuda but CUDA is unavailable"
            if policy is DevicePolicy.CUDA
            else "CUDA unavailable; running CPU fallback — slower search"
        )
        return DeviceInfo("cpu", False, True, torch_version, None, None, warning)

    try:
        index = torch.cuda.current_device()
        props = torch.cuda.get_device_properties(index)
        gpu_name = str(props.name)
        vram_total_mb = int(props.total_memory // (1024 * 1024))
    except Exception as error:  # pragma: no cover - depends on driver state
        log.warning("CUDA reported available but device query failed: %s", error)
        return DeviceInfo(
            "cpu", False, True, torch_version, None, None, f"CUDA device query failed: {error}"
        )

    return DeviceInfo("cuda", True, True, torch_version, gpu_name, vram_total_mb, None)
