"""Canonical LineScout taxonomy.

These enums are the single source of truth for scope, style, and line-art
origin. The API re-exports them for its OpenAPI schema, and
``packages/contracts`` mirrors them for the frontend, so any change here must
be followed by regenerating the TypeScript contracts.
"""

from __future__ import annotations

from enum import StrEnum


class ScopeLabel(StrEnum):
    """What part of a character (or how many characters) an image depicts.

    An asset may carry several scope labels; queries return one probability per
    label plus ``unknown``.
    """

    EYE = "eye"
    FACE_HEAD = "face_head"
    HAIR = "hair"
    HAND = "hand"
    FOOT = "foot"
    UPPER_BODY_CLOTHING = "upper_body_clothing"
    FULL_BODY = "full_body"
    MULTI_CHARACTER = "multi_character"
    UNKNOWN = "unknown"


class PrimaryStyle(StrEnum):
    """Exactly one primary style per asset. Also the five reference-panel rows."""

    MANGA_ANIME = "manga_anime"
    WESTERN_INK = "western_ink"
    REALISTIC_ACADEMIC = "realistic_academic"
    CARTOON = "cartoon"
    GESTURE_SKETCH = "gesture_sketch"


class LineArtOrigin(StrEnum):
    """Whether the visible reference is native line art or machine-extracted."""

    NATIVE = "native_line_art"
    EXTRACTED = "extracted_line_art"


class DatasetSplit(StrEnum):
    """Split assignment. Assets derived from one source work never cross splits."""

    TRAIN = "train"
    VALIDATION = "validation"
    TEST = "test"
    GALLERY_ONLY = "gallery_only"


class ReviewState(StrEnum):
    """Human curation state for an asset."""

    UNREVIEWED = "unreviewed"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    QUARANTINED = "quarantined"


#: Fixed style-row order for new preference profiles (spec §3, "Reference panel").
DEFAULT_STYLE_ORDER: tuple[PrimaryStyle, ...] = (
    PrimaryStyle.MANGA_ANIME,
    PrimaryStyle.REALISTIC_ACADEMIC,
    PrimaryStyle.WESTERN_INK,
    PrimaryStyle.CARTOON,
    PrimaryStyle.GESTURE_SKETCH,
)

#: Scope labels that a *gallery* asset may carry. ``unknown`` is query-only.
GALLERY_SCOPES: frozenset[ScopeLabel] = frozenset(ScopeLabel) - {ScopeLabel.UNKNOWN}
