"""Serve thumbnails and trace-compatible line art for *enabled* gallery assets only."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from fastapi.responses import FileResponse

from linescout_api.deps import State
from linescout_api.errors import not_found
from linescout_api.gallery import asset_file

router = APIRouter(tags=["assets"])

_KINDS: dict[str, Literal["thumbnail", "line_art"]] = {
    "thumbnail": "thumbnail",
    "line-art": "line_art",
}


@router.get("/assets/{asset_id}/{kind}", response_class=FileResponse)
def get_asset_file(state: State, asset_id: str, kind: str) -> FileResponse:
    if kind not in _KINDS or state.gallery is None:
        raise not_found("asset_not_found", "asset not found")
    relative = asset_file(state.connection, asset_id, _KINDS[kind])
    if relative is None:
        raise not_found("asset_not_found", "asset not found")
    path = (state.gallery.data_root / relative).resolve()
    if state.gallery.data_root.resolve() not in path.parents or not path.is_file():
        # Corrupt/missing gallery asset: disable it so it drops out of future responses.
        state.connection.execute("UPDATE assets SET enabled = 0 WHERE asset_id = ?", (asset_id,))
        state.assets = [asset for asset in state.assets if asset.asset_id != asset_id]
        raise not_found("asset_unavailable", "asset file is missing and has been disabled")
    return FileResponse(
        path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400, immutable"}
    )
