"""Pydantic models for every API request/response.

These are the source of the OpenAPI document and therefore of
``packages/contracts``. Field names follow the spec's API contracts section
verbatim so the generated TypeScript matches the document the team reviews.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal
from uuid import UUID

from linescout_ml.taxonomy import LineArtOrigin, PrimaryStyle, ScopeLabel
from pydantic import BaseModel, ConfigDict, Field

# Re-exported so the OpenAPI schema names them once and the TS contracts pick
# them up as string-literal unions.
__all__ = [
    "PrimaryStyle",
    "ScopeLabel",
    "LineArtOrigin",
    "SearchMode",
    "InteractionEvent",
    "StyleSelection",
]


class SearchMode(StrEnum):
    INSUFFICIENT = "insufficient"
    PROVISIONAL = "provisional"
    CONFIDENT = "confident"


class InteractionEvent(StrEnum):
    OPEN = "open"
    PIN = "pin"
    UNPIN = "unpin"
    TRACE = "trace"


class StyleSelection(StrEnum):
    """``selected_style`` multipart value: a style enum or ``all``."""

    ALL = "all"
    MANGA_ANIME = "manga_anime"
    WESTERN_INK = "western_ink"
    REALISTIC_ACADEMIC = "realistic_academic"
    CARTOON = "cartoon"
    GESTURE_SKETCH = "gesture_sketch"


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", use_enum_values=False)


# ---------------------------------------------------------------- errors


class ErrorDetail(ApiModel):
    code: str = Field(description="Stable machine-readable error code, e.g. image_too_large.")
    message: str
    field: str | None = None


class ErrorResponse(ApiModel):
    error: ErrorDetail


# ---------------------------------------------------------------- health


class ModelVersion(ApiModel):
    name: str
    version: str
    loaded: bool
    device: str | None = None


class HealthResponse(ApiModel):
    ready: bool
    fixture_mode: bool
    cuda_available: bool
    device: Literal["cuda", "cpu"]
    gpu_name: str | None
    vram_total_mb: int | None
    torch_version: str | None
    api_version: str
    schema_version: int
    models: list[ModelVersion]
    dataset_version: str | None
    index_version: str | None
    gallery_size: int
    disabled_branches: list[str] = Field(
        description="Optional retrieval branches disabled this session, e.g. pose."
    )
    warmup: Literal["pending", "complete", "skipped"]
    warnings: list[str]
    curation_enabled: bool


# ---------------------------------------------------------------- search


class ScopePrediction(ApiModel):
    label: ScopeLabel
    confidence: float = Field(ge=0.0, le=1.0)


class SearchResult(ApiModel):
    asset_id: str
    thumbnail_url: str
    style: PrimaryStyle
    scopes: list[ScopeLabel]
    origin: LineArtOrigin
    relevance: float = Field(ge=0.0, le=1.0, description="Calibrated relevance probability.")
    quality: float = Field(ge=0.0, le=1.0)
    asset_url: str = Field(description="Trace-compatible full asset URL.")


class SearchGroup(ApiModel):
    id: str
    title: str
    kind: Literal["best_match", "style", "provisional_scope"]
    style: PrimaryStyle | None = None
    scope: ScopeLabel | None = None
    results: list[SearchResult]


class SearchTiming(ApiModel):
    preprocessing_ms: float
    embedding_ms: float
    retrieval_ms: float
    reranking_ms: float
    total_ms: float


class SearchResponse(ApiModel):
    revision: int = Field(ge=1, description="Echoes the request revision unchanged.")
    mode: SearchMode
    scope_predictions: list[ScopePrediction]
    groups: list[SearchGroup]
    timing: SearchTiming
    warning: str | None = None


class StrokePoint(ApiModel):
    """One sampled pointer position inside the gzipped ``strokes`` field."""

    x: float
    y: float
    p: float = Field(ge=0.0, le=1.0, description="Normalized pressure.")
    t: float = Field(description="Milliseconds since the stroke sequence started.")


class Stroke(ApiModel):
    tool: Literal["pressure", "monoline", "eraser"]
    pointer: Literal["pen", "mouse", "touch"]
    points: list[StrokePoint]


class StrokeSequence(ApiModel):
    version: Literal[1] = 1
    canvas_width: int = Field(gt=0)
    canvas_height: int = Field(gt=0)
    strokes: list[Stroke]


# ---------------------------------------------------------------- events


class EventRequest(ApiModel):
    session_id: UUID
    asset_id: str = Field(min_length=1, max_length=64)
    event: InteractionEvent
    style: PrimaryStyle
    query_revision: int = Field(ge=0)


class EventResponse(ApiModel):
    id: int
    created_at: str


# ---------------------------------------------------------------- preferences


class StyleAffinity(ApiModel):
    style: PrimaryStyle
    affinity: float = Field(ge=0.0, le=1.0, description="Laplace-smoothed, decayed share.")


class PreferencesResponse(ApiModel):
    selected_style: PrimaryStyle | None
    learning_enabled: bool
    affinities: list[StyleAffinity]
    row_order: list[PrimaryStyle] = Field(
        description="Style-row order after Best Match: explicit style first, then learned "
        "affinity, then the fixed default order as tie-breaker."
    )


class PreferencesUpdate(ApiModel):
    """Partial update; omitted fields are left unchanged."""

    selected_style: PrimaryStyle | None = Field(
        default=None, description="Explicitly select a style. Ignored unless provided."
    )
    clear_selected_style: bool = Field(default=False, description="Clear the explicit style.")
    learning_enabled: bool | None = None
    reset_affinities: bool = False
