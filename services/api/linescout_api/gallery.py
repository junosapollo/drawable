"""Load a validated manifest into SQLite and answer gallery queries.

The manifest file is authoritative. At startup we validate it, refuse to start
if it is malformed, and then (re)populate the ``assets`` cache table only when
its content hash differs from what is already loaded.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from linescout_ml.manifest import Manifest, ManifestRecord, check_split_integrity
from linescout_ml.taxonomy import LineArtOrigin, PrimaryStyle

from linescout_api.db import transaction

log = logging.getLogger(__name__)


class GalleryLoadError(RuntimeError):
    """The manifest is missing, malformed, or violates an integrity rule."""


@dataclass(frozen=True)
class GalleryInfo:
    dataset_version: str
    manifest_hash: str
    manifest_path: Path
    data_root: Path
    asset_count: int
    enabled_count: int


def load_manifest(path: Path) -> Manifest:
    if not path.is_file():
        msg = f"gallery manifest not found: {path}"
        raise GalleryLoadError(msg)
    try:
        manifest = Manifest.model_validate_json(path.read_text(encoding="utf-8"))
    except ValueError as error:
        msg = f"gallery manifest failed validation: {error}"
        raise GalleryLoadError(msg) from error
    problems = check_split_integrity(manifest.records)
    if problems:
        msg = "gallery manifest violates split integrity: " + "; ".join(problems[:5])
        raise GalleryLoadError(msg)
    return manifest


def _record_row(record: ManifestRecord) -> tuple[object, ...]:
    return (
        record.asset_id,
        record.source_dataset,
        record.source_item_id,
        record.source_work_id,
        record.source_url,
        record.license_id,
        record.original_path,
        record.line_art_path,
        record.thumbnail_path,
        record.origin.value,
        record.extraction_model,
        record.extraction_version,
        record.primary_style.value,
        json.dumps([scope.value for scope in record.scopes]),
        record.person_count,
        int(record.sfw.safe),
        record.sfw.confidence,
        record.sfw.method,
        record.width,
        record.height,
        record.crop.model_dump_json() if record.crop else None,
        record.text_coverage,
        record.ink_coverage,
        record.phash,
        record.quality_score,
        record.review.state.value,
        record.review.quality,
        record.split.value,
        int(record.enabled),
        record.pipeline_version,
        record.checksum,
    )


_INSERT_ASSET = """
INSERT INTO assets (
    asset_id, source_dataset, source_item_id, source_work_id, source_url, license_id,
    original_path, line_art_path, thumbnail_path, origin, extraction_model, extraction_version,
    primary_style, scopes_json, person_count, sfw_safe, sfw_confidence, sfw_method,
    width, height, crop_json, text_coverage, ink_coverage, phash, quality_score,
    review_state, review_quality, split, enabled, pipeline_version, checksum
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""


def sync_gallery(connection: sqlite3.Connection, manifest_path: Path) -> GalleryInfo:
    """Validate ``manifest_path`` and make the ``assets`` table match it."""
    manifest = load_manifest(manifest_path)
    manifest_hash = manifest.content_hash()
    data_root = manifest_path.parent
    enabled = manifest.enabled_records

    for record in enabled:
        for rel in (record.line_art_path, record.thumbnail_path):
            if not (data_root / rel).is_file():
                msg = f"enabled asset {record.asset_id} is missing file {rel}"
                raise GalleryLoadError(msg)

    current = connection.execute(
        "SELECT manifest_hash FROM gallery_versions WHERE id = 1"
    ).fetchone()
    if current is not None and current["manifest_hash"] == manifest_hash:
        log.info(
            "gallery %s already loaded (%d assets)", manifest.dataset_version, len(manifest.records)
        )
    else:
        log.info(
            "loading gallery %s (%d assets, %d enabled)",
            manifest.dataset_version,
            len(manifest.records),
            len(enabled),
        )
        with transaction(connection) as tx:
            tx.execute("DELETE FROM asset_scopes")
            tx.execute("DELETE FROM assets")
            tx.executemany(_INSERT_ASSET, (_record_row(record) for record in manifest.records))
            tx.executemany(
                "INSERT INTO asset_scopes(asset_id, scope) VALUES (?, ?)",
                (
                    (record.asset_id, scope.value)
                    for record in manifest.records
                    for scope in record.scopes
                ),
            )
            tx.execute("DELETE FROM gallery_versions")
            tx.execute(
                "INSERT INTO gallery_versions"
                " (id, dataset_version, manifest_hash, manifest_path, asset_count, enabled_count)"
                " VALUES (1, ?, ?, ?, ?, ?)",
                (
                    manifest.dataset_version,
                    manifest_hash,
                    str(manifest_path),
                    len(manifest.records),
                    len(enabled),
                ),
            )

    return GalleryInfo(
        dataset_version=manifest.dataset_version,
        manifest_hash=manifest_hash,
        manifest_path=manifest_path,
        data_root=data_root,
        asset_count=len(manifest.records),
        enabled_count=len(enabled),
    )


@dataclass(frozen=True)
class GalleryAsset:
    asset_id: str
    primary_style: PrimaryStyle
    scopes: tuple[str, ...]
    origin: LineArtOrigin
    quality_score: float
    line_art_path: str
    thumbnail_path: str


def enabled_assets(connection: sqlite3.Connection) -> list[GalleryAsset]:
    """Every asset eligible to appear in a response. SFW/review gating lives in SQL CHECKs too."""
    rows = connection.execute(
        "SELECT asset_id, primary_style, scopes_json, origin, quality_score,"
        " line_art_path, thumbnail_path"
        " FROM assets WHERE enabled = 1 AND sfw_safe = 1 ORDER BY asset_id"
    ).fetchall()
    return [
        GalleryAsset(
            asset_id=row["asset_id"],
            primary_style=PrimaryStyle(row["primary_style"]),
            scopes=tuple(json.loads(row["scopes_json"])),
            origin=LineArtOrigin(row["origin"]),
            quality_score=float(row["quality_score"]),
            line_art_path=row["line_art_path"],
            thumbnail_path=row["thumbnail_path"],
        )
        for row in rows
    ]


def asset_file(connection: sqlite3.Connection, asset_id: str, kind: str) -> str | None:
    """Relative path for an enabled asset's ``thumbnail`` or ``line_art`` file, else ``None``."""
    column = {"thumbnail": "thumbnail_path", "line_art": "line_art_path"}[kind]
    row = connection.execute(
        f"SELECT {column} AS path FROM assets WHERE asset_id = ? AND enabled = 1 AND sfw_safe = 1",  # noqa: S608
        (asset_id,),
    ).fetchone()
    return str(row["path"]) if row else None
