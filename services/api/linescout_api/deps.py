"""FastAPI dependencies."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request

from linescout_api.state import AppState


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.linescout
    return state


State = Annotated[AppState, Depends(get_state)]
