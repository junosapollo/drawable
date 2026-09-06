"""Process-wide runtime state built during the FastAPI lifespan.

Milestone 1 loads configuration, the device report, the SQLite schema, and
the gallery manifest. Milestone 4 adds model loading and warmup here; the
readiness flag is already gated on every *mandatory* component so the health
endpoint's semantics do not change later.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from dataclasses import dataclass, field
from typing import Literal

from linescout_api import __version__
from linescout_api.config import DevicePolicy, Settings
from linescout_api.db import connect, migrate, schema_version
from linescout_api.device import DeviceInfo, detect_device
from linescout_api.gallery import (
    GalleryAsset,
    GalleryInfo,
    GalleryLoadError,
    enabled_assets,
    sync_gallery,
)
from linescout_api.schemas import ModelVersion

log = logging.getLogger(__name__)


@dataclass
class AppState:
    settings: Settings
    device: DeviceInfo
    connection: sqlite3.Connection
    schema_version: int
    gallery: GalleryInfo | None
    assets: list[GalleryAsset]
    models: list[ModelVersion]
    warmup: Literal["pending", "complete", "skipped"]
    warnings: list[str] = field(default_factory=list)
    disabled_branches: list[str] = field(default_factory=list)
    setup_error: str | None = None
    # One GPU request at a time; HTTP stays async around it.
    inference_lock: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))

    @property
    def ready(self) -> bool:
        if self.setup_error:
            return False
        if self.settings.device is DevicePolicy.CUDA and not self.device.is_cuda:
            return False
        return self.warmup in ("complete", "skipped")

    @property
    def api_version(self) -> str:
        return __version__


def build_state(settings: Settings) -> AppState:
    device = detect_device(settings.device)
    warnings: list[str] = []
    if device.warning:
        warnings.append(device.warning)

    connection = connect(settings.db_path)
    applied = migrate(connection)
    if applied:
        log.info("applied migrations: %s", ", ".join(applied))

    gallery: GalleryInfo | None = None
    assets: list[GalleryAsset] = []
    setup_error: str | None = None
    if settings.gallery_manifest is not None:
        try:
            gallery = sync_gallery(connection, settings.gallery_manifest)
            assets = enabled_assets(connection)
        except GalleryLoadError as error:
            setup_error = str(error)
            log.error("gallery load failed: %s", error)
    elif not settings.fixture_mode:
        setup_error = "LINESCOUT_GALLERY_MANIFEST is not set and fixture mode is disabled"
    else:
        warnings.append("no gallery manifest configured; search returns fixture results")

    models = [
        ModelVersion(name="semantic", version="fixture", loaded=False),
        ModelVersion(name="structural", version="fixture", loaded=False),
        ModelVersion(name="stroke", version="fixture", loaded=False),
        ModelVersion(name="scope", version="fixture", loaded=False),
        ModelVersion(name="pose", version="fixture", loaded=False),
    ]
    if settings.fixture_mode:
        warnings.append("fixture mode: retrieval models are not loaded")

    return AppState(
        settings=settings,
        device=device,
        connection=connection,
        schema_version=schema_version(connection),
        gallery=gallery,
        assets=assets,
        models=models,
        warmup="skipped" if settings.fixture_mode else "pending",
        warnings=warnings,
        disabled_branches=["pose", "stroke"] if settings.fixture_mode else [],
        setup_error=setup_error,
    )
