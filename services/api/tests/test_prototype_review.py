from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from drawable_research_contracts import CurationSnapshotV1, validate_curation_snapshot_files
from fastapi.testclient import TestClient
from PIL import Image

from drawable_api.app import create_app
from drawable_api.curation import authorized_preview_path
from drawable_api.database import connect, migrate
from drawable_api.intake import IntakeError
from drawable_api.prototype_review import PROTOTYPE_AUTHORIZATION, prepare_prototype_batch
from drawable_api.settings import Settings

ORIGIN = {"Origin": "http://127.0.0.1:5173"}


def prototype_settings(root: Path) -> Settings:
    for work in ("hero", "lma_test", "pirate"):
        for clip in ("clip-a", "clip-b"):
            folder = root / "AnitaDataset" / work / "sketch" / clip
            folder.mkdir(parents=True)
            for frame in range(3):
                Image.new("RGB", (256, 256), "white").save(folder / f"{frame:04}.png")
    return Settings(root, "fixture", root / "prototype" / "metadata.sqlite3", curation_mode=True, local_prototype_mode=True)


def review_payload(candidate: dict) -> dict:
    metadata = candidate["metadata"]
    return {
        "expected_revision": candidate["revision"],
        "reviewer_id": "owner-local",
        "idempotency_key": str(uuid4()),
        "decision": "keep",
        "rights_status": "review_required",
        "license_id": metadata["license_id"],
        "attribution_text": metadata["attribution_text"],
        "use_permissions": metadata["use_permissions"],
        "learning_split": "pilot_development",
        "labels": {
            "style": "cartoon", "primary_scope": "face_head", "secondary_scopes": [],
            "person_count": 1, "sfw": "safe", "quality": 3, "character_useful": True,
            "text_coverage": 0, "clipped": False, "damaged": False, "duplicate_of": None,
            "review_seconds": 1, "keep_reject_reason": "Useful prototype reference.",
        },
        "note": "Local educational image review.",
    }


def test_real_local_review_crop_and_snapshot_without_terms_forms(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = prototype_settings(tmp_path)
    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: pytest.fail("Prototype review must reuse local images"))
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8000") as client:
        items = client.get("/api/v1/curation/candidates").json()["items"]
        assert len(items) == 18
        assert all(item["preview_available"] for item in items)
        assert all(item["metadata"]["authorization_basis"] == PROTOTYPE_AUTHORIZATION for item in items)
        candidate = items[0]
        preview = client.get(f"/api/v1/curation/assets/{candidate['asset_id']}/preview")
        assert preview.status_code == 200
        assert preview.headers["content-type"] == "image/png"

        crop = client.post(f"/api/v1/curation/assets/{candidate['asset_id']}/crops", headers=ORIGIN, json={
            "expected_revision": candidate["revision"], "reviewer_id": "owner-local",
            "idempotency_key": str(uuid4()), "x": 0, "y": 0, "width": 0.5, "height": 0.5,
        })
        assert crop.status_code == 200, crop.text
        assert client.get(f"/api/v1/curation/assets/{crop.json()['asset_id']}/preview").status_code == 200

        response = client.post(f"/api/v1/curation/assets/{candidate['asset_id']}/review", headers=ORIGIN, json=review_payload(candidate))
        assert response.status_code == 200, response.text
        kept = client.get("/api/v1/curation/candidates?state=candidate").json()["items"]
        assert kept[0]["metadata"]["rights_status"] == "review_required"
        assert kept[0]["metadata"]["gallery_eligible_candidate"] is True
        rubric = client.get("/api/v1/curation/rubric/viewpoint").json()
        response = client.post("/api/v1/curation/snapshots", headers=ORIGIN, json={
            "expected_rubric_sha256": rubric["rubric_sha256"], "requester_id": "owner-local",
            "idempotency_key": str(uuid4()), "asset_ids": [candidate["asset_id"]],
        })
        assert response.status_code == 200, response.text
        snapshot_path = tmp_path / "reports" / "private" / "curation-snapshots" / f"{response.json()['snapshot_id']}.json"
        snapshot = CurationSnapshotV1.model_validate_json(snapshot_path.read_bytes())
        assert snapshot.purpose == "local-educational-prototype"
        assert snapshot.items[0].terms_snapshot_sha256 is None
        assert validate_curation_snapshot_files(snapshot, tmp_path)["items"] == 1
        document = json.loads(snapshot_path.read_text())
        document["purpose"] = "pilot-development-review-only"
        with pytest.raises(ValueError, match="prototype snapshot"):
            CurationSnapshotV1.model_validate_json(json.dumps(document))
        assert client.get("/api/v1/setup").json()["selected_sources"][0]["decision"] == "review_required"

    with TestClient(create_app(settings), base_url="http://127.0.0.1:8000") as client:
        assert client.get("/api/v1/curation/progress").json()["reviewed"] == 1
        assert client.get("/api/v1/curation/candidates?state=candidate").json()["items"][0]["asset_id"] == candidate["asset_id"]

    assert not (tmp_path / "metadata.sqlite3").exists()
    with pytest.raises(PermissionError):
        authorized_preview_path(replace(settings, local_prototype_mode=False), candidate["asset_id"])


def test_prototype_batch_is_bounded_repeatable_and_retains_reviews(tmp_path: Path) -> None:
    settings = prototype_settings(tmp_path)
    migrate(settings.metadata_db)
    assert prepare_prototype_batch(settings, limit=2)["imported"] == 2
    assert prepare_prototype_batch(settings, reuse_pending=True)["imported"] == 0
    assert prepare_prototype_batch(settings, limit=2)["imported"] == 2
    db = connect(settings.metadata_db)
    try:
        rows = db.execute("SELECT * FROM assets ORDER BY relative_path").fetchall()
        assert len(rows) == 4
        metadata = json.loads(rows[0]["metadata_json"])
        path = tmp_path / metadata["relative_root"] / rows[0]["relative_path"]
        path.write_bytes(b"changed after cataloging")
        with pytest.raises(IntakeError, match="bytes changed"):
            authorized_preview_path(settings, rows[0]["asset_id"])
        db.execute("UPDATE assets SET state = 'locked_test' WHERE asset_id = ?", (rows[1]["asset_id"],))
        with pytest.raises(LookupError):
            authorized_preview_path(settings, rows[1]["asset_id"])
    finally:
        db.close()


def test_prototype_batch_rejects_symbolic_links(tmp_path: Path) -> None:
    settings = prototype_settings(tmp_path)
    migrate(settings.metadata_db)
    try:
        (tmp_path / "AnitaDataset" / "hero" / "sketch" / "outside").symlink_to(tmp_path, target_is_directory=True)
    except OSError as err:
        pytest.skip(f"Symbolic links not permitted in this OS environment: {err}")
    with pytest.raises(IntakeError, match="symbolic links"):
        prepare_prototype_batch(settings)
