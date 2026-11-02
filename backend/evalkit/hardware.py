"""Hardware fingerprint stored with every evaluation run (numbers are only comparable on the same device profile)."""
from __future__ import annotations

import os
import platform
import sys

import psutil

from backend.config import get_settings
from backend.schemas.system import HardwareInfo

LATENCY_TARGET_PROFILES = {"latitude-7220", "latitude-7220-rugged"}


def _cpu_name() -> str:
    if sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        except Exception:
            pass
    return platform.processor() or "unknown"


def _os_name() -> str:
    if sys.platform == "win32":
        build = getattr(sys.getwindowsversion(), "build", 0)  # Python < 3.12 still reports Windows 11 as "10"
        return "Windows 11" if build >= 22000 else f"Windows {platform.release()}"
    return platform.system() + " " + platform.release()


def get_hardware_info() -> HardwareInfo:
    s = get_settings()
    cpu = _cpu_name()
    battery = None
    try:
        battery = psutil.sensors_battery() is not None
    except Exception:
        pass
    notes: list[str] = []
    if s.device_profile not in LATENCY_TARGET_PROFILES:
        notes.append(
            "Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 "
            "(8th-gen U-series CPU, <=16 GB LPDDR3, no NPU).")
    if "Ultra" in cpu:
        notes.append("This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned.")
    if s.foundry_register_eps:
        notes.append("Windows ML execution providers are registered (GPU/NPU variants visible).")
    return HardwareInfo(
        cpu_name=cpu,
        physical_cores=psutil.cpu_count(logical=False),
        logical_cores=psutil.cpu_count(logical=True),
        ram_gb=round(psutil.virtual_memory().total / 1024 ** 3, 1),
        os=_os_name(),
        os_build=platform.version(),
        python_version=sys.version.split()[0],
        device_profile=s.device_profile,
        battery_present=battery,
        notes=notes,
    )


def process_rss_mb() -> float:
    return psutil.Process(os.getpid()).memory_info().rss / 1024 ** 2
