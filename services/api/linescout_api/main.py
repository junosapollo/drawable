"""FastAPI application factory and Uvicorn entry point.

Run one worker only: model weights (Milestone 4) live in GPU memory and GPU
inference is serialised through ``AppState.inference_lock``.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from linescout_api import __version__
from linescout_api.config import Settings, get_settings
from linescout_api.errors import (
    ApiError,
    api_error_handler,
    http_error_handler,
    validation_error_handler,
)
from linescout_api.routers import assets, curation, events, health, preferences, search
from linescout_api.state import build_state

log = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        state = build_state(settings)
        app.state.linescout = state
        log.info(
            "LineScout API %s | device=%s%s | gallery=%s (%d assets) | ready=%s | fixture=%s",
            __version__,
            state.device.kind,
            f" ({state.device.gpu_name}, {state.device.vram_total_mb} MB)"
            if state.device.is_cuda
            else "",
            state.gallery.dataset_version if state.gallery else "none",
            len(state.assets),
            state.ready,
            settings.fixture_mode,
        )
        for warning in state.warnings:
            log.warning(warning)
        if state.setup_error:
            log.error("SETUP ERROR: %s", state.setup_error)
        try:
            yield
        finally:
            state.connection.close()

    app = FastAPI(
        title="LineScout API",
        version=__version__,
        description="Local line-art reference retrieval for character artists.",
        lifespan=lifespan,
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["*"],
    )
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(HTTPException, http_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)

    prefix = "/api/v1"
    app.include_router(health.router, prefix=prefix)
    app.include_router(search.router, prefix=prefix)
    app.include_router(events.router, prefix=prefix)
    app.include_router(preferences.router, prefix=prefix)
    app.include_router(assets.router, prefix=prefix)
    if settings.curation_mode:
        app.include_router(curation.router, prefix=prefix)
    return app


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "linescout_api.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=1,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    run()
