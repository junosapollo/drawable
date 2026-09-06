from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from linescout_api.main import create_app
from tests.conftest import make_settings


def test_curation_routes_absent_without_curation_mode(client: TestClient) -> None:
    assert client.get("/api/v1/curation/progress").status_code == 404
    assert client.get("/api/v1/curation/next").status_code == 404
    assert client.post("/api/v1/curation/labels").status_code == 404
    paths = client.get("/api/v1/openapi.json").json()["paths"]
    assert not any(path.startswith("/api/v1/curation") for path in paths)
    assert client.get("/api/v1/health").json()["curation_enabled"] is False


def test_curation_routes_present_with_curation_mode(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(tmp_path, curation_mode=True))) as client:
        assert client.get("/api/v1/health").json()["curation_enabled"] is True
        progress = client.get("/api/v1/curation/progress")
        assert progress.status_code == 200
        body = progress.json()
        # Top-level counters stay the same shape so existing clients still work.
        assert body["reviewed"] == 0
        assert body["accepted"] == 0
        assert body["rejected"] == 0
        assert body["remaining"] == 2000
        assert body["target"] == 2000
        # Milestone 2 adds per-style and per-scope breakdowns (the gate
        # test only asserts presence; the detailed values are covered in
        # test_curation.py).
        assert set(body["by_style"]) == {
            "manga_anime",
            "western_ink",
            "realistic_academic",
            "cartoon",
            "gesture_sketch",
        }
        assert set(body["by_scope"]) == {
            "eye",
            "face_head",
            "hair",
            "hand",
            "foot",
            "upper_body_clothing",
            "full_body",
            "multi_character",
        }
        for payload in body["by_style"].values():
            assert payload == {
                "reviewed": 0,
                "accepted": 0,
                "rejected": 0,
                "remaining": 0,
            }
        for payload in body["by_scope"].values():
            assert payload == {
                "reviewed": 0,
                "accepted": 0,
                "rejected": 0,
                "remaining": 0,
            }
