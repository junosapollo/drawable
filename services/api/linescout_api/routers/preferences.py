from __future__ import annotations

from fastapi import APIRouter

from linescout_api import fixture_ranker
from linescout_api.deps import State
from linescout_api.preferences import (
    affinities_response,
    compute_affinities,
    read_preferences,
    write_preferences,
)
from linescout_api.schemas import PreferencesResponse, PreferencesUpdate
from linescout_api.state import AppState

router = APIRouter(tags=["preferences"])


def _snapshot(state: AppState) -> PreferencesResponse:
    selected, learning_enabled = read_preferences(state.connection)
    affinities = compute_affinities(state.connection, state.settings.preference_half_life_days)
    return PreferencesResponse(
        selected_style=selected,
        learning_enabled=learning_enabled,
        affinities=affinities_response(affinities),
        row_order=fixture_ranker.order_style_rows(selected, affinities, learning_enabled),
    )


@router.get("/preferences", response_model=PreferencesResponse)
def get_preferences(state: State) -> PreferencesResponse:
    return _snapshot(state)


@router.put("/preferences", response_model=PreferencesResponse)
def update_preferences(state: State, body: PreferencesUpdate) -> PreferencesResponse:
    write_preferences(
        state.connection,
        selected_style=body.selected_style,
        clear_selected_style=body.clear_selected_style,
        learning_enabled=body.learning_enabled,
        reset_affinities=body.reset_affinities,
    )
    return _snapshot(state)
