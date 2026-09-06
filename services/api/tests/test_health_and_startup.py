from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from linescout_api.config import DevicePolicy
from linescout_api.db import connect, list_migrations, migrate, schema_version, split_statements
from linescout_api.device import detect_device
from linescout_api.main import create_app
from tests.conftest import SYNTHETIC_MANIFEST, make_settings


def test_health_reports_every_spec_field(client: TestClient) -> None:
    body = client.get("/api/v1/health").json()
    for key in (
        "ready",
        "cuda_available",
        "device",
        "gpu_name",
        "models",
        "dataset_version",
        "index_version",
        "gallery_size",
        "disabled_branches",
        "warmup",
        "warnings",
    ):
        assert key in body, key
    assert body["ready"] is True
    assert body["fixture_mode"] is True
    assert body["gallery_size"] == 23  # 24 synthetic records, one disabled
    assert body["dataset_version"] == "2026.09.06-synthetic"
    assert body["schema_version"] >= 1
    assert {model["name"] for model in body["models"]} == {
        "semantic",
        "structural",
        "stroke",
        "scope",
        "pose",
    }


def test_cpu_fallback_is_reported_not_fatal(tmp_path: Path) -> None:
    info = detect_device(DevicePolicy.AUTO)
    # The CI/sandbox machine has no CUDA; the API must still come up with a warning.
    if not info.cuda_available:
        with TestClient(create_app(make_settings(tmp_path))) as client:
            body = client.get("/api/v1/health").json()
            assert body["device"] == "cpu"
            assert body["ready"] is True
            assert any("CPU fallback" in warning for warning in body["warnings"])


def test_forced_cuda_without_gpu_fails_readiness(tmp_path: Path) -> None:
    info = detect_device(DevicePolicy.CUDA)
    if info.cuda_available:
        return  # nothing to assert on a GPU machine
    with TestClient(create_app(make_settings(tmp_path, device=DevicePolicy.CUDA))) as client:
        body = client.get("/api/v1/health").json()
        assert body["ready"] is False
        assert body["device"] == "cpu"


def test_missing_manifest_fails_readiness_with_setup_error(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, gallery_manifest=tmp_path / "nope" / "manifest.json")
    with TestClient(create_app(settings)) as client:
        body = client.get("/api/v1/health").json()
        assert body["ready"] is False
        assert body["gallery_size"] == 0
        assert "manifest not found" in body["warnings"][0]


def test_invalid_manifest_fails_readiness(tmp_path: Path) -> None:
    data = json.loads(SYNTHETIC_MANIFEST.read_text(encoding="utf-8"))
    data["records"][0]["sfw"]["safe"] = False  # enabled + unsafe is a hard violation
    broken = tmp_path / "manifest.json"
    broken.write_text(json.dumps(data), encoding="utf-8")
    with TestClient(create_app(make_settings(tmp_path, gallery_manifest=broken))) as client:
        body = client.get("/api/v1/health").json()
        assert body["ready"] is False
        assert "failed validation" in body["warnings"][0]


def test_no_manifest_in_fixture_mode_is_ready_but_empty(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(tmp_path, gallery_manifest=None))) as client:
        body = client.get("/api/v1/health").json()
        assert body["ready"] is True
        assert body["gallery_size"] == 0
        assert body["dataset_version"] is None


def test_fixture_mode_defaults_to_the_synthetic_gallery(tmp_path: Path) -> None:
    from linescout_api.config import SYNTHETIC_MANIFEST, Settings

    settings = Settings(_env_file=None, db_path=tmp_path / "d.sqlite3")  # type: ignore[call-arg]
    assert settings.gallery_manifest == SYNTHETIC_MANIFEST
    assert Settings(_env_file=None, gallery_manifest="").gallery_manifest is None  # type: ignore[call-arg]
    assert Settings(_env_file=None, fixture_mode=False).gallery_manifest is None  # type: ignore[call-arg]
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/health").json()["gallery_size"] == 23


def test_migrations_are_idempotent_and_wal(tmp_path: Path) -> None:
    connection = connect(tmp_path / "m.sqlite3")
    first = migrate(connection)
    assert first == [name for _, name, _ in list_migrations()]
    assert migrate(connection) == []
    assert schema_version(connection) == len(first)
    assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    tables = {
        row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "assets",
        "asset_scopes",
        "events",
        "preferences",
        "curation_labels",
        "search_log",
        "gallery_versions",
    } <= tables
    connection.close()


def test_split_statements_respects_semicolons_in_literals() -> None:
    sql = (
        "CREATE TABLE t (a TEXT CHECK (a IN ('x;y', 'z')));\n"
        "-- comment; with semicolon\n"
        "INSERT INTO t VALUES ('a;b');\n"
    )
    statements = split_statements(sql)
    assert len(statements) == 2
    assert statements[0].startswith("CREATE TABLE")
    assert statements[1].startswith("INSERT")


def test_gallery_reload_is_skipped_when_hash_unchanged(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings)):
        pass
    with TestClient(create_app(settings)) as client:
        connection = connect(settings.db_path)
        loaded = connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
        assert loaded == 24
        assert connection.execute("SELECT COUNT(*) FROM asset_scopes").fetchone()[0] > 24
        assert client.get("/api/v1/health").json()["gallery_size"] == 23
        connection.close()


def test_manifest_ids_and_sqlite_ids_are_one_to_one(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings)):
        manifest = json.loads(SYNTHETIC_MANIFEST.read_text(encoding="utf-8"))
        connection = connect(settings.db_path)
        db_ids = {row[0] for row in connection.execute("SELECT asset_id FROM assets")}
        assert db_ids == {record["asset_id"] for record in manifest["records"]}
        connection.close()


def test_sqlite_refuses_enabled_unsafe_assets(tmp_path: Path) -> None:
    import sqlite3

    import pytest

    connection = connect(tmp_path / "c.sqlite3")
    migrate(connection)
    with pytest.raises(sqlite3.IntegrityError):
        columns = (
            "asset_id, source_dataset, source_item_id, source_work_id, license_id,"
            " original_path, line_art_path, thumbnail_path, origin, primary_style, scopes_json,"
            " person_count, sfw_safe, sfw_confidence, sfw_method, width, height, text_coverage,"
            " ink_coverage, phash, quality_score, review_state, split, enabled, pipeline_version,"
            " checksum"
        )
        values = (
            "ls_x_0000000000000000",
            "s",
            "i",
            "w",
            "l",
            "o",
            "l",
            "t",
            "native_line_art",
            "cartoon",
            '["eye"]',
            1,
            0,
            0.9,
            "manual",
            300,
            300,
            0,
            0.1,
            "0000000000000000",
            0.5,
            "accepted",
            "train",
            1,
            "p",
            "a" * 64,
        )
        placeholders = ",".join("?" * len(values))
        connection.execute(f"INSERT INTO assets ({columns}) VALUES ({placeholders})", values)  # noqa: S608
    connection.close()
