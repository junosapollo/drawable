"""Typed runtime configuration.

Every setting has a free, local default so a fresh clone runs with no
environment at all. Overrides come from ``LINESCOUT_*`` environment variables
or a ``.env`` file in ``services/api``. Paths are resolved relative to the
repository root so no absolute machine path ever needs to be committed.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Literal, Self

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
SYNTHETIC_MANIFEST = REPO_ROOT / "ml" / "fixtures" / "synthetic" / "manifest.json"


class DevicePolicy(StrEnum):
    AUTO = "auto"  # CUDA if available, otherwise CPU with a warning
    CUDA = "cuda"  # fail readiness if CUDA is missing
    CPU = "cpu"  # force CPU even when CUDA exists


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LINESCOUT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    cors_origins: list[str] = ["http://127.0.0.1:5173", "http://localhost:5173"]

    # Storage (relative paths resolve from the repository root)
    data_dir: Path = Path("data")
    db_path: Path = Path("data/linescout.sqlite3")
    # In fixture mode this defaults to the committed synthetic gallery so a fresh
    # clone has references to serve; point it at data/gallery/<version>/manifest.json
    # once a real gallery exists. Set LINESCOUT_GALLERY_MANIFEST= (empty) to disable.
    gallery_manifest: Path | None = None

    # Runtime mode
    device: DevicePolicy = DevicePolicy.AUTO
    curation_mode: bool = False  # CURATION_MODE=1 in the spec; exposes /api/v1/curation/*
    fixture_mode: bool = True  # serve deterministic fixture results until models exist

    # Search contract limits (spec §5, API contracts)
    max_image_bytes: int = 4 * 1024 * 1024
    max_strokes_bytes: int = 2 * 1024 * 1024
    max_text_hint_chars: int = 120
    min_points_for_search: int = 20
    min_ink_diagonal_ratio: float = 0.02
    canvas_logical_size: int = 2048
    snapshot_size: int = 512

    # Preference learning
    preference_half_life_days: float = 30.0

    @field_validator("gallery_manifest", mode="before")
    @classmethod
    def _empty_string_disables(cls, value: object) -> object:
        return None if isinstance(value, str) and value.strip() == "" else value

    @field_validator("data_dir", "db_path", "gallery_manifest")
    @classmethod
    def _resolve_from_repo_root(cls, value: Path | None) -> Path | None:
        if value is None or value.is_absolute():
            return value
        return (REPO_ROOT / value).resolve()

    @model_validator(mode="after")
    def _default_fixture_gallery(self) -> Self:
        if (
            self.gallery_manifest is None
            and self.fixture_mode
            and "gallery_manifest" not in self.model_fields_set
        ):
            self.gallery_manifest = SYNTHETIC_MANIFEST
        return self

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_csv(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
