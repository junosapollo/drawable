"""Provenance manifest schema for every source asset and derived crop.

One :class:`ManifestRecord` exists per gallery/training item. The manifest is
the contract between ``ml`` (which produces it) and ``services/api`` (which
loads it into SQLite and refuses to serve anything that fails validation).

Cross-field invariants enforced here are the ones the Milestone 2 gate
("every enabled reference passes manifest validation") depends on.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from pathlib import PurePosixPath
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from linescout_ml.taxonomy import (
    GALLERY_SCOPES,
    DatasetSplit,
    LineArtOrigin,
    PrimaryStyle,
    ReviewState,
    ScopeLabel,
)

MANIFEST_SCHEMA_VERSION: Literal[1] = 1

AssetId = Annotated[str, StringConstraints(pattern=r"^ls_[a-z0-9]{2,16}_[a-f0-9]{16}$")]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
PHash = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{16}$")]
UnitInterval = Annotated[float, Field(ge=0.0, le=1.0)]
RelativePath = Annotated[str, StringConstraints(min_length=1, max_length=512)]


class CropBox(BaseModel):
    """Crop coordinates in source-image pixel space (inclusive-exclusive)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class SfwDecision(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    safe: bool
    confidence: UnitInterval
    method: Literal["source_rating", "opennsfw2", "source_rating+opennsfw2", "manual"]


class HumanReview(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    state: ReviewState = ReviewState.UNREVIEWED
    quality: Literal[1, 2, 3] | None = None
    malformed_anatomy: bool = False
    poor_extraction: bool = False
    note: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _quality_only_when_reviewed(self) -> Self:
        if self.state is ReviewState.UNREVIEWED and self.quality is not None:
            msg = "quality cannot be set on an unreviewed asset"
            raise ValueError(msg)
        return self


class ManifestRecord(BaseModel):
    """One gallery or training asset. See the spec's "Manifest schema" list."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    # Identity and provenance
    asset_id: AssetId
    source_dataset: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    source_item_id: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    source_work_id: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    source_url: str | None = Field(default=None, max_length=2048)
    license_id: Annotated[str, StringConstraints(min_length=1, max_length=64)]

    # Local files (relative to the data root; never absolute)
    original_path: RelativePath
    line_art_path: RelativePath
    thumbnail_path: RelativePath

    # Line-art origin
    origin: LineArtOrigin
    extraction_model: str | None = Field(default=None, max_length=64)
    extraction_version: str | None = Field(default=None, max_length=32)

    # Labels
    primary_style: PrimaryStyle
    scopes: list[ScopeLabel] = Field(min_length=1)
    person_count: int = Field(ge=0, le=50)
    sfw: SfwDecision

    # Geometry
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    crop: CropBox | None = None

    # Automated measurements
    text_coverage: UnitInterval
    ink_coverage: UnitInterval
    phash: PHash
    quality_score: UnitInterval

    # Curation and split
    review: HumanReview = Field(default_factory=HumanReview)
    split: DatasetSplit
    enabled: bool

    # Pipeline
    pipeline_version: Annotated[str, StringConstraints(min_length=1, max_length=32)]
    checksum: Sha256

    @field_validator("original_path", "line_art_path", "thumbnail_path")
    @classmethod
    def _relative_posix_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or "\\" in value:
            msg = f"path must be relative to the data root and contain no '..': {value!r}"
            raise ValueError(msg)
        return value

    @field_validator("scopes")
    @classmethod
    def _unique_gallery_scopes(cls, value: list[ScopeLabel]) -> list[ScopeLabel]:
        if len(set(value)) != len(value):
            msg = "scopes must be unique"
            raise ValueError(msg)
        bad = [scope for scope in value if scope not in GALLERY_SCOPES]
        if bad:
            msg = f"gallery assets cannot carry query-only scopes: {bad}"
            raise ValueError(msg)
        return value

    @model_validator(mode="after")
    def _cross_field_invariants(self) -> Self:
        if self.origin is LineArtOrigin.EXTRACTED:
            if not (self.extraction_model and self.extraction_version):
                msg = "extracted assets must record extraction_model and extraction_version"
                raise ValueError(msg)
        elif self.extraction_model or self.extraction_version:
            msg = "native assets must not record an extraction model"
            raise ValueError(msg)

        if self.enabled:
            if not self.sfw.safe:
                msg = "enabled assets must have an SFW decision of safe=true"
                raise ValueError(msg)
            if self.review.state in (ReviewState.REJECTED, ReviewState.QUARANTINED):
                msg = f"enabled assets cannot be {self.review.state.value}"
                raise ValueError(msg)

        if ScopeLabel.MULTI_CHARACTER in self.scopes and self.person_count < 2:
            msg = "multi_character assets must have person_count >= 2"
            raise ValueError(msg)

        if min(self.width, self.height) < 256:
            msg = "short edge must be at least 256 px"
            raise ValueError(msg)

        if self.crop is not None and (
            self.crop.x + self.crop.width > self.width
            or self.crop.y + self.crop.height > self.height
        ):
            msg = "crop box exceeds image bounds"
            raise ValueError(msg)
        return self


class Manifest(BaseModel):
    """A versioned collection of records plus the dataset/index version stamp."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = MANIFEST_SCHEMA_VERSION
    dataset_version: Annotated[
        str, StringConstraints(pattern=r"^\d{4}\.\d{2}\.\d{2}(-[a-z0-9]+)?$")
    ]
    records: list[ManifestRecord]

    @model_validator(mode="after")
    def _unique_ids_and_checksums(self) -> Self:
        seen_ids: set[str] = set()
        for record in self.records:
            if record.asset_id in seen_ids:
                msg = f"duplicate asset_id {record.asset_id}"
                raise ValueError(msg)
            seen_ids.add(record.asset_id)
        return self

    @property
    def enabled_records(self) -> list[ManifestRecord]:
        return [record for record in self.records if record.enabled]

    def content_hash(self) -> str:
        """Stable hash of the manifest content, used as the index version key."""
        payload = self.model_dump_json(exclude_none=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def make_asset_id(source_dataset: str, source_item_id: str, crop: CropBox | None = None) -> str:
    """Deterministic project asset ID: ``ls_<dataset>_<16 hex>``."""
    dataset_slug = "".join(ch for ch in source_dataset.lower() if ch.isalnum())[:16] or "src"
    material = f"{source_dataset}\x00{source_item_id}"
    if crop is not None:
        material += f"\x00{crop.x},{crop.y},{crop.width},{crop.height}"
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]
    return f"ls_{dataset_slug}_{digest}"


def check_split_integrity(records: Iterable[ManifestRecord]) -> list[str]:
    """Return human-readable violations of the "one source work, one split" rule."""
    works: dict[str, set[DatasetSplit]] = {}
    for record in records:
        works.setdefault(record.source_work_id, set()).add(record.split)
    return [
        f"source work {work!r} spans splits {sorted(split.value for split in splits)}"
        for work, splits in sorted(works.items())
        if len(splits - {DatasetSplit.GALLERY_ONLY}) > 1
    ]


def manifest_json_schema() -> dict[str, object]:
    return Manifest.model_json_schema()


def dump_json_schema() -> str:
    return json.dumps(manifest_json_schema(), indent=2, sort_keys=True) + "\n"
