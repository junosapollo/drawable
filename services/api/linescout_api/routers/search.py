"""``POST /api/v1/search`` — multipart contract validation and (fixture) retrieval."""

from __future__ import annotations

import time
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, Form, UploadFile
from linescout_ml.taxonomy import PrimaryStyle

from linescout_api import fixture_ranker
from linescout_api.deps import State
from linescout_api.errors import bad_request, too_large, unprocessable
from linescout_api.preferences import compute_affinities, read_preferences
from linescout_api.preprocessing import (
    SnapshotError,
    decode_snapshot,
    decode_strokes,
    ink_stats,
    is_insufficient,
)
from linescout_api.schemas import (
    ScopePrediction,
    SearchMode,
    SearchResponse,
    SearchTiming,
    StyleSelection,
)
from linescout_api.state import AppState

router = APIRouter(tags=["search"])

SUPPORTED_CANVAS_MIN = 256
SUPPORTED_CANVAS_MAX = 8192


def _raise_snapshot_error(error: SnapshotError, field: str) -> None:
    if error.code.endswith("too_large"):
        raise too_large(error.code, error.message, field)
    if error.code in ("image_dimensions", "image_format"):
        raise unprocessable(error.code, error.message, field)
    raise bad_request(error.code, error.message, field)


@router.post(
    "/search",
    response_model=SearchResponse,
    responses={
        400: {"description": "Malformed image or strokes"},
        413: {"description": "Body too large"},
        422: {"description": "Invalid field"},
    },
)
async def search(
    state: State,
    session_id: Annotated[UUID, Form()],
    revision: Annotated[int, Form(ge=1)],
    canvas_width: Annotated[int, Form(ge=SUPPORTED_CANVAS_MIN, le=SUPPORTED_CANVAS_MAX)],
    canvas_height: Annotated[int, Form(ge=SUPPORTED_CANVAS_MIN, le=SUPPORTED_CANVAS_MAX)],
    stroke_count: Annotated[int, Form(ge=0)],
    point_count: Annotated[int, Form(ge=0)],
    image: Annotated[UploadFile, File()],
    strokes: Annotated[UploadFile | None, File()] = None,
    text_hint: Annotated[str | None, Form()] = None,
    selected_style: Annotated[StyleSelection | None, Form()] = None,
) -> SearchResponse:
    settings = state.settings
    started = time.perf_counter()

    if text_hint is not None and len(text_hint) > settings.max_text_hint_chars:
        raise unprocessable(
            "text_hint_too_long",
            f"text_hint exceeds {settings.max_text_hint_chars} characters",
            "text_hint",
        )

    # Read with a hard cap so an oversized upload never fully buffers.
    image_bytes = await image.read(settings.max_image_bytes + 1)
    if len(image_bytes) > settings.max_image_bytes:
        raise too_large(
            "image_too_large", f"image exceeds {settings.max_image_bytes} bytes", "image"
        )
    strokes_bytes = (
        await strokes.read(settings.max_strokes_bytes + 1) if strokes is not None else None
    )
    if strokes_bytes is not None and len(strokes_bytes) > settings.max_strokes_bytes:
        raise too_large(
            "strokes_too_large", f"strokes exceed {settings.max_strokes_bytes} bytes", "strokes"
        )

    try:
        gray = decode_snapshot(image_bytes, settings.max_image_bytes)
    except SnapshotError as error:
        _raise_snapshot_error(error, "image")
    try:
        stroke_sequence = decode_strokes(strokes_bytes, settings.max_strokes_bytes)
    except SnapshotError as error:
        _raise_snapshot_error(error, "strokes")

    if stroke_sequence is not None and len(stroke_sequence.strokes) != stroke_count:
        raise unprocessable(
            "stroke_count_mismatch",
            "stroke_count does not match the strokes payload",
            "stroke_count",
        )

    stats = ink_stats(gray)
    preprocessing_ms = (time.perf_counter() - started) * 1000

    def timing(
        embedding: float = 0.0, retrieval: float = 0.0, reranking: float = 0.0
    ) -> SearchTiming:
        return SearchTiming(
            preprocessing_ms=round(preprocessing_ms, 3),
            embedding_ms=round(embedding, 3),
            retrieval_ms=round(retrieval, 3),
            reranking_ms=round(reranking, 3),
            total_ms=round((time.perf_counter() - started) * 1000, 3),
        )

    if is_insufficient(
        stats, point_count, settings.min_points_for_search, settings.min_ink_diagonal_ratio
    ):
        response = SearchResponse(
            revision=revision,
            mode=SearchMode.INSUFFICIENT,
            scope_predictions=[],
            groups=[],
            timing=timing(),
        )
        _log_search(state, session_id, response, stroke_count, point_count)
        return response

    if not state.ready:
        raise unprocessable("not_ready", state.setup_error or "the API is not ready", None)

    # Row order: explicit style from the request overrides the stored preference for this response.
    stored_selected, learning_enabled = read_preferences(state.connection)
    explicit: PrimaryStyle | None
    if selected_style is None:
        explicit = stored_selected
    elif selected_style is StyleSelection.ALL:
        explicit = None
    else:
        explicit = PrimaryStyle(selected_style.value)
    affinities = compute_affinities(state.connection, settings.preference_half_life_days)
    row_order = fixture_ranker.order_style_rows(explicit, affinities, learning_enabled)

    retrieval_started = time.perf_counter()
    async with state.inference_lock:
        mode, predictions, groups = fixture_ranker.rank(
            state.assets,
            stats,
            stroke_count,
            seed=f"{session_id}:{stroke_count}:{stats.bbox}",
            row_order=row_order,
        )
    retrieval_ms = (time.perf_counter() - retrieval_started) * 1000

    warning = None
    if not state.assets:
        warning = "gallery is empty; no references available"
    elif state.settings.fixture_mode:
        warning = "fixture results: retrieval models are not loaded"
    elif not state.device.is_cuda:
        warning = "CPU fallback — slower search"

    response = SearchResponse(
        revision=revision,
        mode=mode,
        scope_predictions=_top_predictions(predictions),
        groups=groups,
        timing=timing(retrieval=retrieval_ms),
        warning=warning,
    )
    _log_search(state, session_id, response, stroke_count, point_count)
    return response


def _top_predictions(predictions: list[ScopePrediction], limit: int = 4) -> list[ScopePrediction]:
    return predictions[:limit]


def _log_search(
    state: AppState, session_id: UUID, response: SearchResponse, stroke_count: int, point_count: int
) -> None:
    t = response.timing
    state.connection.execute(
        "INSERT INTO search_log(session_id, revision, mode, stroke_count, point_count,"
        " preprocessing_ms, embedding_ms, retrieval_ms, reranking_ms, total_ms)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            str(session_id),
            response.revision,
            response.mode.value,
            stroke_count,
            point_count,
            t.preprocessing_ms,
            t.embedding_ms,
            t.retrieval_ms,
            t.reranking_ms,
            t.total_ms,
        ),
    )
