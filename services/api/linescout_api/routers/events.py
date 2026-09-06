from __future__ import annotations

from fastapi import APIRouter

from linescout_api.deps import State
from linescout_api.schemas import EventRequest, EventResponse

router = APIRouter(tags=["events"])


@router.post("/events", response_model=EventResponse, status_code=201)
def record_event(state: State, body: EventRequest) -> EventResponse:
    """Record an interaction. The timestamp is generated server-side."""
    cursor = state.connection.execute(
        "INSERT INTO events(session_id, asset_id, event, style, query_revision) VALUES (?,?,?,?,?)"
        " RETURNING id, created_at",
        (
            str(body.session_id),
            body.asset_id,
            body.event.value,
            body.style.value,
            body.query_revision,
        ),
    )
    row = cursor.fetchone()
    return EventResponse(id=int(row["id"]), created_at=str(row["created_at"]))
