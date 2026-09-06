"""Local-only curation endpoints. Mounted only when ``LINESCOUT_CURATION_MODE=1``.

Milestone 1 ships the surface and the progress query so the gate "do not
expose these endpoints when the API is started without CURATION_MODE" is
testable now. Candidate queueing, label writes, and snapshot export are
Milestone 2 work and return 501 until then.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from linescout_api.deps import State
from linescout_api.errors import ApiError

router = APIRouter(prefix="/curation", tags=["curation"])


class CurationProgress(BaseModel):
    reviewed: int
    accepted: int
    rejected: int
    remaining: int
    target: int = 2000


@router.get("/progress", response_model=CurationProgress)
def progress(state: State) -> CurationProgress:
    row = state.connection.execute(
        "SELECT"
        " COUNT(DISTINCT asset_id) AS reviewed,"
        " COUNT(DISTINCT CASE WHEN decision = 'keep' THEN asset_id END) AS accepted,"
        " COUNT(DISTINCT CASE WHEN decision = 'reject' THEN asset_id END) AS rejected"
        " FROM curation_labels"
    ).fetchone()
    reviewed = int(row["reviewed"])
    return CurationProgress(
        reviewed=reviewed,
        accepted=int(row["accepted"]),
        rejected=int(row["rejected"]),
        remaining=max(0, 2000 - reviewed),
    )


def _not_implemented() -> ApiError:
    return ApiError(501, "not_implemented", "available in Milestone 2")


@router.get("/next")
def next_candidate(state: State) -> None:
    raise _not_implemented()


@router.post("/labels")
def write_label(state: State) -> None:
    raise _not_implemented()


@router.post("/snapshots")
def export_snapshot(state: State) -> None:
    raise _not_implemented()
