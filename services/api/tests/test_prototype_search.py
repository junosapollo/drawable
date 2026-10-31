from __future__ import annotations

import asyncio
import hashlib
import json
from time import monotonic
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from test_search import png, search_data

from drawable_api.app import create_app
from drawable_api.prototype_search import PrototypeSearchRuntime, private_file
from drawable_api.search import ParsedSearchRequest, SearchFieldsV1, SearchInputError
from drawable_api.settings import Settings


def parsed(session: str, generation: int) -> ParsedSearchRequest:
    fields = SearchFieldsV1(
        session_id=uuid4() if not session else UUID(session),
        document_id=uuid4(),
        canvas_revision=1,
        query_generation=generation,
        canvas_width=2048,
        canvas_height=2048,
        stroke_count=0,
        point_count=0,
        counts_approximate=False,
        stroke_status="disabled",
        preprocessing_version="drawable-query-v1",
    )
    return ParsedSearchRequest(fields, png(ink=True), None, False)


def test_queue_replaces_same_session_and_bounds_pending_sessions(tmp_path) -> None:
    async def scenario() -> None:
        runtime = PrototypeSearchRuntime(Settings(tmp_path, "real", tmp_path / "metadata.sqlite3"))
        runtime.error = None
        runtime.process = type("AliveProcess", (), {"returncode": None})()
        session = str(uuid4())
        first = asyncio.create_task(runtime.search(parsed(session, 1), started=monotonic()))
        await asyncio.sleep(0)
        second = asyncio.create_task(runtime.search(parsed(session, 2), started=monotonic()))
        await asyncio.sleep(0)
        with pytest.raises(SearchInputError, match="newer drawing"):
            await first
        assert len(runtime.pending) == 1
        assert runtime.pending[session].parsed.fields.query_generation == 2
        other_tasks = [
            asyncio.create_task(runtime.search(parsed(str(uuid4()), 1), started=monotonic()))
            for _ in range(3)
        ]
        await asyncio.sleep(0)
        with pytest.raises(SearchInputError) as full:
            await runtime.search(parsed(str(uuid4()), 1), started=monotonic())
        assert full.value.status_code == 429
        for task in [second, *other_tasks]:
            task.cancel()
        await asyncio.gather(second, *other_tasks, return_exceptions=True)
        assert not runtime.pending
        with pytest.raises(SearchInputError) as expired:
            await runtime.search(parsed(str(uuid4()), 1), started=monotonic() - 11)
        assert expired.value.status_code == 504
        assert not runtime.pending

    asyncio.run(scenario())


def test_prototype_search_requires_local_origin_and_keeps_missing_setup_honest(tmp_path) -> None:
    settings = Settings(tmp_path, "real", tmp_path / "metadata.sqlite3", local_prototype_mode=True)
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8000") as client:
        assert client.get("/api/v1/health").json()["ready"] is False
        assert client.get("/api/v1/ready").status_code == 503
        bad_origin = client.post(
            "/api/v1/search",
            data=search_data(),
            files={"image": ("query.png", png(ink=True), "image/png")},
        )
        assert bad_origin.status_code == 403
        headers = {"Origin": "http://127.0.0.1:8000"}
        blank = client.post(
            "/api/v1/search",
            headers=headers,
            data=search_data(),
            files={"image": ("query.png", png(ink=False), "image/png")},
        )
        assert blank.status_code == 200
        assert blank.json()["mode"] == "insufficient"
        ink = client.post(
            "/api/v1/search",
            headers=headers,
            data=search_data(),
            files={"image": ("query.png", png(ink=True), "image/png")},
        )
        assert ink.status_code == 503
        assert ink.json()["error"]["code"] == "search_not_configured"
        assert str(tmp_path) not in ink.text


def test_preview_paths_reject_symlinks_and_traversal(tmp_path) -> None:
    image = tmp_path / "image.png"
    image.write_bytes(png(ink=True))
    assert private_file(tmp_path, "image.png") == image
    try:
        (tmp_path / "alias.png").symlink_to(image)
        symlink_created = True
    except OSError:
        symlink_created = False
    for relative in ("alias.png", "../image.png", "/image.png", "sub/../image.png"):
        if relative == "alias.png" and not symlink_created:
            continue
        with pytest.raises(ValueError):
            private_file(tmp_path, relative)


def test_stale_v2_reference_preview_fails_closed_and_requests_withdrawal(tmp_path) -> None:
    build_id = "prototype-" + "a" * 24
    asset_id = "reference-stale-test"
    original = png(ink=True)
    image_path = tmp_path / "reference.png"
    image_path.write_bytes(original + b"changed")
    item = SimpleNamespace(
        asset_id=asset_id,
        asset_revision=1,
        byte_length=len(original),
        media_type="image/png",
        relative_path="reference.png",
        sha256=hashlib.sha256(original).hexdigest(),
    )
    gallery_id = "gallery-stale-test"
    availability = {
        "schema_version": 1,
        "catalog_id": gallery_id,
        "revision": 1,
        "items": {
            asset_id: {"sha256": item.sha256, "reviewed_revision": item.asset_revision}
        },
    }
    availability_path = tmp_path / "prototype/search/availability.json"
    availability_path.parent.mkdir(parents=True)
    availability_path.write_text(json.dumps(availability))
    pointer_path = tmp_path / "prototype/search/active.json"
    pointer_path.write_text(
        json.dumps(
            {
                "build_id": build_id,
                "availability_path": "prototype/search/availability.json",
                "availability_sha256": hashlib.sha256(availability_path.read_bytes()).hexdigest(),
            }
        )
    )

    runtime = PrototypeSearchRuntime(Settings(tmp_path, "real", tmp_path / "metadata.sqlite3"))
    runtime.error = None
    runtime.process = SimpleNamespace(returncode=None)
    runtime.status = {"build_id": build_id}
    runtime.catalog_id = gallery_id
    runtime.assets = {asset_id: item}
    runtime._build_assets[build_id] = (runtime.assets, gallery_id)
    withdrawn: list[str] = []
    runtime._withdraw_changed_reference = withdrawn.append

    with pytest.raises(ValueError, match="Reference bytes changed"):
        runtime.preview(asset_id, build_id)
    assert withdrawn == [asset_id]
