from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import sqlite3
import warnings
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from drawable_api.app import create_app
from drawable_api.catalog import catalog_manifest
from drawable_api.cli import main as cli_main
from drawable_api.curation import create_crop_asset, create_curation_snapshot, review_asset
from drawable_api.database import SCHEMA_VERSION, connect, migrate
from drawable_api.emoreccom_map import (
    approve_book_mapping,
    create_book_mapping_template,
    fetch_official_book_index,
)
from drawable_api.intake import (
    REPOSITORY_ROOT,
    IntakeError,
    audit_sources,
    build_data_package,
    build_tree_manifest,
    capture_terms_snapshot,
    extract_verified_archive,
    inspect_zip,
    load_registry,
    sha256_file,
    validate_emoreccom,
    write_json_atomic,
)
from drawable_api.museum import fetch_museum_candidates, refresh_museum_manifest
from drawable_api.readiness import build_training_readiness
from drawable_api.review_workspace import ReviewWorkspace
from drawable_api.sampling import build_pilot_yield_sample
from drawable_api.schemas import CurationCropRequest, CurationReviewRequest, CurationSnapshotRequest
from drawable_api.settings import Settings


def make_archive(path: Path, entries: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, body in entries.items():
            archive.writestr(name, body)


def make_test_registry(path: Path, root: Path) -> dict:
    registry = copy.deepcopy(load_registry())
    registry["sources"] = [registry["sources"][0]]
    registry["sources"][0].update(
        download_url="https://github.com/zhenglinpan/AnitaDataset/archive/main.zip",
        download_hosts=["github.com"],
        archive_path="raw/AnitaDataset.zip",
        extracted_path="legacy-anita",
    )
    write_json_atomic(path, registry)
    return registry


def write_source_profile(
    root: Path,
    registry: dict,
    work_ids: list[str],
    selected_source_ids: set[str] | None = None,
) -> Path:
    evidence_path = root / "manifests" / "profile-acquisition-evidence.json"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text('{"fixture":true}\n', encoding="utf-8")
    evidence = {
        "path": evidence_path.relative_to(root).as_posix(),
        "sha256": sha256_file(evidence_path),
    }
    sources = []
    for source in registry["sources"]:
        if selected_source_ids is not None and source["id"] not in selected_source_ids:
            continue
        selected = {
            "source_id": source["id"],
            "acquisition_method": "official_archive" if source.get("archive_path") else "official_api",
            "work_ids": work_ids if source["id"] == "anita-dataset" else [],
            "operations": ["local_display"],
            "acquisition_evidence": [] if source.get("archive_path") else [evidence],
        }
        sources.append(selected)
    profile = root.parent / "source-selection-profile.json"
    profile.write_text(
        json.dumps({"schema_version": 1, "profile_id": "pytest-source-scope", "sources": sources}),
        encoding="utf-8",
    )
    return profile


def test_source_reconcile_writes_revisioned_gate_for_selected_api_source(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "private-data"
    root.mkdir()
    profile_path = write_source_profile(
        root,
        load_registry(),
        [],
        selected_source_ids={"aic-open-access"},
    )

    assert (
        cli_main(
            [
                "sources",
                "reconcile",
                "--root",
                str(root),
                "--profile",
                str(profile_path),
            ]
        )
        == 0
    )
    response = json.loads(capsys.readouterr().out)
    gate = json.loads((root / response["gate_report_path"]).read_bytes())

    assert response["status"] == "complete"
    assert response["archives_reconciled"] == 0
    assert gate["schema_version"] == 2
    assert gate["requirements_revision"] == "2026-10-04-practical-r1"
    assert gate["artifact_type"] == "drawable-gate-report"
    assert gate["profile_hashes"]["source_selection"]


def make_approved_test_source(path: Path, root: Path) -> tuple[dict, str]:
    registry = copy.deepcopy(load_registry())
    source = copy.deepcopy(registry["sources"][3])
    source["id"] = "test-open-access"
    source["rights_status"] = "approved"
    permissions = {key: False for key in source["use_permissions"]}
    permissions.update(
        local_display=True, derive=True, training=True, evaluation=True, trace=True, export=True
    )
    source["use_permissions"] = permissions
    terms = b"Test-only terms fixture; no real artwork or source rights are represented."
    terms_hash = hashlib.sha256(terms).hexdigest()
    source["terms_snapshot_sha256"] = terms_hash
    source["terms_review"] = {
        "status": "approved",
        "reviewer_id": "reviewer-test",
        "reviewed_at": "2026-10-03T00:00:00Z",
        "reviewed_sha256": terms_hash,
    }
    registry["sources"] = [source]
    write_json_atomic(path, registry)
    terms_dir = root / "manifests" / "terms" / source["id"]
    terms_dir.mkdir(parents=True, exist_ok=True)
    terms_path = terms_dir / f"{terms_hash}.txt"
    terms_path.write_bytes(terms)
    write_json_atomic(
        terms_dir / f"{terms_hash}.json",
        {
            "source_id": source["id"],
            "sha256": terms_hash,
            "snapshot_path": terms_path.relative_to(root).as_posix(),
        },
    )
    return source, terms_hash


def bind_test_archive_source(
    registry: dict, url: str = "https://github.com/zhenglinpan/AnitaDataset/archive/main.zip"
) -> dict:
    source = registry["sources"][0]
    source.update(download_url=url, download_hosts=["github.com"])
    return source


def make_test_receipt(root: Path, source: dict, archive_path: Path) -> dict:
    return {
        "source_id": source["id"],
        "authority_url": source["authority_url"],
        "requested_url": source["download_url"],
        "final_url": source["download_url"],
        "archive_path": source["archive_path"],
        "byte_length": archive_path.stat().st_size,
        "sha256": sha256_file(archive_path),
        "retrieved_at": "2026-10-03T00:00:00Z",
        "archive_validation": inspect_zip(archive_path),
    }


def test_zip_rejects_traversal_symlinks_and_case_collisions(tmp_path: Path) -> None:
    traversal = tmp_path / "traversal.zip"
    make_archive(traversal, {"../escape.txt": b"x"})
    with pytest.raises(IntakeError, match="traversal"):
        inspect_zip(traversal)

    duplicate = tmp_path / "duplicate.zip"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        make_archive(duplicate, {"A.txt": b"one", "a.TXT": b"two"})
    with pytest.raises(IntakeError, match="duplicate"):
        inspect_zip(duplicate)

    link = tmp_path / "symlink.zip"
    with zipfile.ZipFile(link, "w") as archive:
        info = zipfile.ZipInfo("linked-file")
        info.external_attr = 0o120777 << 16
        archive.writestr(info, "target")
    with pytest.raises(IntakeError, match="symbolic link"):
        inspect_zip(link)


def test_zip_rejects_truncation_and_configured_expansion_limit(tmp_path: Path) -> None:
    oversized = tmp_path / "oversized.zip"
    make_archive(oversized, {"large.txt": b"x" * 2048})
    with pytest.raises(IntakeError, match="expanded-size"):
        inspect_zip(oversized, max_expanded_bytes=1024)

    truncated = tmp_path / "truncated.zip"
    truncated.write_bytes(oversized.read_bytes()[:-9])
    with pytest.raises(IntakeError):
        inspect_zip(truncated)


def test_archive_audit_distinguishes_tree_receipt_and_partial(tmp_path: Path) -> None:
    root = tmp_path / "data"
    source = root / "raw" / "AnitaDataset.zip"
    make_archive(source, {"sketch/one.txt": b"a"})
    (source.parent / "AnitaDataset.zip.part").write_bytes(b"longer stale transfer")
    registry_path = tmp_path / "sources.json"
    registry = make_test_registry(registry_path, root)
    source_record = bind_test_archive_source(registry)
    write_json_atomic(registry_path, registry)
    tree = root / "legacy-anita" / "sketch"
    tree.mkdir(parents=True)
    (tree / "image.txt").write_text("unproven", encoding="utf-8")

    report = audit_sources(root, registry_path=registry_path)
    source_report = report["sources"][0]
    assert source_report["status"] == "archive_present_unverified"
    assert source_report["extracted_tree"]["files"] == 1

    receipt_file = root / "manifests" / "source-receipts" / "anita-dataset.json"
    receipt_file.parent.mkdir(parents=True)
    write_json_atomic(receipt_file, make_test_receipt(root, source_record, source))
    verified = audit_sources(root, registry_path=registry_path)["sources"][0]
    assert verified["status"] == "archive_verified"
    assert verified["archive_validation"]["valid"] is True
    assert registry["sources"][0]["use_permissions"]["cloud_processing"] is False


def test_terms_snapshot_is_content_addressed_and_does_not_promote_rights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    registry_path = tmp_path / "sources.json"
    registry = make_test_registry(registry_path, root)
    bind_test_archive_source(registry)
    write_json_atomic(registry_path, registry)
    body = b"<html><title>Official terms</title></html>"

    class Response(io.BytesIO):
        status = 200

        def __init__(self, content: bytes):
            super().__init__(content)
            self.headers = {"Content-Type": "text/html; charset=utf-8", "ETag": '"terms-v1"'}

        def geturl(self) -> str:
            return "https://github.com/zhenglinpan/AnitaDataset"

        def getcode(self) -> int:
            return self.status

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    monkeypatch.setattr(
        "drawable_api.intake.urllib.request.urlopen", lambda *_args, **_kwargs: Response(body)
    )
    result = capture_terms_snapshot(root, "anita-dataset", registry_path=registry_path)
    snapshot = root / result["snapshot_path"]
    assert snapshot.read_bytes() == body
    assert result["sha256"] == sha256_file(snapshot)
    assert result["review_status"] == "required"
    assert result["permissions_changed"] is False
    assert load_registry(registry_path)["sources"][0]["rights_status"] == "review_required"


def test_archive_acquisition_uses_declared_official_host_and_records_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from drawable_api.intake import acquire_archive

    root = tmp_path / "data"
    registry_path = tmp_path / "sources.json"
    registry = make_test_registry(registry_path, root)
    bind_test_archive_source(registry)
    write_json_atomic(registry_path, registry)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("AnitaDataset-main/sketch/frame.txt", b"sample")
    archive_bytes = buffer.getvalue()

    class Response(io.BytesIO):
        status = 200

        def __init__(self, content: bytes):
            super().__init__(content)
            self.headers = {
                "Content-Type": "application/zip",
                "Content-Length": str(len(content)),
                "ETag": '"zip-v1"',
            }

        def geturl(self) -> str:
            return "https://github.com/zhenglinpan/AnitaDataset/archive/main.zip"

        def getcode(self) -> int:
            return self.status

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    monkeypatch.setattr(
        "drawable_api.intake.urllib.request.urlopen",
        lambda *_args, **_kwargs: Response(archive_bytes),
    )
    receipt = acquire_archive(root, "anita-dataset", registry_path=registry_path)
    archive = root / receipt["archive_path"]
    assert archive.is_file()
    assert receipt["sha256"] == sha256_file(archive)
    assert receipt["archive_validation"]["valid"] is True
    assert not archive.with_name(f"{archive.name}.part").exists()


def test_emoreccom_validation_preserves_rows_and_never_calls_prefixes_verified(
    tmp_path: Path,
) -> None:
    panels = tmp_path / "emoreccom_panels"
    panels.mkdir()
    columns = [
        "filename",
        "body_xmin",
        "body_ymin",
        "body_xmax",
        "body_ymax",
        "face_xmin",
        "face_ymin",
        "face_xmax",
        "face_ymax",
    ]
    row = ["12_1_1.jpg", "0", "0", "10", "10", "2", "2", "5", "5"]
    (tmp_path / "visemocomic_csvs").mkdir()
    for name, filename in (
        ("emoreccom_train.csv", "12_1_1.jpg"),
        ("emoreccom_test.csv", "23_1_1.jpg"),
    ):
        path = tmp_path / "visemocomic_csvs" / name
        path.write_text(
            ",".join(columns) + "\n" + ",".join([filename, *row[1:]]) + "\n", encoding="utf-8"
        )
        (panels / filename).write_bytes(b"panel")
    with (tmp_path / "visemocomic_csvs" / "emoreccom_train.csv").open(
        "a", encoding="utf-8"
    ) as stream:
        stream.write(",".join(["12_1_1.jpg", *row[1:]]) + "\n")

    result = validate_emoreccom(tmp_path)
    assert result["train_rows"] == 2
    assert result["train_unique_panels"] == 1
    assert result["book_identity_verified"] is False
    assert result["status"] == "review_required"


def test_emoreccom_manifest_keeps_all_character_rows_for_a_panel(tmp_path: Path) -> None:
    root = tmp_path / "data"
    panels = root / "emoreccom_panels"
    csv_root = root / "visemocomic_csvs"
    panels.mkdir(parents=True)
    csv_root.mkdir()
    panel_name = "12_1_1.jpg"
    (panels / panel_name).write_bytes(b"fixture panel bytes")
    columns = [
        "Unnamed: 0",
        "filename",
        "body_xmin",
        "body_ymin",
        "body_xmax",
        "body_ymax",
        "face_xmin",
        "face_ymin",
        "face_xmax",
        "face_ymax",
        "ann1_emotions",
        "ann2_emotions",
    ]
    train = csv_root / "emoreccom_train.csv"
    train.write_text(
        ",".join(columns)
        + "\n"
        + "0,12_1_1.jpg,0,0,10,10,2,2,5,5,joy,neutral\n"
        + "1,12_1_1.jpg,0,0,10,10,6,2,9,5,sadness,fear\n",
        encoding="utf-8",
    )
    (csv_root / "emoreccom_test.csv").write_text(
        ",".join(columns) + "\n23,23_1_1.jpg,0,0,10,10,2,2,5,5,neutral,neutral\n",
        encoding="utf-8",
    )
    (panels / "23_1_1.jpg").write_bytes(b"locked test panel bytes")

    result = validate_emoreccom(root)
    assert result["train_rows"] == 2
    assert result["train_unique_panels"] == 1
    assert result["train_multi_character_panels"] == 1
    assert result["test_rows"] == 1
    assert result["test_unique_panels"] == 1

    registry_path = tmp_path / "sources.json"
    registry = copy.deepcopy(load_registry())
    write_json_atomic(registry_path, registry)
    manifest = build_tree_manifest(
        root, "emoreccom-panels", tree_path=panels, registry_path=registry_path
    )
    training_entry = next(
        item for item in manifest["entries"] if item["relative_path"] == panel_name
    )
    assert training_entry["publication_partition"] == "source_train"
    assert len(training_entry["character_annotations"]) == 2
    assert [row["source_row_id"] for row in training_entry["character_annotations"]] == ["0", "1"]
    assert training_entry["character_annotations"][0]["source_fields"]["ann1_emotions"] == "joy"
    assert training_entry["character_annotations"][1]["boxes"]["face"]["xmin"] == 6
    assert training_entry["annotation_source_file"] == "emoreccom_train.csv"
    assert training_entry["book_identity_verified"] is False


def test_emoreccom_cross_partition_panel_overlap_is_rejected(tmp_path: Path) -> None:
    csv_root = tmp_path / "visemocomic_csvs"
    panels = tmp_path / "emoreccom_panels"
    csv_root.mkdir()
    panels.mkdir()
    columns = [
        "filename",
        "body_xmin",
        "body_ymin",
        "body_xmax",
        "body_ymax",
        "face_xmin",
        "face_ymin",
        "face_xmax",
        "face_ymax",
    ]
    row = ["12_1_1.jpg", "0", "0", "10", "10", "2", "2", "5", "5"]
    header = ",".join(columns)
    body = ",".join(row)
    for name in ("emoreccom_train.csv", "emoreccom_test.csv"):
        (csv_root / name).write_text(f"{header}\n{body}\n", encoding="utf-8")
    (panels / row[0]).write_bytes(b"fixture panel bytes")

    result = validate_emoreccom(tmp_path)
    assert result["status"] == "invalid_annotations"
    assert "both official EmoRecCom partitions" in result["error"]


def test_safe_extract_requires_and_binds_official_receipt(tmp_path: Path) -> None:
    root = tmp_path / "data"
    registry_path = tmp_path / "sources.json"
    registry = make_test_registry(registry_path, root)
    source = bind_test_archive_source(registry)
    write_json_atomic(registry_path, registry)
    archive = root / "raw" / "AnitaDataset.zip"
    make_archive(archive, {"sketch/frame.txt": b"source"})
    with pytest.raises(IntakeError, match="receipt"):
        extract_verified_archive(root, "anita-dataset", registry_path=registry_path)
    receipt_file = root / "manifests" / "source-receipts" / "anita-dataset.json"
    invalid_receipt = make_test_receipt(root, source, archive)
    invalid_receipt["sha256"] = "0" * 64
    write_json_atomic(receipt_file, invalid_receipt)
    with pytest.raises(IntakeError, match="Archive receipt"):
        extract_verified_archive(root, "anita-dataset", registry_path=registry_path)
    invalid_receipt["sha256"] = sha256_file(archive)
    write_json_atomic(receipt_file, invalid_receipt)
    result = extract_verified_archive(root, "anita-dataset", registry_path=registry_path)
    assert result["status"] == "extracted_pending_rights_and_review"
    assert (
        root / result["relative_extraction_path"] / "content" / "sketch" / "frame.txt"
    ).read_bytes() == b"source"
    assert not (
        root / result["relative_extraction_path"] / "content" / "extraction-receipt.json"
    ).exists()


def test_manifest_hashes_decodes_and_stays_relative(tmp_path: Path) -> None:
    root = tmp_path / "data"
    tree = root / "legacy-anita" / "sketch"
    tree.mkdir(parents=True)
    Image.new("RGB", (32, 48), color="white").save(tree / "sample.png")
    registry_path = tmp_path / "sources.json"
    make_test_registry(registry_path, root)
    manifest = build_tree_manifest(
        root, "anita-dataset", tree_path=root / "legacy-anita", registry_path=registry_path
    )
    item = manifest["entries"][0]
    assert item["decoder_status"] == "decoded"
    assert (item["width"], item["height"]) == (32, 48)
    assert manifest["relative_root"] == "legacy-anita"
    assert str(root) not in json.dumps(manifest)


def test_manifest_catalog_is_hash_checked_and_test_partitions_stay_hidden(tmp_path: Path) -> None:
    root = tmp_path / "data"
    tree = root / "legacy-anita" / "dogmatism" / "sketch"
    tree.mkdir(parents=True)
    Image.new("RGB", (32, 48), color="white").save(tree / "sample.png")
    registry_path = tmp_path / "sources.json"
    make_test_registry(registry_path, root)
    manifest = build_tree_manifest(
        root, "anita-dataset", tree_path=root / "legacy-anita", registry_path=registry_path
    )
    manifest_path = root / "manifests" / "anita-tree.json"
    write_json_atomic(manifest_path, manifest)
    database_path = root / "metadata.sqlite3"
    result = catalog_manifest(root, database_path, manifest_path, registry_path=registry_path)
    assert result["inserted"] == 1
    assert result["gallery_assets_activated"] == 0
    with connect(database_path) as db:
        asset = db.execute("SELECT state, rights_status, metadata_json FROM assets").fetchone()
    assert asset["state"] == "quarantined"
    assert asset["rights_status"] == "review_required"
    assert str(root) not in asset["metadata_json"]

    metadata = json.loads(asset["metadata_json"])
    members_sha = hashlib.sha256(
        json.dumps(
            [
                {
                    "asset_id": manifest["entries"][0]["asset_id"],
                    "sha256": manifest["entries"][0]["sha256"],
                }
            ],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    with connect(database_path) as db:
        db.execute(
            "INSERT INTO family_split_assignments(assignment_id, source_id, group_id, learning_split, member_count, membership_sha256, reviewer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "family-assignment",
                "anita-dataset",
                metadata["group_id"],
                "pilot_development",
                1,
                members_sha,
                "reviewer",
                "2026-10-01T00:00:00Z",
            ),
        )
    manifest["entries"][0]["group_id"] = f"{metadata['group_id']}-changed"
    write_json_atomic(manifest_path, manifest)
    recataloged = catalog_manifest(root, database_path, manifest_path, registry_path=registry_path)
    assert recataloged["invalidated_family_splits"] == 1
    with connect(database_path) as db:
        assignment = db.execute(
            "SELECT status, invalidation_reason FROM family_split_assignments"
        ).fetchone()
        changed_asset = db.execute(
            "SELECT state, revision FROM assets WHERE asset_id = ?", (metadata["asset_id"],)
        ).fetchone()
    assert assignment["status"] == "invalidated"
    assert assignment["invalidation_reason"] == "source_bytes_or_review_basis_changed"
    assert changed_asset["state"] == "quarantined"
    assert changed_asset["revision"] == 1

    manifest["entries"][0]["byte_length"] += 1
    write_json_atomic(manifest_path, manifest)
    with pytest.raises(IntakeError, match="no longer matches"):
        catalog_manifest(root, database_path, manifest_path, registry_path=registry_path)


def test_local_curation_is_opt_in_revision_safe_and_keeps_review_history(tmp_path: Path) -> None:
    root = tmp_path / "data"
    tree = root / "legacy" / "dogmatism" / "sketch"
    tree.mkdir(parents=True)
    path = tree / "candidate.png"
    Image.new("RGB", (32, 48), color="white").save(path)
    relative_path = "dogmatism/sketch/candidate.png"
    database_path = root / "metadata.sqlite3"
    migrate(database_path)
    settings = Settings(root, "fixture", database_path, True)
    review_workspace = ReviewWorkspace(settings)
    metadata = {
        "relative_root": "legacy",
        "relative_path": relative_path,
        "source_registry_sha256": sha256_file(review_workspace.sources_path),
        "anita_work_terms_sha256": sha256_file(review_workspace.works_path),
        "work_id": "dogmatism",
        "group_id": "anita:artist:anita-artist-test",
        "candidate_type": "sketch",
        "decoder_status": "decoded",
        "license_id": "CC BY-NC-SA 4.0",
        "rights_status": "review_required",
        "use_permissions": {
            key: False
            for key in (
                "local_display",
                "training",
                "evaluation",
                "derive",
                "trace",
                "export",
                "public_demo",
                "redistribute",
                "cloud_storage",
                "cloud_processing",
            )
        },
        "learning_split": "unassigned",
        "gallery_member": False,
    }
    with connect(database_path) as db:
        db.execute(
            "INSERT INTO assets(asset_id, source_id, relative_path, sha256, byte_length, media_type, width, height, group_id, rights_status, state, revision, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "asset-test",
                "anita-dataset",
                relative_path,
                sha256_file(path),
                path.stat().st_size,
                "image/png",
                32,
                48,
                metadata["group_id"],
                "review_required",
                "quarantined",
                0,
                json.dumps(metadata),
            ),
        )
        db.execute(
            "INSERT INTO assets(asset_id, source_id, relative_path, sha256, byte_length, media_type, width, height, group_id, rights_status, state, revision, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "asset-locked",
                "anita-dataset",
                "locked/test.png",
                "0" * 64,
                1,
                "image/png",
                1,
                1,
                "locked:group",
                "review_required",
                "locked_test",
                0,
                json.dumps(
                    {
                        **metadata,
                        "relative_path": "locked/test.png",
                        "learning_split": "source_test_locked",
                    }
                ),
            ),
        )
    settings = Settings(root, "fixture", database_path, True)
    client = TestClient(create_app(settings), base_url="http://127.0.0.1:8000")
    candidates = client.get("/api/v1/curation/candidates?state=all")
    assert candidates.status_code == 200
    assert [item["asset_id"] for item in candidates.json()["items"]] == ["asset-test"]
    assert "relative_path" not in candidates.json()["items"][0]
    assert "relative_root" not in candidates.json()["items"][0]["metadata"]
    assert candidates.json()["items"][0]["preview_available"] is False
    assert client.get("/api/v1/curation/assets/asset-test/preview").status_code == 403
    assert (
        client.get("/api/v1/curation/candidates", headers={"Host": "untrusted.example"}).status_code
        == 403
    )
    body = {
        "expected_revision": 0,
        "reviewer_id": "reviewer-01",
        "idempotency_key": "31bd1847-95b5-447a-bb34-6540183128f2",
        "decision": "keep",
        "rights_status": "review_required",
        "use_permissions": {},
        "learning_split": "unassigned",
        "labels": {
            "style": "manga_anime",
            "primary_scope": "face_head",
            "person_count": 12,
            "sfw": "safe",
            "quality": 2,
            "character_useful": True,
            "text_coverage": 0,
            "clipped": False,
            "damaged": False,
            "review_seconds": 20,
            "keep_reject_reason": "Useful line drawing",
        },
    }
    denied = client.post(
        "/api/v1/curation/assets/asset-test/review",
        json=body,
        headers={"Origin": "https://evil.example"},
    )
    assert denied.status_code == 403
    missing_origin = client.post("/api/v1/curation/assets/asset-test/review", json=body)
    assert missing_origin.status_code == 403
    allowed = client.post(
        "/api/v1/curation/assets/asset-test/review",
        json=body,
        headers={"Origin": "http://127.0.0.1:5173"},
    )
    assert allowed.status_code == 200
    assert allowed.json()["gallery_member"] is False
    replay = client.post(
        "/api/v1/curation/assets/asset-test/review",
        json=body,
        headers={"Origin": "http://127.0.0.1:5173"},
    )
    assert replay.status_code == 200
    assert replay.json()["idempotent_replay"] is True
    history = client.get("/api/v1/curation/assets/asset-test/reviews")
    assert history.status_code == 200
    assert len(history.json()) == 1
    locked = client.post(
        "/api/v1/curation/assets/asset-locked/review",
        json={**body, "idempotency_key": "a038ab9a-1f77-49c1-b06d-5fd90b35553b"},
        headers={"Origin": "http://127.0.0.1:5173"},
    )
    assert locked.status_code == 403
    disabled = TestClient(create_app(Settings(root, "fixture", database_path))).get(
        "/api/v1/curation/candidates"
    )
    assert disabled.status_code == 404


def test_curation_queue_cursor_paginates_and_cannot_be_reused_with_other_filters(
    tmp_path: Path,
) -> None:
    root = tmp_path / "data"
    database = root / "metadata.sqlite3"
    migrate(database)
    with connect(database) as db:
        for asset_id, source_id, relative_path, state, metadata in (
            (
                "asset-a",
                "source-a",
                "a.png",
                "quarantined",
                {"work_id": "work-a", "candidate_type": "sketch"},
            ),
            (
                "asset-b",
                "source-a",
                "b.png",
                "quarantined",
                {"work_id": "work-a", "candidate_type": "sketch"},
            ),
            (
                "asset-c",
                "source-b",
                "c.png",
                "quarantined",
                {"work_id": "work-b", "candidate_type": "panel"},
            ),
            (
                "asset-locked",
                "source-a",
                "locked.png",
                "locked_test",
                {"work_id": "work-a", "candidate_type": "sketch"},
            ),
        ):
            db.execute(
                "INSERT INTO assets(asset_id, source_id, relative_path, sha256, byte_length, state, revision, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    asset_id,
                    source_id,
                    relative_path,
                    hashlib.sha256(asset_id.encode()).hexdigest(),
                    1,
                    state,
                    0,
                    json.dumps(metadata),
                ),
            )
    client = TestClient(
        create_app(Settings(root, "fixture", database, True)), base_url="http://127.0.0.1:8000"
    )
    first = client.get(
        "/api/v1/curation/candidates?state=all&limit=1&source_id=source-a&work_id=work-a"
    )
    assert first.status_code == 200
    assert [row["asset_id"] for row in first.json()["items"]] == ["asset-a"]
    cursor = first.json()["next_cursor"]
    assert cursor
    second = client.get(
        f"/api/v1/curation/candidates?state=all&limit=1&source_id=source-a&work_id=work-a&cursor={cursor}"
    )
    assert second.status_code == 200
    assert [row["asset_id"] for row in second.json()["items"]] == ["asset-b"]
    assert second.json()["next_cursor"] is None
    wrong_filter = client.get(
        f"/api/v1/curation/candidates?state=all&limit=1&source_id=source-b&cursor={cursor}"
    )
    assert wrong_filter.status_code == 422
    assert (
        client.get("/api/v1/curation/candidates?state=all&limit=10").json()["items"][-1]["asset_id"]
        != "asset-locked"
    )


def test_curation_keep_requires_review_labels_but_rejection_can_record_reason_only() -> None:
    shared = {
        "expected_revision": 0,
        "reviewer_id": "reviewer-test",
        "idempotency_key": "be66daf3-af17-436a-b43a-4ea595b5f3b5",
    }
    with pytest.raises(ValueError, match="Keeping an asset requires"):
        CurationReviewRequest(**shared, decision="keep")
    rejected = CurationReviewRequest(**shared, decision="reject", note="Not useful for this pilot.")
    assert rejected.labels is None


def test_aic_museum_intake_is_bounded_hashed_and_quarantined(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    registry_path = tmp_path / "sources.json"
    registry = copy.deepcopy(load_registry())
    write_json_atomic(registry_path, registry)
    png = io.BytesIO()
    Image.new("RGB", (256, 320), (40, 50, 60)).save(png, format="PNG")
    image_bytes = png.getvalue()

    class Response(io.BytesIO):
        def __init__(self, content: bytes, content_type: str, url: str):
            super().__init__(content)
            self.headers = {"Content-Type": content_type}
            self.url = url

        def geturl(self) -> str:
            return self.url

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    def fake_urlopen(request, timeout=30):
        url = request.full_url
        if "/artworks/search?" in url:
            body = {
                "config": {"iiif_url": "https://www.artic.edu/iiif/2"},
                "pagination": {"total": 1},
                "data": [
                    {
                        "id": 321,
                        "title": "Figure study",
                        "artist_display": "Example Artist",
                        "date_display": "1900",
                        "medium": "Graphite on paper",
                        "credit_line": "Test credit",
                        "is_public_domain": True,
                        "image_id": "image-321",
                        "api_link": "https://api.artic.edu/api/v1/artworks/321",
                    }
                ],
            }
            assert request.get_header("Aic-user-agent") == "Drawable academic prototype"
            return Response(
                json.dumps(body).encode(),
                "application/json",
                "https://api.artic.edu/api/v1/artworks/search",
            )
        if "/iiif/2/image-321/" in url:
            return Response(image_bytes, "image/png", url)
        raise AssertionError(f"Unexpected network URL: {url}")

    monkeypatch.setattr("drawable_api.museum.urllib.request.urlopen", fake_urlopen)
    result = fetch_museum_candidates(
        root,
        "aic-open-access",
        queries=["figure drawing"],
        metadata_limit=1,
        image_limit=1,
        registry_path=registry_path,
        sleep=lambda _seconds: None,
    )
    assert result["images_saved"] == 1
    manifest_path = root / result["manifest_path"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry = manifest["entries"][0]
    assert entry["is_public_domain"] is True
    assert entry["rights_status"] == "review_required"
    assert entry["use_permissions"]["local_display"] is False
    assert entry["review_status"] == "pending"
    assert entry["gallery_member"] is False
    assert sha256_file(root / manifest["relative_root"] / entry["relative_path"]) == entry["sha256"]

    source = next(row for row in registry["sources"] if row["id"] == "aic-open-access")
    terms = b"Reviewed AIC terms fixture"
    terms_hash = hashlib.sha256(terms).hexdigest()
    source.update(
        rights_status="approved",
        terms_snapshot_sha256=terms_hash,
        terms_review={
            "status": "approved",
            "reviewer_id": "reviewer-test",
            "reviewed_at": "2026-10-04T00:00:00Z",
            "reviewed_sha256": terms_hash,
        },
    )
    source["use_permissions"].update(local_display=True, derive=True)
    write_json_atomic(registry_path, registry)
    terms_dir = root / "manifests" / "terms" / "aic-open-access"
    terms_dir.mkdir(parents=True)
    terms_file = terms_dir / f"{terms_hash}.txt"
    terms_file.write_bytes(terms)
    write_json_atomic(
        terms_dir / f"{terms_hash}.json",
        {
            "source_id": "aic-open-access",
            "sha256": terms_hash,
            "snapshot_path": terms_file.relative_to(root).as_posix(),
        },
    )
    refreshed = refresh_museum_manifest(root, "aic-open-access", registry_path=registry_path)
    assert refreshed["assets_refreshed"] == 1
    refreshed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    refreshed_entry = refreshed_manifest["entries"][0]
    assert refreshed_entry["rights_status"] == "approved"
    assert refreshed_entry["terms_snapshot_sha256"] == terms_hash
    assert refreshed_entry["use_permissions"]["local_display"] is True
    assert refreshed_entry["review_status"] == "pending"
    assert refreshed_entry["gallery_member"] is False
    assert refreshed_entry["learning_split"] == "unassigned"


def test_emoreccom_official_book_mapping_is_reviewed_and_split_checked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    csv_root = root / "visemocomic_csvs"
    panels = root / "emoreccom_panels"
    csv_root.mkdir(parents=True)
    panels.mkdir()
    columns = [
        "filename",
        "body_xmin",
        "body_ymin",
        "body_xmax",
        "body_ymax",
        "face_xmin",
        "face_ymin",
        "face_xmax",
        "face_ymax",
    ]
    train = csv_root / "emoreccom_train.csv"
    test = csv_root / "emoreccom_test.csv"
    train.write_text(",".join(columns) + "\n12_1_1.jpg,0,0,10,10,2,2,5,5\n", encoding="utf-8")
    test.write_text(",".join(columns) + "\n23_1_1.jpg,0,0,10,10,2,2,5,5\n", encoding="utf-8")
    (panels / "12_1_1.jpg").write_bytes(b"train-panel")
    (panels / "23_1_1.jpg").write_bytes(b"test-panel")
    official_csv = b"comic_no,page_no,panel_no,textbox_no,dialog_or_narration,text,x1,y1,x2,y2\n1,1,1,1,d,example,0,0,1,1\n2,1,1,1,d,example,0,0,1,1\n"

    class Response(io.BytesIO):
        status = 200

        def __init__(self, content: bytes):
            super().__init__(content)
            self.headers = {"Content-Length": str(len(content)), "Content-Type": "text/csv"}

        def geturl(self) -> str:
            return "https://obj.umiacs.umd.edu/comics/COMICS_ocr_file.csv"

        def getcode(self) -> int:
            return self.status

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    monkeypatch.setattr(
        "drawable_api.emoreccom_map.urllib.request.urlopen",
        lambda *_args, **_kwargs: Response(official_csv),
    )
    index_result = fetch_official_book_index(root)
    assert index_result["status"] == "downloaded_and_verified"
    template_path = (
        root
        / create_book_mapping_template(root, Path("manifests/map-template.json"))["template_path"]
    )
    template = json.loads(template_path.read_text(encoding="utf-8"))
    for row in template["mappings"]:
        row["comic_no"] = "1" if row["filename_prefix"] == "12" else "2"
        row["book_title"] = f"COMICS work {row['comic_no']}"
        row["evidence_note"] = (
            "Checked filename against official book metadata and cross-checked partition identity."
        )
    write_json_atomic(template_path, template)
    map_result = approve_book_mapping(
        root,
        template_path,
        root / index_result["index_path"],
        reviewer_id="reviewer-test",
        output_path=Path("manifests/emoreccom-book-map.json"),
    )
    map_path = root / map_result["output_path"]
    assert map_result["train_test_book_overlap"] == 0
    validation = validate_emoreccom(root, book_mapping_path=map_path)
    assert validation["status"] == "validated"
    assert validation["book_identity_verified"] is True
    assert validation["verified_train_book_count"] == 1
    registry_path = tmp_path / "sources.json"
    write_json_atomic(registry_path, copy.deepcopy(load_registry()))
    manifest = build_tree_manifest(
        root,
        "emoreccom-panels",
        tree_path=panels,
        registry_path=registry_path,
        emoreccom_book_map_path=map_path,
    )
    train_entry = next(
        entry for entry in manifest["entries"] if entry["relative_path"] == "12_1_1.jpg"
    )
    test_entry = next(
        entry for entry in manifest["entries"] if entry["relative_path"] == "23_1_1.jpg"
    )
    assert train_entry["group_id"] == "emoreccom:book:1"
    assert train_entry["book_identity_verified"] is True
    assert test_entry["group_id"] == "emoreccom:book:2"
    assert test_entry["publication_partition"] == "source_test_locked"
    manifest_path = root / "manifests" / "emoreccom-panels-tree.json"
    write_json_atomic(manifest_path, manifest)
    database_path = root / "metadata.sqlite3"
    cataloged = catalog_manifest(root, database_path, manifest_path, registry_path=registry_path)
    assert cataloged["locked_test_assets"] == 1
    with connect(database_path) as db:
        indexed_train = db.execute(
            "SELECT group_id, state, metadata_json FROM assets WHERE relative_path='12_1_1.jpg'"
        ).fetchone()
        indexed_test = db.execute(
            "SELECT group_id, state FROM assets WHERE relative_path='23_1_1.jpg'"
        ).fetchone()
    assert indexed_train["group_id"] == "emoreccom:book:1"
    assert json.loads(indexed_train["metadata_json"])["book_mapping_sha256"]
    assert indexed_test["group_id"] == "emoreccom:book:2"
    assert indexed_test["state"] == "locked_test"
    forged_manifest = {**manifest, "emoreccom_book_map_sha256": "0" * 64}
    forged_path = root / "manifests" / "forged-emoreccom-tree.json"
    write_json_atomic(forged_path, forged_manifest)
    with pytest.raises(IntakeError, match="book-map file no longer matches"):
        catalog_manifest(root, database_path, forged_path, registry_path=registry_path)

    template["mappings"][1]["comic_no"] = template["mappings"][0]["comic_no"]
    write_json_atomic(template_path, template)
    with pytest.raises(IntakeError, match="share an official comic_no"):
        approve_book_mapping(
            root,
            template_path,
            root / index_result["index_path"],
            reviewer_id="reviewer-test",
            output_path=Path("manifests/overlap-map.json"),
        )


def test_manual_crop_is_immutable_idempotent_and_family_split_is_atomic(tmp_path: Path) -> None:
    root = tmp_path / "data"
    image_dir = root / "references"
    image_dir.mkdir(parents=True)
    image_path = image_dir / "parent.png"
    Image.new("RGB", (256, 256), color=(40, 80, 120)).save(image_path)
    second_image_path = image_dir / "parent-2.png"
    Image.new("RGB", (256, 256), color=(40, 80, 120)).save(second_image_path)
    registry_path = tmp_path / "approved-test-sources.json"
    source, terms_hash = make_approved_test_source(registry_path, root)
    registry_hash = sha256_file(registry_path)
    database_path = root / "metadata.sqlite3"
    migrate(database_path)
    source_permissions = source["use_permissions"]
    metadata = {
        "relative_root": "references",
        "source_registry_sha256": registry_hash,
        "decoder_status": "decoded",
        "license_id": "CC0 test fixture",
        "attribution_text": "Synthetic test pixels; no source attribution applies.",
        "rights_status": "approved",
        "terms_snapshot_sha256": terms_hash,
        "use_permissions": source_permissions,
        "learning_split": "unassigned",
        "group_id": "test-work-family-01",
        "book_identity_verified": True,
        "gallery_member": False,
    }
    with connect(database_path) as db:
        for asset_id, name, item_path in (
            ("parent-1", "parent.png", image_path),
            ("parent-2", "parent-2.png", second_image_path),
        ):
            db.execute(
                """INSERT INTO assets(asset_id, source_id, relative_path, sha256, byte_length, media_type, width, height,
                   group_id, rights_status, state, revision, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    asset_id,
                    source["id"],
                    name,
                    sha256_file(item_path),
                    item_path.stat().st_size,
                    "image/png",
                    256,
                    256,
                    metadata["group_id"],
                    "approved",
                    "quarantined",
                    0,
                    json.dumps(metadata),
                ),
            )
    settings = Settings(root, "fixture", database_path, True)
    crop_request = CurationCropRequest(
        expected_revision=0,
        reviewer_id="reviewer-test",
        idempotency_key=UUID("abce7890-21b1-4567-8d89-112233445566"),
        x=0.1,
        y=0.1,
        width=0.5,
        height=0.5,
    )
    crop = create_crop_asset(settings, "parent-1", crop_request, registry_path=registry_path)
    assert (crop.width, crop.height) == (128, 128)
    replay = create_crop_asset(settings, "parent-1", crop_request, registry_path=registry_path)
    assert replay.asset_id == crop.asset_id
    assert replay.idempotent_replay is True
    with connect(database_path) as db:
        crop_row = db.execute(
            "SELECT * FROM assets WHERE asset_id = ?", (crop.asset_id,)
        ).fetchone()
        assert crop_row["state"] == "quarantined"
        crop_metadata = json.loads(crop_row["metadata_json"])
        assert crop_metadata["parent_asset_id"] == "parent-1"
        assert "labels" not in crop_metadata
        assert (
            crop_metadata["crop_rectangle"]["coordinate_space"] == "exif_normalized_parent_pixels"
        )

    from drawable_research_contracts import ViewpointReviewV1

    viewpoint_hash = sha256_file(REPOSITORY_ROOT / "config" / "viewpoint-rubric-v1.json")
    viewpoint = ViewpointReviewV1(
        rubric_sha256=viewpoint_hash,
        review_state="reviewed",
        evidence_basis="visible_crop",
        horizontal_view="three_quarter",
        facing="image_left",
        elevation="level",
        reviewer_id="reviewer-test",
        reviewed_at=datetime.now(UTC),
    )
    review = CurationReviewRequest(
        expected_revision=0,
        reviewer_id="reviewer-test",
        idempotency_key=UUID("132a4410-820a-4f5e-a64a-80e5b1609a44"),
        decision="keep",
        rights_status="approved",
        license_id=metadata["license_id"],
        attribution_text=metadata["attribution_text"],
        terms_snapshot_sha256=terms_hash,
        use_permissions=source_permissions,
        labels={
            "style": "western_ink",
            "primary_scope": "eye",
            "person_count": 1,
            "sfw": "safe",
            "quality": 2,
            "character_useful": True,
            "text_coverage": 0,
            "clipped": False,
            "damaged": False,
            "review_seconds": 30,
            "keep_reject_reason": "Synthetic test candidate is useful.",
        },
        learning_split="pilot_development",
        viewpoint=viewpoint,
    )
    reviewed = review_asset(settings, "parent-1", review, registry_path=registry_path)
    assert reviewed.gallery_eligible_candidate is True
    with connect(database_path) as db:
        siblings = db.execute(
            "SELECT asset_id, revision, metadata_json FROM assets WHERE source_id = ? AND group_id = ?",
            (source["id"], metadata["group_id"]),
        ).fetchall()
        assert len(siblings) == 3
        assert all(
            json.loads(row["metadata_json"])["learning_split"] == "pilot_development"
            for row in siblings
        )
        assert db.execute("SELECT member_count FROM family_split_assignments").fetchone()[0] == 3
        parent_metadata = json.loads(
            db.execute("SELECT metadata_json FROM assets WHERE asset_id = 'parent-1'").fetchone()[0]
        )
        assert parent_metadata["viewpoint"]["horizontal_view"] == "three_quarter"

    later_crop = create_crop_asset(
        settings,
        "parent-1",
        CurationCropRequest(
            expected_revision=1,
            reviewer_id="reviewer-test",
            idempotency_key=UUID("bcde7890-21b1-4567-8d89-112233445566"),
            x=0.0,
            y=0.0,
            width=0.4,
            height=0.4,
        ),
        registry_path=registry_path,
    )
    with connect(database_path) as db:
        assignment = db.execute(
            "SELECT member_count, membership_sha256 FROM family_split_assignments WHERE status='active'"
        ).fetchone()
        family = db.execute(
            "SELECT asset_id, sha256 FROM assets WHERE source_id = ? AND group_id = ? ORDER BY asset_id",
            (source["id"], metadata["group_id"]),
        ).fetchall()
    assert later_crop.asset_id in {row["asset_id"] for row in family}
    expected_membership = hashlib.sha256(
        json.dumps(
            [{"asset_id": row["asset_id"], "sha256": row["sha256"]} for row in family],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert assignment["member_count"] == 4
    assert assignment["membership_sha256"] == expected_membership

    rubric_hash = sha256_file(REPOSITORY_ROOT / "config" / "viewpoint-rubric-v1.json")
    snapshot_request = CurationSnapshotRequest(
        expected_rubric_sha256=rubric_hash,
        requester_id="reviewer-test",
        asset_ids=["parent-1"],
        idempotency_key=UUID("b32a4410-820a-4f5e-a64a-80e5b1609a44"),
    )
    snapshot = create_curation_snapshot(settings, snapshot_request, registry_path=registry_path)
    assert snapshot.item_count == 1
    assert snapshot.training_started is False
    assert snapshot.gallery_activated is False
    snapshot_path = (
        root / "reports" / "private" / "curation-snapshots" / f"{snapshot.snapshot_id}.json"
    )
    assert snapshot_path.is_file()
    if os.name != "nt":
        assert snapshot_path.stat().st_mode & 0o077 == 0
    replayed_snapshot = create_curation_snapshot(
        settings, snapshot_request, registry_path=registry_path
    )
    assert replayed_snapshot.snapshot_id == snapshot.snapshot_id
    assert replayed_snapshot.idempotent_replay is True

    conflicting = review.model_copy(
        update={
            "expected_revision": 1,
            "idempotency_key": UUID("232a4410-820a-4f5e-a64a-80e5b1609a44"),
            "learning_split": "validation",
        }
    )
    with pytest.raises(PermissionError, match="immutable"):
        review_asset(settings, crop.asset_id, conflicting, registry_path=registry_path)


def test_cloud_package_requires_rights_and_cloud_consent(tmp_path: Path) -> None:
    root = tmp_path / "data"
    tree = root / "legacy-anita" / "dogmatism" / "sketch"
    tree.mkdir(parents=True)
    Image.new("RGB", (32, 48), color="white").save(tree / "sample.png")
    archive_path = root / "raw" / "AnitaDataset.zip"
    make_archive(archive_path, {"sample.txt": b"official archive fixture"})
    registry_path = tmp_path / "sources.json"
    registry = make_test_registry(registry_path, root)
    source = bind_test_archive_source(registry)
    terms_bytes = b"official terms reviewed for this isolated test"
    terms_hash = hashlib.sha256(terms_bytes).hexdigest()
    work_terms_path = tmp_path / "anita-work-terms.json"
    source_work_terms = json.loads(
        (Path(__file__).resolve().parents[3] / "config" / "anita-work-terms.json").read_text(
            encoding="utf-8"
        )
    )
    work = source_work_terms["works"][0]
    work.update(
        rights_status="approved",
        reviewer_decision="approved",
        reviewer_id="reviewer-test",
        reviewed_at="2026-10-03T00:00:00Z",
        reviewed_sha256=terms_hash,
        terms_snapshot_sha256=terms_hash,
        attribution_text="Artist, Dogmatism, CC BY-NC-SA 4.0",
    )
    work["use_permissions"].update(
        local_display=True, export=True, cloud_storage=True, cloud_processing=True
    )
    write_json_atomic(work_terms_path, source_work_terms)
    source["terms_snapshot_sha256"] = terms_hash
    write_json_atomic(registry_path, registry)
    manifest = build_tree_manifest(
        root,
        "anita-dataset",
        tree_path=root / "legacy-anita",
        registry_path=registry_path,
        anita_terms_path=work_terms_path,
    )
    manifest["source_archive_sha256"] = sha256_file(archive_path)
    manifest["status"] = "manifest_ready_for_rights_and_human_review"
    item = manifest["entries"][0]
    item["review_status"] = "approved"
    item["gallery_member"] = True
    item["learning_split"] = "pilot_development"
    item["labels"].update(sfw="approved", style="cartoon", primary_scope="face_head", quality=2)
    manifest_path = root / "manifests" / "tree.json"
    write_json_atomic(manifest_path, manifest)
    receipt_path = root / "manifests" / "source-receipts" / "anita-dataset.json"
    write_json_atomic(receipt_path, make_test_receipt(root, source, archive_path))
    terms_dir = root / "manifests" / "terms" / "anita-dataset"
    terms_dir.mkdir(parents=True, exist_ok=True)
    terms_path = terms_dir / f"{terms_hash}.html"
    terms_path.write_bytes(terms_bytes)
    write_json_atomic(
        terms_dir / f"{terms_hash}.json",
        {
            "source_id": "anita-dataset",
            "sha256": terms_hash,
            "snapshot_path": terms_path.relative_to(root).as_posix(),
        },
    )
    with pytest.raises(IntakeError, match="rights plus separate export"):
        build_data_package(
            root,
            manifest_path,
            purpose="inference-readiness",
            out_path=root / "cloud" / "bundle.zip",
            registry_path=registry_path,
            anita_terms_path=work_terms_path,
        )

    source = registry["sources"][0]
    source["rights_status"] = "approved"
    source["terms_review"] = {
        "status": "approved",
        "reviewer_id": "reviewer-test",
        "reviewed_at": "2026-10-03T00:00:00Z",
        "reviewed_sha256": terms_hash,
    }
    source["use_permissions"].update(
        local_display=True, export=True, cloud_storage=True, cloud_processing=True
    )
    write_json_atomic(registry_path, registry)
    manifest["source_registry_sha256"] = sha256_file(registry_path)
    write_json_atomic(manifest_path, manifest)
    bundle_path = root / "cloud" / "bundle.zip"
    result = build_data_package(
        root,
        manifest_path,
        purpose="inference-readiness",
        out_path=bundle_path,
        registry_path=registry_path,
        anita_terms_path=work_terms_path,
    )
    assert result["status"] == "created_pending_owner_transfer"
    with zipfile.ZipFile(bundle_path) as archive:
        metadata = json.loads(archive.read("bundle-manifest.json"))
        assert metadata["training_authorized"] is False
        assert metadata["test_partition_included"] is False
        assert len(metadata["assets"]) == 1


def test_sqlite_migration_and_future_version_guard(tmp_path: Path) -> None:
    database = tmp_path / "metadata.sqlite3"
    assert migrate(database) == SCHEMA_VERSION == 4
    assert migrate(database) == SCHEMA_VERSION
    with sqlite3.connect(database) as connection:
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    with pytest.raises(RuntimeError, match="newer"):
        migrate(database)

    legacy = tmp_path / "legacy-v1.sqlite3"
    with sqlite3.connect(legacy) as connection:
        connection.execute("CREATE TABLE assets(asset_id TEXT PRIMARY KEY)")
        connection.execute("PRAGMA user_version = 1")
    assert migrate(legacy) == SCHEMA_VERSION
    backups = list((tmp_path / "reports" / "private" / "metadata-backups").glob("*.sqlite3"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_sqlite_v2_split_migration_preserves_history_and_allows_reassignment(
    tmp_path: Path,
) -> None:
    database = tmp_path / "metadata-v2.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute("""CREATE TABLE family_split_assignments (
            assignment_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, group_id TEXT NOT NULL,
            learning_split TEXT NOT NULL, member_count INTEGER NOT NULL, membership_sha256 TEXT NOT NULL,
            reviewer_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_id, group_id))""")
        connection.execute(
            "INSERT INTO family_split_assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "old-assignment",
                "anita-dataset",
                "artist-a",
                "pilot_development",
                1,
                "a" * 64,
                "reviewer",
                "2026-10-01T00:00:00Z",
            ),
        )
        connection.execute("PRAGMA user_version = 2")
    assert migrate(database) == SCHEMA_VERSION
    with connect(database) as connection:
        old = connection.execute("SELECT * FROM family_split_assignments").fetchone()
        assert old["assignment_id"] == "old-assignment"
        assert old["status"] == "active"
        connection.execute(
            "UPDATE family_split_assignments SET status='invalidated', invalidated_at=?, invalidation_reason=? WHERE assignment_id=?",
            ("2026-10-04T00:00:00Z", "test_change", "old-assignment"),
        )
        connection.execute(
            "INSERT INTO family_split_assignments(assignment_id, source_id, group_id, learning_split, member_count, membership_sha256, reviewer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "new-assignment",
                "anita-dataset",
                "artist-a",
                "pilot_development",
                1,
                "b" * 64,
                "reviewer",
                "2026-10-04T00:00:01Z",
            ),
        )
        assert (
            connection.execute("SELECT COUNT(*) FROM family_split_assignments").fetchone()[0] == 2
        )


def test_api_is_loopback_local_and_real_readiness_is_honest(tmp_path: Path) -> None:
    fixture_settings = Settings(tmp_path, "fixture", tmp_path / "fixture.sqlite3")
    fixture = TestClient(create_app(fixture_settings))
    response = fixture.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["mode"] == "fixture"
    assert response.headers["x-request-id"] == response.json()["request_id"]
    assert fixture.get("/api/v1/ready").json()["ready"] is True

    real_settings = Settings(tmp_path, "real", tmp_path / "real.sqlite3")
    real = TestClient(create_app(real_settings))
    assert real.get("/api/v1/ready").status_code == 503
    assert real.get("/api/v1/search").status_code == 503


def test_training_readiness_is_evidence_based_no_probe_and_snapshot_is_immutable(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "private-data"
    reports = root / "reports"
    reports.mkdir(parents=True)
    # Mere file presence must not be mistaken for reviewed human/model evidence.
    for name in (
        "source-yield.json",
        "m0-sequences.json",
        "m0-feasibility.json",
        "frozen-retrieval.json",
        "fresh-clone-no-network.json",
    ):
        (reports / name).write_text("{}", encoding="utf-8")
    gallery = root / "manifests" / "gallery-build.json"
    gallery.parent.mkdir(parents=True)
    gallery.write_text("{}", encoding="utf-8")
    splits = root / "manifests" / "sequence-splits.json"
    splits.write_text("{}", encoding="utf-8")

    report = build_training_readiness(root)
    assert report.local_gpu_status == "not_probed"
    assert report.training_authorization == "pending"
    assert report.training_started is False
    assert report.can_request_separate_authorization is False
    assert report.gates["fixed_source_yield_review"].status == "not_measured"
    assert report.gates["approved_pilot_gallery"].status == "not_measured"

    output = "reports/training-readiness.json"
    assert cli_main(["readiness", "report", "--root", str(root), "--output", output]) == 0
    capsys.readouterr()
    snapshot = root / output
    original = snapshot.read_bytes()
    saved = json.loads(original)
    assert saved["trainingAuthorization"] == "pending"
    assert saved["trainingStarted"] is False
    assert saved["local_gpu_status"] == "not_probed"
    assert cli_main(["readiness", "report", "--root", str(root), "--output", output]) == 2
    capsys.readouterr()
    assert snapshot.read_bytes() == original

    assert cli_main(["readiness", "report", "--root", str(root), "--stage", "m0"]) == 0
    m0 = json.loads(capsys.readouterr().out)
    assert m0["stage"] == "m0"
    assert m0["status"] == "blocked"
    assert m0["training_authorized"] is False
    assert "official_archive_reconciliation" in m0["blockers"]


def test_pilot_yield_sampler_is_deterministic_policy_gated_and_never_activates_gallery(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "private-data"
    registry = load_registry()
    work_ids = [row["folder_id"] for row in json.loads(
        (REPOSITORY_ROOT / "config" / "anita-work-terms.json").read_text(encoding="utf-8")
    )["works"]]
    profile_path = write_source_profile(root, registry, work_ids)
    report = build_pilot_yield_sample(root, profile_path=profile_path)
    assert report["recipe_id"] == "pilot-v1"
    assert report["status"] == "blocked"
    assert report["selected_count"] == 0
    assert report["selected"] == []
    assert report["human_review_required"] is True
    assert report["gallery_activation"] is False
    assert report["training_authorization"] == "pending"
    assert len(report["sources"]) == len(registry["sources"])
    anita = next(item for item in report["sources"] if item["source_id"] == "anita-dataset")
    assert "source_manifest_missing_or_invalid" in anita["blockers"]

    output = "reports/source-yield-sample.json"
    assert (
        cli_main(
            ["data", "sample", "--root", str(root), "--profile", str(profile_path), "--recipe", "pilot-v1", "--output", output]
        )
        == 0
    )
    capsys.readouterr()
    snapshot = root / output
    saved = json.loads(snapshot.read_bytes())
    assert saved["status"] == "blocked"
    original = snapshot.read_bytes()
    assert (
        cli_main(
            ["data", "sample", "--root", str(root), "--profile", str(profile_path), "--recipe", "pilot-v1", "--output", output]
        )
        == 2
    )
    capsys.readouterr()
    assert snapshot.read_bytes() == original


def test_pilot_yield_sampler_selects_fixed_distinct_groups_from_verified_synthetic_evidence(
    tmp_path: Path,
) -> None:
    root = tmp_path / "private-data"
    root.mkdir()
    registry_path = tmp_path / "sources.json"
    terms_path = tmp_path / "anita-work-terms.json"
    registry = copy.deepcopy(load_registry())
    selected_ids = {"anita-dataset", "emoreccom-panels", "the-met-open-access", "aic-open-access"}
    registry["sources"] = [source for source in registry["sources"] if source["id"] in selected_ids]
    term_bytes = b"synthetic terms fixture; not an actual rights decision"
    term_hash = hashlib.sha256(term_bytes).hexdigest()
    works = json.loads(
        (REPOSITORY_ROOT / "config" / "anita-work-terms.json").read_text(encoding="utf-8")
    )
    for work in works["works"]:
        work.update(
            rights_status="approved",
            reviewer_decision="approved",
            reviewer_id="fixture-reviewer",
            reviewed_at="2026-10-03T00:00:00Z",
            reviewed_sha256=term_hash,
            terms_snapshot_sha256=term_hash,
            attribution_text=f"{work['artist']}, {work['work_title']}",
        )
        work["use_permissions"]["local_display"] = True
    write_json_atomic(terms_path, works)

    for source in registry["sources"]:
        source["rights_status"] = "approved"
        source["terms_snapshot_sha256"] = term_hash
        source["terms_review"] = {
            "status": "approved",
            "reviewer_id": "fixture-reviewer",
            "reviewed_at": "2026-10-03T00:00:00Z",
            "reviewed_sha256": term_hash,
        }
        source["use_permissions"]["local_display"] = True
    write_json_atomic(registry_path, registry)

    for source in registry["sources"]:
        terms_dir = root / "manifests" / "terms" / source["id"]
        terms_dir.mkdir(parents=True, exist_ok=True)
        terms_file = terms_dir / f"{term_hash}.html"
        terms_file.write_bytes(term_bytes)
        write_json_atomic(
            terms_dir / f"{term_hash}.json",
            {
                "source_id": source["id"],
                "sha256": term_hash,
                "snapshot_path": terms_file.relative_to(root).as_posix(),
            },
        )

    image_index = 0

    def image_entry(source_id: str, relative: str, group: str, **extra: object) -> dict:
        nonlocal image_index
        image_index += 1
        image_path = root / source_id / relative
        image_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (256, 256), (image_index % 256, image_index // 256, 127)).save(image_path)
        return {
            "asset_id": f"asset-{source_id}-{image_index}",
            "relative_path": relative,
            "sha256": sha256_file(image_path),
            "byte_length": image_path.stat().st_size,
            "width": 256,
            "height": 256,
            "decoder_status": "decoded",
            "group_id": group,
            "rights_status": "approved",
            "review_status": "pending",
            "use_permissions": {
                key: key == "local_display"
                for key in (
                    "local_display",
                    "training",
                    "evaluation",
                    "derive",
                    "trace",
                    "export",
                    "public_demo",
                    "redistribute",
                    "cloud_storage",
                    "cloud_processing",
                )
            },
            **extra,
        }

    manifests: dict[str, dict] = {}
    work_by_id = {work["folder_id"].casefold(): work for work in works["works"]}
    anita_entries: list[dict] = []
    for work_id, work in work_by_id.items():
        artist_group = (
            f"anita-artist-{hashlib.sha256(work['artist'].encode('utf-8')).hexdigest()[:16]}"
        )
        for scene_index in range(5):
            scene = f"scene_{scene_index}"
            relative = f"{work_id}/sketch/{scene}/frame-{scene_index}.png"
            anita_entries.append(
                image_entry(
                    "anita-dataset",
                    relative,
                    f"anita:artist:{artist_group}",
                    candidate_type="sketch",
                    work_id=work_id,
                    work_review_status="approved",
                    artist_group_id=artist_group,
                    scene_group_id=f"anita:{work_id}:{scene}",
                    terms_snapshot_sha256=term_hash,
                    attribution_text=work["attribution_text"],
                    license_id=work["license"],
                    use_permissions=work["use_permissions"],
                )
            )
    manifests["anita-dataset"] = {
        "relative_root": "anita-dataset",
        "entries": anita_entries,
        "anita_work_terms_sha256": sha256_file(terms_path),
    }

    emorec_entries = [
        image_entry(
            "emoreccom-panels",
            f"book-{index}/panel.png",
            f"emoreccom:book-{index}",
            candidate_type="panel_with_official_character_boxes",
            publication_partition="source_train",
            book_identity_verified=True,
        )
        for index in range(60)
    ]
    manifests["emoreccom-panels"] = {"relative_root": "emoreccom-panels", "entries": emorec_entries}
    met_entries = [
        image_entry(
            "the-met-open-access",
            f"object-{index}.png",
            f"met:{index}",
            museum_object_group_id=f"met:{index}",
            object_id=str(index),
            is_public_domain=True,
            primary_image=f"https://images.metmuseum.org/{index}.jpg",
            source_record_url=f"https://collectionapi.metmuseum.org/public/collection/v1/objects/{index}",
        )
        for index in range(50)
    ]
    manifests["the-met-open-access"] = {
        "relative_root": "the-met-open-access",
        "entries": met_entries,
    }
    aic_entries = [
        image_entry(
            "aic-open-access",
            f"object-{index}.png",
            f"aic:{index}",
            museum_object_group_id=f"aic:{index}",
            object_id=str(index),
            is_public_domain=True,
            image_id=f"image-{index}",
            source_record_url=f"https://api.artic.edu/api/v1/artworks/{index}",
        )
        for index in range(50)
    ]
    manifests["aic-open-access"] = {"relative_root": "aic-open-access", "entries": aic_entries}

    for source in registry["sources"]:
        source_id = source["id"]
        manifest = manifests[source_id]
        tree_digest = hashlib.sha256()
        for entry in sorted(manifest["entries"], key=lambda item: item["relative_path"]):
            tree_digest.update(entry["relative_path"].encode("utf-8"))
            tree_digest.update(b"\0")
            tree_digest.update(str(entry["byte_length"]).encode("ascii"))
            tree_digest.update(b"\0")
            tree_digest.update(entry["sha256"].encode("ascii"))
            tree_digest.update(b"\n")
        manifest.update(
            schema_version=1,
            source_id=source_id,
            source_registry_sha256=sha256_file(registry_path),
            source_archive_sha256=None,
            status="synthetic_fixture",
            file_count=len(manifest["entries"]),
            tree_sha256=tree_digest.hexdigest(),
        )
        if source_id not in {"anita-dataset", "emoreccom-panels"}:
            metadata_bytes = f"official metadata fixture {source_id}".encode()
            metadata_hash = hashlib.sha256(metadata_bytes).hexdigest()
            manifest["source_metadata_snapshot_sha256"] = metadata_hash
            metadata_dir = root / "manifests" / "source-metadata" / source_id
            metadata_dir.mkdir(parents=True, exist_ok=True)
            (metadata_dir / f"{metadata_hash}.json").write_bytes(metadata_bytes)
        write_json_atomic(root / "manifests" / f"{source_id}-tree.json", manifest)

    # Create receipt-bound synthetic archives, scoped only to this temporary test root.
    for source_id in ("anita-dataset", "emoreccom-panels"):
        source = next(item for item in registry["sources"] if item["id"] == source_id)
        source["download_url"] = f"https://downloads.example.test/{source_id}.zip"
        source["download_hosts"] = ["downloads.example.test"]
        archive = root / source["archive_path"]
        make_archive(archive, {"fixture.txt": source_id.encode()})
        # The registry hash is bound into manifests, so update all entries once URLs are final.
    write_json_atomic(registry_path, registry)
    profile_path = write_source_profile(root, registry, list(work_by_id))
    for source in registry["sources"]:
        manifest_path = root / "manifests" / f"{source['id']}-tree.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["source_registry_sha256"] = sha256_file(registry_path)
        if source.get("archive_path"):
            archive = root / source["archive_path"]
            archive_digest = sha256_file(archive)
            manifest["source_archive_sha256"] = archive_digest
            receipt = {
                "source_id": source["id"],
                "authority_url": source["authority_url"],
                "requested_url": source["download_url"],
                "final_url": source["download_url"],
                "archive_path": source["archive_path"],
                "byte_length": archive.stat().st_size,
                "sha256": archive_digest,
                "retrieved_at": "2026-10-03T00:00:00Z",
                "archive_validation": inspect_zip(archive),
            }
            receipt_path = root / "manifests" / "source-receipts" / f"{source['id']}.json"
            write_json_atomic(receipt_path, receipt)
        write_json_atomic(manifest_path, manifest)

    first = build_pilot_yield_sample(
        root, profile_path=profile_path, registry_path=registry_path, terms_path=terms_path
    )
    second = build_pilot_yield_sample(
        root, profile_path=profile_path, registry_path=registry_path, terms_path=terms_path
    )
    assert first["status"] == "candidate_sample_pending_human_review"
    assert first["selected_count"] == 230
    assert first["gallery_activation"] is False
    assert first["training_authorization"] == "pending"
    assert first["selected"] == second["selected"]
    anita = next(item for item in first["sources"] if item["source_id"] == "anita-dataset")
    assert len(anita["selected"]) == 70
    assert all(
        sum(item["work_id"] == work_id for item in anita["selected"]) == 5 for work_id in work_by_id
    )
    emorec = next(item for item in first["sources"] if item["source_id"] == "emoreccom-panels")
    assert len({item["group_id"] for item in emorec["selected"]}) == 60

    aic_manifest_path = root / "manifests" / "aic-open-access-tree.json"
    aic_manifest = json.loads(aic_manifest_path.read_text(encoding="utf-8"))
    aic_manifest["relative_root"] = "../blocked-tree"
    aic_manifest_path.write_text(json.dumps(aic_manifest), encoding="utf-8")
    partial = build_pilot_yield_sample(
        root, profile_path=profile_path, registry_path=registry_path, terms_path=terms_path
    )
    assert partial["status"] == "partial_sample_pending_human_review"
    assert partial["selected_count"] == 180
    assert partial["gallery_activation"] is False
    assert partial["human_review_required"] is True
    blocked_aic = next(item for item in partial["sources"] if item["source_id"] == "aic-open-access")
    assert blocked_aic["selected"] == []
    assert "source_tree_missing_or_unsafe" in blocked_aic["blockers"]

    anita_only_profile = write_source_profile(
        root,
        registry,
        [next(iter(work_by_id))],
        selected_source_ids={"anita-dataset"},
    )
    scoped = build_pilot_yield_sample(
        root,
        profile_path=anita_only_profile,
        registry_path=registry_path,
        terms_path=terms_path,
    )
    assert scoped["status"] == "candidate_sample_pending_human_review"
    assert [item["source_id"] for item in scoped["sources"]] == ["anita-dataset"]
    assert scoped["selected_count"] == 5
    assert {item["work_id"] for item in scoped["selected"]} == {next(iter(work_by_id))}
