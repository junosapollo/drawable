"""Deterministic synthetic dataset for smoke tests and fixture-mode development.

Writes tiny, valid line-art PNGs plus a manifest that exercises every
taxonomy value, both line-art origins, all splits, and one disabled/rejected
record. It contains no third-party data, so it is safe to commit as a fixture
and to generate in CI. PNG encoding is done with the standard library so the
``ml`` package stays dependency-light at Milestone 1.
"""

from __future__ import annotations

import hashlib
import math
import random
import struct
import zlib
from pathlib import Path

from linescout_ml.manifest import (
    CropBox,
    HumanReview,
    Manifest,
    ManifestRecord,
    SfwDecision,
    make_asset_id,
)
from linescout_ml.taxonomy import (
    DatasetSplit,
    LineArtOrigin,
    PrimaryStyle,
    ReviewState,
    ScopeLabel,
)

SYNTHETIC_DATASET_VERSION = "2026.09.06-synthetic"
SYNTHETIC_PIPELINE_VERSION = "synthetic-1"
IMAGE_SIZE = 256
THUMB_SIZE = 64

_SCOPE_CYCLE: tuple[tuple[ScopeLabel, ...], ...] = (
    (ScopeLabel.EYE,),
    (ScopeLabel.FACE_HEAD, ScopeLabel.HAIR),
    (ScopeLabel.HAND,),
    (ScopeLabel.FOOT,),
    (ScopeLabel.UPPER_BODY_CLOTHING,),
    (ScopeLabel.FULL_BODY,),
    (ScopeLabel.MULTI_CHARACTER, ScopeLabel.FULL_BODY),
)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def encode_grayscale_png(pixels: list[list[int]]) -> bytes:
    """Encode a 2-D list of 0-255 grayscale values as a PNG byte string."""
    height = len(pixels)
    width = len(pixels[0]) if height else 0
    raw = b"".join(b"\x00" + bytes(row) for row in pixels)
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )


def _line_art_pixels(
    rng: random.Random, size: int, scopes: tuple[ScopeLabel, ...]
) -> list[list[int]]:
    """White canvas with a few dark strokes; shape loosely follows the scope."""
    pixels = [[255] * size for _ in range(size)]

    def plot(x: float, y: float, thickness: int) -> None:
        cx, cy = int(x), int(y)
        for dy in range(-thickness, thickness + 1):
            for dx in range(-thickness, thickness + 1):
                px, py = cx + dx, cy + dy
                if 0 <= px < size and 0 <= py < size and dx * dx + dy * dy <= thickness * thickness:
                    pixels[py][px] = 20

    def ellipse(cx: float, cy: float, rx: float, ry: float, thickness: int) -> None:
        steps = int(8 * max(rx, ry))
        for index in range(steps):
            angle = math.tau * index / steps
            plot(cx + rx * math.cos(angle), cy + ry * math.sin(angle), thickness)

    def line(x0: float, y0: float, x1: float, y1: float, thickness: int) -> None:
        steps = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
        for index in range(steps):
            t = index / max(steps - 1, 1)
            plot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness)

    thickness = rng.choice((1, 2, 2, 3))
    mid = size / 2
    if ScopeLabel.EYE in scopes:
        ellipse(mid, mid, size * 0.32, size * 0.16, thickness)
        ellipse(mid, mid, size * 0.09, size * 0.09, thickness)
    elif ScopeLabel.FACE_HEAD in scopes:
        ellipse(mid, mid, size * 0.26, size * 0.34, thickness)
        line(mid - size * 0.1, mid - size * 0.05, mid - size * 0.02, mid - size * 0.05, thickness)
        line(mid + size * 0.02, mid - size * 0.05, mid + size * 0.1, mid - size * 0.05, thickness)
    elif ScopeLabel.HAND in scopes or ScopeLabel.FOOT in scopes:
        for finger in range(5):
            x = mid - size * 0.2 + finger * size * 0.1
            line(
                x,
                mid + size * 0.2,
                x + rng.uniform(-4, 4),
                mid - size * 0.25 + finger * 3,
                thickness,
            )
    elif ScopeLabel.MULTI_CHARACTER in scopes:
        for cx in (mid - size * 0.22, mid + size * 0.22):
            ellipse(cx, mid - size * 0.25, size * 0.07, size * 0.08, thickness)
            line(cx, mid - size * 0.17, cx, mid + size * 0.15, thickness)
            line(cx, mid + size * 0.15, cx - size * 0.08, mid + size * 0.38, thickness)
            line(cx, mid + size * 0.15, cx + size * 0.08, mid + size * 0.38, thickness)
    else:
        ellipse(mid, mid - size * 0.3, size * 0.08, size * 0.09, thickness)
        line(mid, mid - size * 0.21, mid, mid + size * 0.12, thickness)
        line(mid, mid - size * 0.12, mid - size * 0.18, mid + size * 0.02, thickness)
        line(mid, mid - size * 0.12, mid + size * 0.18, mid + size * 0.02, thickness)
        if ScopeLabel.FULL_BODY in scopes:
            line(mid, mid + size * 0.12, mid - size * 0.1, mid + size * 0.4, thickness)
            line(mid, mid + size * 0.12, mid + size * 0.1, mid + size * 0.4, thickness)
    return pixels


def _downsample(pixels: list[list[int]], target: int) -> list[list[int]]:
    source = len(pixels)
    factor = source // target
    out: list[list[int]] = []
    for ty in range(target):
        row: list[int] = []
        for tx in range(target):
            block = [
                pixels[ty * factor + dy][tx * factor + dx]
                for dy in range(factor)
                for dx in range(factor)
            ]
            row.append(min(block))
        out.append(row)
    return out


def _phash_like(pixels: list[list[int]]) -> str:
    """Not a real perceptual hash; a stable 64-bit fingerprint for fixtures."""
    small = _downsample(pixels, 8)
    mean = sum(sum(row) for row in small) / 64
    bits = 0
    for row in small:
        for value in row:
            bits = (bits << 1) | int(value < mean)
    return f"{bits:016x}"


def build_synthetic_records(out_dir: Path, count: int = 24, seed: int = 7) -> list[ManifestRecord]:
    rng = random.Random(seed)
    styles = list(PrimaryStyle)
    splits = [
        DatasetSplit.TRAIN,
        DatasetSplit.TRAIN,
        DatasetSplit.VALIDATION,
        DatasetSplit.TEST,
        DatasetSplit.GALLERY_ONLY,
    ]
    records: list[ManifestRecord] = []

    for index in range(count):
        scopes = _SCOPE_CYCLE[index % len(_SCOPE_CYCLE)]
        style = styles[index % len(styles)]
        work_id = f"synthetic-work-{index // 3:03d}"  # three crops per "work"
        item_id = f"synthetic-item-{index:04d}"
        crop = CropBox(x=0, y=0, width=IMAGE_SIZE, height=IMAGE_SIZE) if index % 3 else None
        asset_id = make_asset_id("synthetic", item_id, crop)

        pixels = _line_art_pixels(rng, IMAGE_SIZE, scopes)
        png = encode_grayscale_png(pixels)
        thumb = encode_grayscale_png(_downsample(pixels, THUMB_SIZE))

        original_rel = f"originals/{asset_id}.png"
        line_rel = f"line_art/{asset_id}.png"
        thumb_rel = f"thumbnails/{asset_id}.png"
        for rel, data in ((original_rel, png), (line_rel, png), (thumb_rel, thumb)):
            target = out_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

        extracted = index % 4 == 3
        rejected = index == count - 1  # last record is a disabled, rejected example
        ink = sum(1 for row in pixels for value in row if value < 128) / (IMAGE_SIZE * IMAGE_SIZE)
        split = splits[(index // 3) % len(splits)]  # split assigned per work, never per crop

        records.append(
            ManifestRecord(
                asset_id=asset_id,
                source_dataset="synthetic",
                source_item_id=item_id,
                source_work_id=work_id,
                source_url=None,
                license_id="synthetic-fixture",
                original_path=original_rel,
                line_art_path=line_rel,
                thumbnail_path=thumb_rel,
                origin=LineArtOrigin.EXTRACTED if extracted else LineArtOrigin.NATIVE,
                extraction_model="synthetic-identity" if extracted else None,
                extraction_version="1" if extracted else None,
                primary_style=style,
                scopes=list(scopes),
                person_count=2 if ScopeLabel.MULTI_CHARACTER in scopes else 1,
                sfw=SfwDecision(safe=True, confidence=0.99, method="manual"),
                width=IMAGE_SIZE,
                height=IMAGE_SIZE,
                crop=crop,
                text_coverage=0.0,
                ink_coverage=round(ink, 4),
                phash=_phash_like(pixels),
                quality_score=round(rng.uniform(0.6, 0.98), 3),
                review=HumanReview(state=ReviewState.REJECTED, quality=1, note="synthetic reject")
                if rejected
                else HumanReview(state=ReviewState.ACCEPTED, quality=rng.choice((2, 3))),
                split=split,
                enabled=not rejected,
                pipeline_version=SYNTHETIC_PIPELINE_VERSION,
                checksum=hashlib.sha256(png).hexdigest(),
            )
        )
    return records


def write_synthetic_dataset(out_dir: Path, count: int = 24, seed: int = 7) -> Path:
    """Write images plus ``manifest.json`` under ``out_dir`` and return the manifest path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = Manifest(
        dataset_version=SYNTHETIC_DATASET_VERSION,
        records=build_synthetic_records(out_dir, count=count, seed=seed),
    )
    path = out_dir / "manifest.json"
    path.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path
