"""Deterministic fixture retrieval used until the Milestone 4 models exist.

It is *not* a retrieval model. It exists so the wire contract, the grouping
rules, revision handling, and the insufficient/provisional/confident state
machine can be exercised end to end against real gallery rows. Scores are
derived from ink statistics and a stable per-asset hash so that the same
canvas always yields the same response.

Structural rules it must honour (they are tested):
- Best Match first with up to 8 results, then one row per style with up to 6.
- Style rows never include an asset below the relevance floor.
- Provisional mode returns up to three scope groups with 4 results each.
- Only enabled, SFW-safe assets can appear.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from linescout_ml.taxonomy import DEFAULT_STYLE_ORDER, PrimaryStyle, ScopeLabel

from linescout_api.gallery import GalleryAsset
from linescout_api.preprocessing import InkStats
from linescout_api.schemas import (
    ScopePrediction,
    SearchGroup,
    SearchMode,
    SearchResult,
)

RELEVANCE_FLOOR = 0.35
BEST_MATCH_SIZE = 8
STYLE_ROW_SIZE = 6
PROVISIONAL_GROUPS = 3
PROVISIONAL_ROW_SIZE = 4
CONFIDENT_THRESHOLD = 0.55

STYLE_TITLES: dict[PrimaryStyle, str] = {
    PrimaryStyle.MANGA_ANIME: "Manga / anime",
    PrimaryStyle.WESTERN_INK: "Western comic / ink",
    PrimaryStyle.REALISTIC_ACADEMIC: "Realistic / academic",
    PrimaryStyle.CARTOON: "Cartoon",
    PrimaryStyle.GESTURE_SKETCH: "Gesture / sketch",
}

SCOPE_TITLES: dict[ScopeLabel, str] = {
    ScopeLabel.EYE: "Possibly an eye",
    ScopeLabel.FACE_HEAD: "Possibly a face or head",
    ScopeLabel.HAIR: "Possibly hair",
    ScopeLabel.HAND: "Possibly a hand",
    ScopeLabel.FOOT: "Possibly a foot",
    ScopeLabel.UPPER_BODY_CLOTHING: "Possibly an upper body",
    ScopeLabel.FULL_BODY: "Possibly a full figure",
    ScopeLabel.MULTI_CHARACTER: "Possibly several characters",
}


def _stable_unit(*parts: object) -> float:
    digest = hashlib.blake2b("\x1f".join(map(str, parts)).encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") / 2**64


def predict_scopes(stats: InkStats, stroke_count: int) -> list[ScopePrediction]:
    """Toy scope estimate from ink extent and stroke count.

    Small, few-stroke marks look like details (eye/hand); large, many-stroke
    drawings look like bodies or compositions. Confidence grows with strokes,
    which produces the provisional -> confident progression the UI needs.
    """
    extent = stats.bbox_diagonal_ratio
    density = stats.coverage
    progress = min(1.0, stroke_count / 12)

    raw: dict[ScopeLabel, float] = {
        ScopeLabel.EYE: max(0.0, 0.9 - extent * 2.2),
        ScopeLabel.FACE_HEAD: max(0.0, 0.8 - abs(extent - 0.35) * 2.0),
        ScopeLabel.HAIR: max(0.0, 0.5 - abs(extent - 0.3) * 1.5) * (0.5 + density * 20),
        ScopeLabel.HAND: max(0.0, 0.7 - extent * 1.8),
        ScopeLabel.FOOT: max(0.0, 0.5 - extent * 1.6),
        ScopeLabel.UPPER_BODY_CLOTHING: max(0.0, 0.7 - abs(extent - 0.5) * 2.0),
        ScopeLabel.FULL_BODY: max(0.0, 0.8 - abs(extent - 0.7) * 2.0),
        ScopeLabel.MULTI_CHARACTER: max(0.0, extent - 0.55)
        * 2.0
        * (0.5 + min(1.0, stroke_count / 20)),
    }
    total = sum(raw.values()) or 1.0
    # Sharpen the distribution as the drawing progresses.
    sharpened = {scope: (value / total) ** (1 + 2 * progress) for scope, value in raw.items()}
    norm = sum(sharpened.values()) or 1.0
    confident_mass = min(0.98, 0.35 + 0.6 * progress)
    predictions = [
        ScopePrediction(label=scope, confidence=round(value / norm * confident_mass, 4))
        for scope, value in sharpened.items()
    ]
    predictions.append(
        ScopePrediction(label=ScopeLabel.UNKNOWN, confidence=round(1 - confident_mass, 4))
    )
    predictions.sort(key=lambda item: item.confidence, reverse=True)
    return predictions


def score_asset(asset: GalleryAsset, predictions: Sequence[ScopePrediction], seed: str) -> float:
    """Scope-compatibility-gated pseudo relevance in [0, 1]."""
    by_label = {item.label: item.confidence for item in predictions}
    scope_fit = max((by_label.get(ScopeLabel(scope), 0.0) for scope in asset.scopes), default=0.0)
    noise = _stable_unit(seed, asset.asset_id)
    return round(
        min(1.0, 0.15 + scope_fit * 0.9 + noise * 0.25) * (0.7 + 0.3 * asset.quality_score), 4
    )


def to_result(asset: GalleryAsset, relevance: float) -> SearchResult:
    """URLs are relative so they work through the Vite proxy and any host."""
    return SearchResult(
        asset_id=asset.asset_id,
        thumbnail_url=f"/api/v1/assets/{asset.asset_id}/thumbnail",
        style=asset.primary_style,
        scopes=[ScopeLabel(scope) for scope in asset.scopes],
        origin=asset.origin,
        relevance=relevance,
        quality=asset.quality_score,
        asset_url=f"/api/v1/assets/{asset.asset_id}/line-art",
    )


def rank(
    assets: Sequence[GalleryAsset],
    stats: InkStats,
    stroke_count: int,
    seed: str,
    row_order: Sequence[PrimaryStyle] = DEFAULT_STYLE_ORDER,
) -> tuple[SearchMode, list[ScopePrediction], list[SearchGroup]]:
    predictions = predict_scopes(stats, stroke_count)
    scored = sorted(
        ((score_asset(asset, predictions, seed), asset) for asset in assets),
        key=lambda pair: (-pair[0], pair[1].asset_id),
    )
    above_floor = [(score, asset) for score, asset in scored if score >= RELEVANCE_FLOOR]

    top = predictions[0]
    if top.label is ScopeLabel.UNKNOWN or top.confidence < CONFIDENT_THRESHOLD:
        groups = _provisional_groups(above_floor, predictions)
        if not groups:
            return SearchMode.INSUFFICIENT, predictions, []
        return SearchMode.PROVISIONAL, predictions, groups

    if not above_floor:
        return SearchMode.INSUFFICIENT, predictions, []

    groups = [
        SearchGroup(
            id="best_match",
            title="Best Match",
            kind="best_match",
            results=[to_result(asset, score) for score, asset in above_floor[:BEST_MATCH_SIZE]],
        )
    ]
    for style in row_order:
        row = [(score, asset) for score, asset in above_floor if asset.primary_style is style][
            :STYLE_ROW_SIZE
        ]
        if row:
            groups.append(
                SearchGroup(
                    id=f"style:{style.value}",
                    title=STYLE_TITLES[style],
                    kind="style",
                    style=style,
                    results=[to_result(asset, score) for score, asset in row],
                )
            )
    return SearchMode.CONFIDENT, predictions, groups


def _provisional_groups(
    above_floor: Sequence[tuple[float, GalleryAsset]],
    predictions: Sequence[ScopePrediction],
) -> list[SearchGroup]:
    groups: list[SearchGroup] = []
    for prediction in predictions:
        if prediction.label is ScopeLabel.UNKNOWN or len(groups) >= PROVISIONAL_GROUPS:
            continue
        row = [
            (score, asset) for score, asset in above_floor if prediction.label.value in asset.scopes
        ][:PROVISIONAL_ROW_SIZE]
        if row:
            groups.append(
                SearchGroup(
                    id=f"scope:{prediction.label.value}",
                    title=SCOPE_TITLES[prediction.label],
                    kind="provisional_scope",
                    scope=prediction.label,
                    results=[to_result(asset, score) for score, asset in row],
                )
            )
    return groups


def order_style_rows(
    selected: PrimaryStyle | None,
    affinities: dict[PrimaryStyle, float],
    learning_enabled: bool,
) -> list[PrimaryStyle]:
    """Spec: explicit style first, then learned affinity, then the fixed default order."""
    default_rank = {style: index for index, style in enumerate(DEFAULT_STYLE_ORDER)}

    def key(style: PrimaryStyle) -> tuple[int, float, int]:
        explicit = 0 if style is selected else 1
        affinity = -affinities.get(style, 0.0) if learning_enabled else 0.0
        return (explicit, affinity, default_rank[style])

    return sorted(DEFAULT_STYLE_ORDER, key=key)
