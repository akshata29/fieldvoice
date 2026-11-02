"""System status, hardware, readiness, connectivity."""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from backend.schemas.workorders import AuthSession, BundleSummary


class HardwareInfo(BaseModel):
    cpu_name: str = "unknown"
    physical_cores: int | None = None
    logical_cores: int | None = None
    ram_gb: float | None = None
    os: str = "unknown"
    os_build: str | None = None
    python_version: str = ""
    device_profile: str = "dev-box"
    battery_present: bool | None = None
    notes: list[str] = Field(default_factory=list)  # e.g. "NPU present", "not representative of Latitude 7220"


class FoundryStatus(BaseModel):
    available: bool = False
    sdk_version: str | None = None
    catalog_count: int | None = None
    eps_registered: bool = False
    model_cache_dir: str | None = None
    error: str | None = None


class ConnectivityState(BaseModel):
    online: bool = True
    since: str = ""


class ReadinessStatus(str, Enum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    RUNNING = "running"
    PENDING = "pending"


class ReadinessCheck(BaseModel):
    id: str  # "auth" | "bundle" | "forms" | "kb" | "models_cached" | "models_load" | "self_test" | "disk" | "storage"
    label: str
    status: ReadinessStatus = ReadinessStatus.PENDING
    detail: str = ""
    duration_ms: float | None = None


class ReadinessReport(BaseModel):
    overall: ReadinessStatus = ReadinessStatus.PENDING
    checks: list[ReadinessCheck] = Field(default_factory=list)
    generated_at: str = ""


class SystemStatus(BaseModel):
    connectivity: ConnectivityState
    session: AuthSession | None = None
    bundle: BundleSummary | None = None
    readiness: ReadinessReport | None = None
    hardware: HardwareInfo
    foundry: FoundryStatus
    version: str = "0.1.0"
