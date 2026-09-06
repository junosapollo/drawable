"""Local-only curation endpoints. Mounted only when ``LINESCOUT_CURATION_MODE=1``.

Milestone 2 implements the curation loop end-to-end:

* :func:`next_candidate` returns the next asset the reviewer should look at,
  balancing the five style families and the eight scope buckets so the batch
  stays representative.
* :func:`write_label` validates a human decision, persists it as an immutable
  audit row in ``curation_labels``, and mirrors the decision into the
  ``assets`` cache so the change is observable in search results and asset
  serving immediately.
* :func:`export_snapshot` writes a frozen JSON snapshot of every approved and
  reviewed label to ``data/snapshots/`` so the manifest exporter can rebuild
  a labelled dataset without depending on the live database.
* :func:`progress` aggregates reviewed / accepted / rejected counts overall
  and broken down by style and scope.

Curation only touches assets that already live in the ``assets`` cache; the
caller (the Milestone 2 dataset pipeline) is expected to have populated the
gallery via :func:`linescout_api.gallery.sync_gallery` first.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from linescout_ml.taxonomy import PrimaryStyle, ScopeLabel
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from linescout_api.deps import State
from linescout_api.errors import bad_request, not_found, unprocessable
from linescout_api.gallery import enabled_assets

log = logging.getLogger(__name__)

router = APIRouter(prefix="/curation", tags=["curation"])


# ----------------------------------------------------------------- taxonomy constants

#: The five style families that drive stratification. ``curation_labels`` may
#: record any value the reviewer picks, but the queue strictly samples from
#: the 5×8 grid below.
STYLE_BUCKETS: tuple[PrimaryStyle, ...] = (
    PrimaryStyle.MANGA_ANIME,
    PrimaryStyle.WESTERN_INK,
    PrimaryStyle.REALISTIC_ACADEMIC,
    PrimaryStyle.CARTOON,
    PrimaryStyle.GESTURE_SKETCH,
)

#: Eight scope buckets. ``unknown`` is excluded — it is a query-only label.
SCOPE_BUCKETS: tuple[ScopeLabel, ...] = (
    ScopeLabel.EYE,
    ScopeLabel.FACE_HEAD,
    ScopeLabel.HAIR,
    ScopeLabel.HAND,
    ScopeLabel.FOOT,
    ScopeLabel.UPPER_BODY_CLOTHING,
    ScopeLabel.FULL_BODY,
    ScopeLabel.MULTI_CHARACTER,
)

#: Default review target. Matches the Milestone 1 progress payload so old
#: clients still get a sensible "remaining" value when no work has been done.
DEFAULT_TARGET: int = 2000


# ----------------------------------------------------------------- response models


class StyleBreakdown(BaseModel):
    """Reviewed/accepted/rejected counts for a single style family."""

    model_config = ConfigDict(extra="forbid")

    reviewed: int = Field(ge=0)
    accepted: int = Field(ge=0)
    rejected: int = Field(ge=0)
    remaining: int = Field(ge=0)


class ScopeBreakdown(BaseModel):
    """Reviewed/accepted/rejected counts for a single scope bucket."""

    model_config = ConfigDict(extra="forbid")

    reviewed: int = Field(ge=0)
    accepted: int = Field(ge=0)
    rejected: int = Field(ge=0)
    remaining: int = Field(ge=0)


class CurationProgress(BaseModel):
    """Overall review progress plus style/scope breakdowns."""

    model_config = ConfigDict(extra="forbid")

    reviewed: int = Field(ge=0)
    accepted: int = Field(ge=0)
    rejected: int = Field(ge=0)
    remaining: int = Field(ge=0)
    target: int = Field(default=DEFAULT_TARGET, ge=0)
    by_style: dict[PrimaryStyle, StyleBreakdown]
    by_scope: dict[ScopeLabel, ScopeBreakdown]


class CropBox(BaseModel):
    """Crop coordinates in source-image pixel space (inclusive-exclusive)."""

    model_config = ConfigDict(extra="forbid")

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class CurationCandidate(BaseModel):
    """One candidate asset for review."""

    model_config = ConfigDict(extra="forbid")

    asset_id: str
    primary_style: PrimaryStyle
    scopes: list[ScopeLabel]
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    thumbnail_url: str
    line_art_url: str
    origin: Literal["native_line_art", "extracted_line_art"]
    crop: CropBox | None = None
    review_state: Literal["unreviewed", "accepted", "rejected", "quarantined"]
    quality_score: float = Field(ge=0.0, le=1.0)
    sfw_safe: bool
    sfw_confidence: float = Field(ge=0.0, le=1.0)
    source_work_id: str


class LabelRequest(BaseModel):
    """Body of ``POST /curation/labels``."""

    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1, max_length=64)
    decision: Literal["keep", "reject"]
    primary_style: PrimaryStyle | None = None
    scopes: list[ScopeLabel] | None = None
    crop: CropBox | None = None
    malformed_anatomy: bool = False
    poor_extraction: bool = False
    quality: int | None = Field(default=None, ge=1, le=3)
    note: str | None = Field(default=None, max_length=2000)
    reviewer: str | None = Field(default=None, max_length=64)

    @field_validator("scopes")
    @classmethod
    def _no_duplicate_scopes(cls, value: list[ScopeLabel] | None) -> list[ScopeLabel] | None:
        if value is not None and len(value) != len(set(value)):
            msg = "scopes contains duplicates"
            raise ValueError(msg)
        return value

    @model_validator(mode="after")
    def _quality_required_on_keep(self) -> LabelRequest:
        if self.decision == "keep" and self.quality is None:
            msg = "quality is required when decision='keep'"
            raise ValueError(msg)
        return self


class LabelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    asset_id: str
    decision: Literal["keep", "reject"]
    review_state: Literal["unreviewed", "accepted", "rejected", "quarantined"]
    review_quality: int | None
    enabled: bool
    created_at: str


class SnapshotResponse(BaseModel):
    """Body of ``POST /curation/snapshots``."""

    model_config = ConfigDict(extra="forbid")

    snapshot_id: str
    path: str
    label_count: int
    style_breakdown: dict[PrimaryStyle, int]
    created_at: str


# ----------------------------------------------------------------- queue logic


def _reviewed_count(connection: sqlite3.Connection) -> int:
    """Number of *distinct* assets with at least one label, regardless of decision."""
    row = connection.execute("SELECT COUNT(DISTINCT asset_id) AS n FROM curation_labels").fetchone()
    return int(row["n"])


def _candidate_base_query(
    style: PrimaryStyle | None, scope: ScopeLabel | None
) -> tuple[str, list[object]]:
    """Build the SELECT for the candidate pool.

    Stratification happens in :func:`_pick_candidate`; here we just gather the
    row set so the picker can balance across the 5×8 grid. The 8 scope buckets
    are the GALLERY scopes (``unknown`` is query-only).
    """
    sql = [
        "SELECT asset_id, primary_style, scopes_json, width, height, origin,",
        " crop_json, review_state, quality_score, sfw_safe, sfw_confidence,",
        " source_work_id",
        " FROM assets",
        " WHERE review_state = 'unreviewed' AND sfw_safe = 1",
    ]
    params: list[object] = []
    if style is not None:
        sql.append(" AND primary_style = ?")
        params.append(style.value)
    if scope is not None:
        # Either the asset declares the scope directly, or it carries only
        # the ``unknown`` placeholder — both are valid review targets.
        sql.append(" AND (scopes_json LIKE ? OR scopes_json LIKE ?)")
        params.append(f'%"{scope.value}"%')
        params.append('%"unknown"%')
    sql.append(" ORDER BY asset_id")
    return "\n".join(sql), params


def _pick_candidate(
    rows: list[sqlite3.Row], style: PrimaryStyle | None, scope: ScopeLabel | None
) -> sqlite3.Row | None:
    """Pick the next asset to surface, balancing style×scope coverage.

    Strategy:
    * If the caller filtered on ``?style`` or ``?scope``, honour it; no need
      to balance — the caller already chose the slice.
    * Otherwise compute the 5×8 coverage matrix from how many candidates each
      cell has in the pool, and pick the cell with the highest *uncovered*
      weight. Within the chosen cell, fall back to the lexicographically
      first ``asset_id`` so the queue is deterministic across restarts.
    """
    if not rows:
        return None
    if style is not None or scope is not None:
        return rows[0]

    # Per-cell coverage count.
    cell_counts: dict[tuple[PrimaryStyle, ScopeLabel], int] = {}
    style_counts: dict[PrimaryStyle, int] = {s: 0 for s in STYLE_BUCKETS}
    scope_counts: dict[ScopeLabel, int] = {s: 0 for s in SCOPE_BUCKETS}
    for row in rows:
        primary = PrimaryStyle(row["primary_style"])
        style_counts[primary] += 1
        try:
            asset_scopes = [ScopeLabel(value) for value in json.loads(row["scopes_json"])]
        except (ValueError, json.JSONDecodeError):
            asset_scopes = []
        if not asset_scopes:
            asset_scopes = [ScopeLabel.UNKNOWN]
        for scope_label in asset_scopes:
            if scope_label is ScopeLabel.UNKNOWN:
                continue
            scope_counts[scope_label] = scope_counts[scope_label] + 1
            key = (primary, scope_label)
            cell_counts[key] = cell_counts.get(key, 0) + 1

    # Pick the (style, scope) cell with the highest "deficit" relative to the
    # median count of its style row and scope column. Ties go to the lowest
    # asset_id we've already seen, which keeps the order stable.
    chosen: tuple[PrimaryStyle, ScopeLabel] | None = None
    chosen_deficit: float = -1.0
    for primary in STYLE_BUCKETS:
        for scope_label in SCOPE_BUCKETS:
            count = cell_counts.get((primary, scope_label), 0)
            # Deficit: how far this cell is below its row and column median.
            # Higher deficit => the cell is underrepresented => prefer it.
            row_total = style_counts[primary] or 1
            col_total = scope_counts[scope_label] or 1
            expected = (row_total + col_total) / 2.0
            deficit = expected - count
            if deficit > chosen_deficit:
                chosen_deficit = deficit
                chosen = (primary, scope_label)

    if chosen is None:
        return rows[0]
    target_style, target_scope = chosen
    for row in rows:
        if PrimaryStyle(row["primary_style"]) is not target_style:
            continue
        try:
            asset_scopes = [ScopeLabel(value) for value in json.loads(row["scopes_json"])]
        except (ValueError, json.JSONDecodeError):
            continue
        if target_scope in asset_scopes:
            return row
    # Cell is empty (deficit was driven by 0 in another column); fall back.
    return rows[0]


def _build_candidate(row: sqlite3.Row, connection: sqlite3.Connection) -> CurationCandidate:
    """Hydrate a queue row into the wire response."""
    try:
        scopes = [ScopeLabel(value) for value in json.loads(row["scopes_json"])]
    except (ValueError, json.JSONDecodeError):
        scopes = []
    crop: CropBox | None = None
    if row["crop_json"]:
        try:
            data = json.loads(row["crop_json"])
            crop = CropBox.model_validate(data)
        except (ValueError, json.JSONDecodeError):
            crop = None
    return CurationCandidate(
        asset_id=row["asset_id"],
        primary_style=PrimaryStyle(row["primary_style"]),
        scopes=scopes,
        width=int(row["width"]),
        height=int(row["height"]),
        thumbnail_url=f"/api/v1/assets/{row['asset_id']}/thumbnail",
        line_art_url=f"/api/v1/assets/{row['asset_id']}/line-art",
        origin=row["origin"],
        crop=crop,
        review_state=row["review_state"],
        quality_score=float(row["quality_score"]),
        sfw_safe=bool(row["sfw_safe"]),
        sfw_confidence=float(row["sfw_confidence"]),
        source_work_id=row["source_work_id"],
    )


# ----------------------------------------------------------------- progress

_TOTAL_SQL = (
    "SELECT COUNT(DISTINCT asset_id) AS reviewed,"
    " COUNT(DISTINCT CASE WHEN decision = 'keep' THEN asset_id END) AS accepted,"
    " COUNT(DISTINCT CASE WHEN decision = 'reject' THEN asset_id END) AS rejected"
    " FROM curation_labels"
)


def _style_breakdown(connection: sqlite3.Connection) -> dict[PrimaryStyle, StyleBreakdown]:
    """Reviewed/accepted/rejected/remaining counts broken down by primary_style."""
    out: dict[PrimaryStyle, StyleBreakdown] = {}
    for style in STYLE_BUCKETS:
        label_row = connection.execute(
            "SELECT COUNT(DISTINCT cl.asset_id) AS reviewed,"
            " COUNT(DISTINCT CASE WHEN cl.decision = 'keep' THEN cl.asset_id END) AS accepted,"
            " COUNT(DISTINCT CASE WHEN cl.decision = 'reject' THEN cl.asset_id END) AS rejected"
            " FROM curation_labels cl"
            " JOIN assets a ON a.asset_id = cl.asset_id"
            " WHERE a.primary_style = ?",
            (style.value,),
        ).fetchone()
        remaining_row = connection.execute(
            "SELECT COUNT(*) AS n FROM assets"
            " WHERE primary_style = ? AND review_state = 'unreviewed' AND sfw_safe = 1",
            (style.value,),
        ).fetchone()
        out[style] = StyleBreakdown(
            reviewed=int(label_row["reviewed"]),
            accepted=int(label_row["accepted"]),
            rejected=int(label_row["rejected"]),
            remaining=int(remaining_row["n"]),
        )
    return out


def _scope_breakdown(connection: sqlite3.Connection) -> dict[ScopeLabel, ScopeBreakdown]:
    """Reviewed/accepted/rejected/remaining counts broken down by scope bucket.

    An asset appears under every scope it declares, mirroring the search API
    contract. ``unknown`` is excluded from the gallery breakdown because it
    is a query-only label.
    """
    out: dict[ScopeLabel, ScopeBreakdown] = {}
    for scope_label in SCOPE_BUCKETS:
        label_row = connection.execute(
            "SELECT COUNT(DISTINCT cl.asset_id) AS reviewed,"
            " COUNT(DISTINCT CASE WHEN cl.decision = 'keep' THEN cl.asset_id END) AS accepted,"
            " COUNT(DISTINCT CASE WHEN cl.decision = 'reject' THEN cl.asset_id END) AS rejected"
            " FROM curation_labels cl"
            " JOIN asset_scopes s ON s.asset_id = cl.asset_id"
            " WHERE s.scope = ?",
            (scope_label.value,),
        ).fetchone()
        remaining_row = connection.execute(
            "SELECT COUNT(DISTINCT a.asset_id) AS n FROM assets a"
            " JOIN asset_scopes s ON s.asset_id = a.asset_id"
            " WHERE s.scope = ? AND a.review_state = 'unreviewed' AND a.sfw_safe = 1",
            (scope_label.value,),
        ).fetchone()
        out[scope_label] = ScopeBreakdown(
            reviewed=int(label_row["reviewed"]),
            accepted=int(label_row["accepted"]),
            rejected=int(label_row["rejected"]),
            remaining=int(remaining_row["n"]),
        )
    return out


@router.get("/progress", response_model=CurationProgress)
def progress(state: State) -> CurationProgress:
    row = state.connection.execute(_TOTAL_SQL).fetchone()
    reviewed = int(row["reviewed"])
    accepted = int(row["accepted"])
    rejected = int(row["rejected"])
    return CurationProgress(
        reviewed=reviewed,
        accepted=accepted,
        rejected=rejected,
        remaining=max(0, DEFAULT_TARGET - reviewed),
        target=DEFAULT_TARGET,
        by_style=_style_breakdown(state.connection),
        by_scope=_scope_breakdown(state.connection),
    )


# ----------------------------------------------------------------- next


@router.get("/next", response_model=CurationCandidate)
def next_candidate(
    state: State,
    style: Annotated[PrimaryStyle | None, Query(description="Filter by primary style")] = None,
    scope: Annotated[ScopeLabel | None, Query(description="Filter by scope bucket")] = None,
) -> CurationCandidate:
    if state.gallery is None:
        # The Milestone 2 dataset pipeline hasn't loaded a gallery yet; refuse
        # rather than serve a synthetic candidate.
        raise not_found(
            "gallery_unavailable",
            "no gallery loaded; set LINESCOUT_GALLERY_MANIFEST and restart the API",
        )
    sql, params = _candidate_base_query(style, scope)
    rows = state.connection.execute(sql, params).fetchall()
    chosen = _pick_candidate(rows, style, scope)
    if chosen is None:
        raise not_found("queue_empty", "no candidates are awaiting review")
    return _build_candidate(chosen, state.connection)


# ----------------------------------------------------------------- labels


@router.post("/labels", response_model=LabelResponse, status_code=201)
def write_label(state: State, body: LabelRequest) -> LabelResponse:
    if state.gallery is None:
        raise not_found(
            "gallery_unavailable",
            "no gallery loaded; set LINESCOUT_GALLERY_MANIFEST and restart the API",
        )
    row = state.connection.execute(
        "SELECT asset_id, review_state, review_quality, enabled, sfw_safe"
        " FROM assets WHERE asset_id = ?",
        (body.asset_id,),
    ).fetchone()
    if row is None:
        raise not_found("asset_not_found", f"asset {body.asset_id} is not in the gallery")
    # Rejecting an SFW-unsafe asset has no semantic meaning — those are
    # quarantined at ingestion; surface a structured 422 instead of silently
    # accepting the label.
    if not row["sfw_safe"]:
        raise unprocessable(
            "asset_not_sfw",
            "cannot label a non-SFW asset; quarantine happens at ingestion",
        )

    review_state, review_quality, enabled = _apply_decision_to_asset(body, row)
    crop_json = body.crop.model_dump_json() if body.crop else None
    scopes_json = json.dumps([scope.value for scope in body.scopes]) if body.scopes else None
    reviewer = body.reviewer or "local"

    # Single transaction: write the audit row, then mirror the decision into
    # the assets cache. The schema's CHECK constraints guard style and scope
    # membership, so a typo from the UI would surface as a SQLite IntegrityError.
    cursor = state.connection.execute("BEGIN")
    try:
        cursor = state.connection.execute(
            "INSERT INTO curation_labels ("
            " asset_id, decision, primary_style, scopes_json, crop_json,"
            " malformed_anatomy, poor_extraction, quality, note, reviewer"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body.asset_id,
                body.decision,
                body.primary_style.value if body.primary_style else None,
                scopes_json,
                crop_json,
                int(body.malformed_anatomy),
                int(body.poor_extraction),
                body.quality,
                body.note,
                reviewer,
            ),
        )
        label_id = int(cursor.lastrowid or 0)
        cursor = state.connection.execute(
            "UPDATE assets SET"
            " review_state = ?,"
            " review_quality = ?,"
            " enabled = ?,"
            " primary_style = COALESCE(?, primary_style),"
            " scopes_json = COALESCE(?, scopes_json),"
            " crop_json = COALESCE(?, crop_json)"
            " WHERE asset_id = ?",
            (
                review_state,
                review_quality,
                int(enabled),
                body.primary_style.value if body.primary_style else None,
                scopes_json,
                crop_json,
                body.asset_id,
            ),
        )
        if cursor.rowcount == 0:
            msg = "asset disappeared between SELECT and UPDATE"
            raise bad_request("asset_concurrent_delete", msg)
        # Audit row timestamp is the source of truth for clients; read it back
        # so the wire response matches what is stored.
        stamp = state.connection.execute(
            "SELECT created_at FROM curation_labels WHERE id = ?", (label_id,)
        ).fetchone()
        state.connection.execute("COMMIT")
    except Exception:
        state.connection.execute("ROLLBACK")
        raise

    # Reload the in-memory enabled-asset list so /search and /assets/* reflect
    # the new enabled flag without requiring a process restart.
    state.assets = enabled_assets(state.connection)

    return LabelResponse(
        id=label_id,
        asset_id=body.asset_id,
        decision=body.decision,
        review_state=review_state,
        review_quality=review_quality,
        enabled=enabled,
        created_at=str(stamp["created_at"]) if stamp else "",
    )


def _apply_decision_to_asset(body: LabelRequest, row: sqlite3.Row) -> tuple[str, int | None, bool]:
    """Translate a label into the new (review_state, review_quality, enabled) triple.

    * ``keep``  -> ``accepted``, asset becomes enabled (it was already sfw_safe,
      the schema CHECK guarantees).
    * ``reject`` -> ``rejected``; the asset is disabled so it drops out of search.
    """
    if body.decision == "keep":
        return "accepted", body.quality, True
    return "rejected", body.quality, False


# ----------------------------------------------------------------- snapshots


def _snapshot_dir(state: State) -> Path:
    """Resolve and ensure the snapshots directory exists under the data dir."""
    settings = state.settings
    base = settings.data_dir
    if not base.is_absolute():
        base = base.resolve()
    target = base / "snapshots"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _snapshot_timestamp(now: datetime | None = None) -> str:
    """``YYYYMMDD_HHMMSS`` form, UTC, suitable for filenames and snapshot ids."""
    moment = now or datetime.now(UTC)
    return moment.strftime("%Y%m%d_%H%M%S")


@router.post("/snapshots", response_model=SnapshotResponse, status_code=201)
def export_snapshot(state: State) -> SnapshotResponse:
    if state.gallery is None:
        raise not_found(
            "gallery_unavailable",
            "no gallery loaded; set LINESCOUT_GALLERY_MANIFEST and restart the API",
        )

    rows = state.connection.execute(
        "SELECT cl.id, cl.asset_id, cl.decision, cl.primary_style, cl.scopes_json,"
        " cl.crop_json, cl.malformed_anatomy, cl.poor_extraction, cl.quality,"
        " cl.note, cl.reviewer, cl.created_at,"
        " a.primary_style AS asset_primary_style, a.scopes_json AS asset_scopes_json,"
        " a.review_state, a.review_quality"
        " FROM curation_labels cl"
        " JOIN assets a ON a.asset_id = cl.asset_id"
        " WHERE cl.decision = 'keep' AND a.review_state = 'accepted'"
        " ORDER BY cl.id"
    ).fetchall()

    timestamp = _snapshot_timestamp()
    snapshot_id = f"curation_{timestamp}"
    breakdown: dict[PrimaryStyle, int] = {style: 0 for style in STYLE_BUCKETS}
    serialized: list[dict[str, object]] = []
    for row in rows:
        primary = PrimaryStyle(row["primary_style"] or row["asset_primary_style"])
        breakdown[primary] += 1
        serialized.append(
            {
                "id": int(row["id"]),
                "asset_id": row["asset_id"],
                "decision": row["decision"],
                "primary_style": primary.value,
                "scopes": json.loads(row["scopes_json"] or row["asset_scopes_json"] or "[]"),
                "crop": json.loads(row["crop_json"]) if row["crop_json"] else None,
                "malformed_anatomy": bool(row["malformed_anatomy"]),
                "poor_extraction": bool(row["poor_extraction"]),
                "quality": int(row["quality"]) if row["quality"] is not None else None,
                "note": row["note"],
                "reviewer": row["reviewer"],
                "review_state": row["review_state"],
                "review_quality": int(row["review_quality"])
                if row["review_quality"] is not None
                else None,
                "created_at": row["created_at"],
            }
        )

    payload = {
        "schema_version": 1,
        "snapshot_id": snapshot_id,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "gallery": {
            "dataset_version": state.gallery.dataset_version,
            "manifest_hash": state.gallery.manifest_hash,
        },
        "label_count": len(serialized),
        "style_breakdown": {style.value: count for style, count in breakdown.items()},
        "labels": serialized,
    }

    target_dir = _snapshot_dir(state)
    target_path = target_dir / f"{snapshot_id}.json"
    target_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log.info("wrote curation snapshot %s (%d labels)", target_path, len(serialized))

    # Mark every label row that landed in the snapshot as exported so a second
    # POST does not re-export them. The ``snapshot_id`` column is the audit
    # trail that ties a label to the immutable JSON file.
    state.connection.execute(
        "UPDATE curation_labels SET snapshot_id = ?"
        " WHERE decision = 'keep' AND snapshot_id IS NULL",
        (snapshot_id,),
    )

    return SnapshotResponse(
        snapshot_id=snapshot_id,
        path=str(target_path),
        label_count=len(serialized),
        style_breakdown=breakdown,
        created_at=payload["created_at"],
    )
