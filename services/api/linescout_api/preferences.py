"""Local, account-free style preference learning.

Event weights: open 1, pin 3, trace 4. Affinity per style is the Laplace-smoothed
share of exponentially decayed weight (30-day half-life). Preferences only
control style-row order; they never touch relevance or Best Match.
"""

from __future__ import annotations

import math
import sqlite3
from datetime import UTC, datetime

from linescout_ml.taxonomy import PrimaryStyle

from linescout_api.schemas import InteractionEvent, StyleAffinity

EVENT_WEIGHTS: dict[InteractionEvent, float] = {
    InteractionEvent.OPEN: 1.0,
    InteractionEvent.PIN: 3.0,
    InteractionEvent.UNPIN: -3.0,  # undo a pin's contribution
    InteractionEvent.TRACE: 4.0,
}
LAPLACE_ALPHA = 1.0


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def compute_affinities(
    connection: sqlite3.Connection,
    half_life_days: float,
    now: datetime | None = None,
) -> dict[PrimaryStyle, float]:
    now = now or datetime.now(UTC)
    prefs = connection.execute("SELECT affinity_reset_at FROM preferences WHERE id = 1").fetchone()
    reset_at = prefs["affinity_reset_at"] if prefs else None

    query = "SELECT style, event, created_at FROM events"
    params: tuple[object, ...] = ()
    if reset_at:
        query += " WHERE created_at > ?"
        params = (reset_at,)

    decay = math.log(2) / max(half_life_days, 1e-6)
    weights: dict[PrimaryStyle, float] = dict.fromkeys(PrimaryStyle, 0.0)
    for row in connection.execute(query, params):
        try:
            style = PrimaryStyle(row["style"])
            event = InteractionEvent(row["event"])
        except ValueError:
            continue
        age_days = max(0.0, (now - _parse_ts(row["created_at"])).total_seconds() / 86400)
        weights[style] += EVENT_WEIGHTS[event] * math.exp(-decay * age_days)

    clipped = {style: max(0.0, weight) for style, weight in weights.items()}
    total = sum(clipped.values()) + LAPLACE_ALPHA * len(PrimaryStyle)
    return {style: (clipped[style] + LAPLACE_ALPHA) / total for style in PrimaryStyle}


def affinities_response(affinities: dict[PrimaryStyle, float]) -> list[StyleAffinity]:
    return [
        StyleAffinity(style=style, affinity=round(value, 4)) for style, value in affinities.items()
    ]


def read_preferences(connection: sqlite3.Connection) -> tuple[PrimaryStyle | None, bool]:
    row = connection.execute(
        "SELECT selected_style, learning_enabled FROM preferences WHERE id = 1"
    ).fetchone()
    selected = PrimaryStyle(row["selected_style"]) if row and row["selected_style"] else None
    return selected, bool(row["learning_enabled"]) if row else True


def write_preferences(
    connection: sqlite3.Connection,
    *,
    selected_style: PrimaryStyle | None = None,
    clear_selected_style: bool = False,
    learning_enabled: bool | None = None,
    reset_affinities: bool = False,
) -> None:
    updates: list[str] = []
    params: list[object] = []
    if clear_selected_style:
        updates.append("selected_style = NULL")
    elif selected_style is not None:
        updates.append("selected_style = ?")
        params.append(selected_style.value)
    if learning_enabled is not None:
        updates.append("learning_enabled = ?")
        params.append(int(learning_enabled))
    if reset_affinities:
        updates.append("affinity_reset_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    if not updates:
        return
    updates.append("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    connection.execute(f"UPDATE preferences SET {', '.join(updates)} WHERE id = 1", params)  # noqa: S608
