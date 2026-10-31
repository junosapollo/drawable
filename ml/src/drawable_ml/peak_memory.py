"""Portable peak resident-memory measurement for the current process."""

from __future__ import annotations

import math
import sys
from importlib import import_module
from typing import Any

from .io import MLError

MIB = 1024 * 1024


def _windows_peak_rss_bytes() -> int:
    """Read PROCESS_MEMORY_COUNTERS.PeakWorkingSetSize through the Windows API."""
    import ctypes
    from ctypes import wintypes

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    get_current_process = kernel32.GetCurrentProcess
    get_current_process.argtypes = []
    get_current_process.restype = wintypes.HANDLE
    get_process_memory_info = psapi.GetProcessMemoryInfo
    get_process_memory_info.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(ProcessMemoryCounters),
        wintypes.DWORD,
    ]
    get_process_memory_info.restype = wintypes.BOOL

    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    succeeded = get_process_memory_info(
        get_current_process(), ctypes.byref(counters), counters.cb
    )
    if not succeeded:
        error = ctypes.get_last_error()
        raise MLError(f"Windows could not read process peak memory (error {error})")
    return int(counters.PeakWorkingSetSize)


def _resource_peak_rss_mib(platform: str) -> float:
    try:
        resource: Any = import_module("resource")
        usage = resource.getrusage(resource.RUSAGE_SELF)
        peak = float(usage.ru_maxrss)
    except (ImportError, AttributeError, OSError, OverflowError, TypeError, ValueError) as error:
        raise MLError(f"Could not read process peak memory on {platform}") from error

    # Linux and other BSD-style systems report KiB; Darwin reports bytes.
    return peak / MIB if platform.casefold() in {"darwin", "macos"} else peak / 1024


def peak_rss_mib() -> float:
    """Return this process's lifetime peak resident set size in MiB."""
    if sys.platform == "win32":
        try:
            value = float(_windows_peak_rss_bytes()) / MIB
        except MLError:
            raise
        except (AttributeError, OSError, OverflowError, TypeError, ValueError) as error:
            raise MLError("Could not read process peak memory on Windows") from error
    elif sys.platform.startswith("linux"):
        value = _resource_peak_rss_mib("Linux")
    elif sys.platform == "darwin":
        value = _resource_peak_rss_mib("macOS")
    else:
        raise MLError(f"Peak-memory measurement is not supported on {sys.platform}")

    if not math.isfinite(value) or value <= 0:
        raise MLError("The operating system returned an invalid process peak-memory value")
    return value
