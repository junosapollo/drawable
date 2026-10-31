from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import sqlite3
import stat
import warnings
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from drawable_research_contracts import (
    CurationSnapshotV1,
    SnapshotAssetV1,
    ViewMatchReviewV1,
    validate_curation_snapshot_files,
    validate_view_match_rubric,
    validate_viewpoint_rubric,
)
from PIL import Image, ImageOps, UnidentifiedImageError

from .database import connect
from .intake import (
    IntakeError,
    _anita_work_records,
    ensure_inside,
    load_registry,
    sha256_file,
    terms_snapshot_receipt_path,
    utc_now,
)
from .prototype_review import PROTOTYPE_AUTHORIZATION, PROTOTYPE_PERMISSIONS, is_prototype_asset
from .schemas import (
    CurationCropRequest,
    CurationCropResponse,
    CurationReviewRequest,
    CurationReviewResponse,
    CurationSnapshotRequest,
    CurationSnapshotResponse,
    CurationViewMatchRequest,
    CurationViewMatchResponse,
)
from .settings import REPOSITORY_ROOT, Settings


def _encode_candidate_cursor(value: dict[str, str]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_candidate_cursor(
    cursor: str,
    *,
    state: str,
    source_id: str | None,
    work_id: str | None,
    candidate_type: str | None,
) -> tuple[str, str, str]:
    if len(cursor) > 2048 or any(
        char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        for char in cursor
    ):
        raise ValueError("Candidate pagination cursor is malformed")
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Candidate pagination cursor is malformed") from error
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "state",
            "source_id",
            "work_id",
            "candidate_type",
            "last_source",
            "last_path",
            "last_asset",
        }
        or value["state"] != state
        or value["source_id"] != (source_id or "")
        or value["work_id"] != (work_id or "")
        or value["candidate_type"] != (candidate_type or "")
        or any(
            not isinstance(value[key], str) for key in ("last_source", "last_path", "last_asset")
        )
    ):
        raise ValueError("Candidate pagination cursor does not match the active filters")
    return value["last_source"], value["last_path"], value["last_asset"]


def _family_membership_sha256(rows: list[Any]) -> str:
    membership = [{"asset_id": row["asset_id"], "sha256": row["sha256"]} for row in rows]
    return hashlib.sha256(
        json.dumps(membership, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _refresh_active_family_assignment(db: Any, source_id: str, group_id: str | None) -> None:
    """Keep an approved family split bound to every source and derived asset byte."""
    if not group_id:
        return
    assignment = db.execute(
        "SELECT assignment_id FROM family_split_assignments WHERE source_id = ? AND group_id = ? AND status = 'active'",
        (source_id, group_id),
    ).fetchone()
    if not assignment:
        return
    members = db.execute(
        "SELECT asset_id, sha256 FROM assets WHERE source_id = ? AND group_id = ? ORDER BY asset_id",
        (source_id, group_id),
    ).fetchall()
    db.execute(
        "UPDATE family_split_assignments SET member_count = ?, membership_sha256 = ? WHERE assignment_id = ? AND status = 'active'",
        (len(members), _family_membership_sha256(members), assignment["assignment_id"]),
    )


def list_candidates(
    settings: Settings,
    *,
    limit: int,
    source_id: str | None = None,
    state: str = "pending",
    work_id: str | None = None,
    candidate_type: str | None = None,
    cursor: str | None = None,
    asset_ids: list[str] | None = None,
) -> dict[str, Any]:
    db = connect(settings.metadata_db)
    try:
        clauses = ["state != 'locked_test'"]
        values: list[Any] = []
        if source_id:
            clauses.append("source_id = ?")
            values.append(source_id)
        if state == "pending":
            clauses.append("state IN ('quarantined', 'candidate_pending_rights')")
        elif state == "candidate":
            clauses.append("state = 'candidate'")
        elif state == "rejected":
            clauses.append("state = 'rejected'")
        elif state != "all":
            raise ValueError("state must be pending, candidate, rejected, or all")
        if work_id:
            clauses.append("json_extract(metadata_json, '$.work_id') = ?")
            values.append(work_id)
        if candidate_type:
            clauses.append("json_extract(metadata_json, '$.candidate_type') = ?")
            values.append(candidate_type)
        if asset_ids is not None:
            if len(asset_ids) > 250 or len(asset_ids) != len(set(asset_ids)):
                raise ValueError("A fixed source-yield queue must contain at most 250 unique assets")
            if not asset_ids:
                return {"items": [], "next_cursor": None}
            clauses.append(f"asset_id IN ({','.join('?' for _ in asset_ids)})")
            values.extend(asset_ids)
        if cursor:
            last_source, last_path, last_asset = _decode_candidate_cursor(
                cursor,
                state=state,
                source_id=source_id,
                work_id=work_id,
                candidate_type=candidate_type,
            )
            clauses.append("(source_id, relative_path, asset_id) > (?, ?, ?)")
            values.extend((last_source, last_path, last_asset))
        values.append(limit + 1)
        rows = db.execute(
            f"SELECT asset_id, source_id, relative_path, revision, state, metadata_json, width, height, rights_status, sha256 FROM assets WHERE {' AND '.join(clauses)} ORDER BY source_id, relative_path, asset_id LIMIT ?",
            values,
        ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        registry_file = settings.source_registry_path
        try:
            registry = load_registry(registry_file)
            sources = {source["id"]: source for source in registry["sources"]}
            registry_hash = sha256_file(registry_file)
        except (IntakeError, OSError):
            sources, registry_hash = {}, ""
        result: list[dict[str, Any]] = []
        for row in rows:
            metadata = json.loads(row["metadata_json"])
            public_metadata = {
                key: metadata[key]
                for key in (
                    "group_id",
                    "work_group_id",
                    "artist_group_id",
                    "scene_group_id",
                    "work_id",
                    "work_title",
                    "artist",
                    "scene_id",
                    "candidate_type",
                    "decoder_status",
                    "license_id",
                    "attribution_text",
                    "rights_status",
                    "authorization_basis",
                    "terms_snapshot_sha256",
                    "use_permissions",
                    "learning_split",
                    "labels",
                    "parent_asset_id",
                    "crop_rectangle",
                    "viewpoint",
                    "source_yield_review",
                    "review_status",
                    "gallery_eligible_candidate",
                    "publication_partition",
                    "provisional_book_prefix",
                    "book_identity_verified",
                    "character_annotations",
                    "annotation_box_bounds",
                    "annotation_source_file",
                    "annotation_source_sha256",
                    "object_id",
                    "title",
                    "medium",
                    "date",
                    "credit_line",
                    "source_record_url",
                    "primary_image",
                    "image_id",
                    "comic_no",
                    "book_title",
                    "book_mapping_sha256",
                    "official_book_index_sha256",
                    "official_book_index_receipt_sha256",
                    "book_mapping_reviewer_id",
                    "book_mapping_reviewed_at",
                )
                if key in metadata
            }
            preview_available = False
            preview_blocker: str | None = "source_rights_not_approved"
            source = sources.get(row["source_id"])
            prototype = is_prototype_asset(settings, metadata)
            if source and (prototype or metadata.get("source_registry_sha256") == registry_hash):
                try:
                    permissions = _source_permissions(
                        source, metadata, terms_path=settings.anita_work_terms_path, prototype_mode=prototype
                    )
                    preview_available = (
                        (prototype or row["rights_status"] == "approved")
                        and metadata.get("use_permissions", {}).get("local_display") is True
                        and permissions.get("local_display") is True
                        and row["state"] != "locked_test"
                    )
                    preview_blocker = (
                        None if preview_available else "local_display_permission_not_granted"
                    )
                except (IntakeError, OSError, TypeError, AttributeError):
                    preview_blocker = "source_terms_require_review"
            result.append(
                {
                    "asset_id": row["asset_id"],
                    "source_id": row["source_id"],
                    "revision": row["revision"],
                    "state": row["state"],
                    "width": row["width"],
                    "height": row["height"],
                    "preview_available": preview_available,
                    "preview_blocker": preview_blocker,
                    "metadata": {**public_metadata, "sha256": row["sha256"]},
                }
            )
        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            next_cursor = _encode_candidate_cursor(
                {
                    "state": state,
                    "source_id": source_id or "",
                    "work_id": work_id or "",
                    "candidate_type": candidate_type or "",
                    "last_source": str(last["source_id"]),
                    "last_path": str(last["relative_path"]),
                    "last_asset": str(last["asset_id"]),
                }
            )
        return {"items": result, "next_cursor": next_cursor}
    finally:
        db.close()


def list_source_yield_queue(settings: Settings) -> dict[str, Any]:
    """Read the immutable pilot-v1 candidate sample and resolve its exact catalog rows."""
    sample_path = settings.data_root / "reports" / "source-yield-sample-pilot-v2.json"
    if sample_path.is_symlink() or not sample_path.is_file():
        return {
            "status": "not_generated",
            "sample_sha256": None,
            "selected_count": 0,
            "sources": [],
            "items": [],
            "blockers": ["pilot_v1_source_yield_sample_missing"],
        }
    try:
        sample = json.loads(sample_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise IntakeError("The fixed source-yield sample is corrupt") from error
    if (
        not isinstance(sample, dict)
        or sample.get("schema_version") != 1
        or sample.get("recipe_id") != "pilot-v1"
        or not isinstance(sample.get("selected"), list)
        or not isinstance(sample.get("sources"), list)
        or type(sample.get("selected_count")) is not int
        or sample["selected_count"] != len(sample["selected"])
        or sample["selected_count"] > 250
    ):
        raise IntakeError("The fixed source-yield sample has an unsupported identity or shape")
    registry_path = settings.source_registry_path
    if sample.get("source_registry_sha256") != sha256_file(registry_path):
        return {
            "status": "stale_registry",
            "sample_sha256": sha256_file(sample_path),
            "selected_count": sample["selected_count"],
            "sources": sample["sources"],
            "items": [],
            "blockers": ["source_registry_changed_after_sample_generation"],
        }
    selected: dict[str, dict[str, str]] = {}
    for item in sample["selected"]:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("asset_id"), str)
            or not isinstance(item.get("source_id"), str)
            or not isinstance(item.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
            or item["asset_id"] in selected
        ):
            raise IntakeError("The fixed source-yield sample has malformed or repeated asset identities")
        selected[item["asset_id"]] = {"source_id": item["source_id"], "sha256": item["sha256"]}
    page = list_candidates(
        settings,
        limit=max(1, len(selected)),
        state="all",
        asset_ids=list(selected),
    )
    if len(page["items"]) != len(selected):
        raise IntakeError("A fixed source-yield candidate is missing from the current catalog")
    for item in page["items"]:
        expected = selected[item["asset_id"]]
        if item["source_id"] != expected["source_id"] or item["metadata"].get("sha256") != expected["sha256"]:
            raise IntakeError("A fixed source-yield candidate changed since the sample was frozen")
    item_map = {item["asset_id"]: item for item in page["items"]}
    ordered_items = [item_map[item["asset_id"]] for item in sample["selected"]]
    return {
        "status": sample.get("status", "blocked"),
        "sample_sha256": sha256_file(sample_path),
        "selected_count": len(ordered_items),
        "sources": sample["sources"],
        "items": ordered_items,
        "blockers": [],
    }


def _verify_terms_snapshot(root: Path, source: dict[str, Any]) -> str:
    digest = source.get("terms_snapshot_sha256")
    review = source.get("terms_review", {})
    if (
        source.get("rights_status") != "approved"
        or review.get("status") != "approved"
        or review.get("reviewed_sha256") != digest
        or not review.get("reviewer_id")
        or not review.get("reviewed_at")
    ):
        raise IntakeError("Source terms and permissions have not been approved by a reviewer")
    if not isinstance(digest, str):
        raise IntakeError("Approved source has no terms snapshot hash")
    receipt_path = terms_snapshot_receipt_path(root, source["id"], digest)
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise IntakeError("Reviewed source terms snapshot receipt is missing or corrupt") from error
    snapshot = ensure_inside(root, str(receipt.get("snapshot_path", "")))
    if (
        receipt.get("source_id") != source["id"]
        or receipt.get("sha256") != digest
        or snapshot.is_symlink()
        or not snapshot.is_file()
        or sha256_file(snapshot) != digest
    ):
        raise IntakeError("Reviewed source terms snapshot does not match its recorded bytes")
    return digest


def _source_permissions(
    source: dict[str, Any], metadata: dict[str, Any], *, terms_path: Path | None, prototype_mode: bool = False
) -> dict[str, bool]:
    if prototype_mode and metadata.get("authorization_basis") == PROTOTYPE_AUTHORIZATION:
        return dict(PROTOTYPE_PERMISSIONS)
    allowed = dict(source["use_permissions"])
    if source["id"] == "anita-dataset":
        if metadata.get("anita_work_terms_sha256") != sha256_file(
            terms_path or REPOSITORY_ROOT / "config" / "anita-work-terms.json"
        ):
            raise IntakeError(
                "Anita per-work terms registry changed; recatalog the current manifest before reviewing"
            )
        records = _anita_work_records(terms_path)
        work = records.get(str(metadata.get("work_id", "")).casefold())
        if (
            not work
            or work.get("rights_status") != "approved"
            or work.get("reviewer_decision") != "approved"
        ):
            return {key: False for key in allowed}
        allowed = {
            key: bool(allowed.get(key)) and bool(work["use_permissions"].get(key))
            for key in allowed
        }
    return allowed


def authorized_preview_path(
    settings: Settings,
    asset_id: str,
    *,
    registry_path: Path | None = None,
    anita_terms_path: Path | None = None,
) -> tuple[Path, str]:
    db = connect(settings.metadata_db)
    try:
        row = db.execute("SELECT * FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
    finally:
        db.close()
    if not row or row["state"] == "locked_test":
        raise LookupError("Preview asset was not found")
    metadata = json.loads(row["metadata_json"])
    prototype = is_prototype_asset(settings, metadata)
    registry_file = registry_path or settings.source_registry_path
    anita_terms_path = anita_terms_path or settings.anita_work_terms_path
    registry = load_registry(registry_file)
    source = next((item for item in registry["sources"] if item["id"] == row["source_id"]), None)
    if not source or (not prototype and metadata.get("source_registry_sha256") != sha256_file(registry_file)):
        raise PermissionError(
            "Source registry changed; recatalog and review the asset before preview"
        )
    if (
        (not prototype and row["rights_status"] != "approved")
        or metadata.get("use_permissions", {}).get("local_display") is not True
    ):
        raise PermissionError("Local display is not approved for this asset")
    permissions = _source_permissions(source, metadata, terms_path=anita_terms_path, prototype_mode=prototype)
    if not permissions.get("local_display"):
        raise PermissionError("Current source and per-work terms do not allow local display")
    if not prototype:
        _verify_terms_snapshot(settings.data_root, source)
    relative_root = metadata.get("relative_root")
    if not isinstance(relative_root, str) or not relative_root:
        raise IntakeError("Asset has no cataloged relative root")
    raw_relative = str(row["relative_path"])
    if "\\" in relative_root or "\\" in raw_relative:
        raise IntakeError("Asset has an unsafe relative path")
    relative_path = Path(relative_root) / raw_relative
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise IntakeError("Asset has an unsafe relative path")
    root = settings.data_root.resolve(strict=True)
    candidate = root / relative_path
    cursor = root
    for part in relative_path.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise IntakeError("Symbolic links are not permitted in curation preview paths")
    resolved = candidate.resolve(strict=True)
    if root not in resolved.parents or not resolved.is_file():
        raise IntakeError("Candidate file is missing or outside the dataset root")
    media_type = row["media_type"]
    allowed_types = {"image/png", "image/jpeg", "image/webp"}
    if media_type not in allowed_types:
        raise IntakeError("Only verified PNG, JPEG, and WebP images may be previewed")
    if resolved.stat().st_size != row["byte_length"] or sha256_file(resolved) != row["sha256"]:
        raise IntakeError("Candidate image bytes changed since cataloging")
    return resolved, media_type


def curation_progress(settings: Settings) -> dict[str, int]:
    db = connect(settings.metadata_db)
    try:
        row = db.execute(
            """SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN state IN ('quarantined', 'candidate_pending_rights') THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN state = 'candidate' THEN 1 ELSE 0 END) AS candidate,
                SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END) AS rejected
               FROM assets WHERE state != 'locked_test'"""
        ).fetchone()
        reviewed = db.execute("SELECT COUNT(DISTINCT asset_id) FROM reviews").fetchone()[0]
        return {
            "total": int(row["total"] or 0),
            "pending": int(row["pending"] or 0),
            "candidate": int(row["candidate"] or 0),
            "rejected": int(row["rejected"] or 0),
            "reviewed": int(reviewed or 0),
        }
    finally:
        db.close()


def viewpoint_rubric() -> dict[str, Any]:
    rubric_file = REPOSITORY_ROOT / "config" / "viewpoint-rubric-v1.json"
    try:
        value = json.loads(rubric_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise IntakeError("The versioned viewpoint rubric is missing or invalid") from error
    if value.get("schema_version") != 1 or value.get("rubric_id") != "drawable-viewpoint-v1":
        raise IntakeError("The viewpoint rubric identifier or schema version is unsupported")
    return {
        "rubric_id": value["rubric_id"],
        "rubric_sha256": sha256_file(rubric_file),
        "rubric": value,
    }


def source_path_registry_current(metadata: dict[str, Any], registry_file: Path) -> bool:
    try:
        return metadata.get("source_registry_sha256") == sha256_file(registry_file)
    except OSError:
        return False


def create_curation_snapshot(
    settings: Settings,
    request: CurationSnapshotRequest,
    *,
    registry_path: Path | None = None,
    anita_terms_path: Path | None = None,
) -> CurationSnapshotResponse:
    registry_file = registry_path or settings.source_registry_path
    anita_terms_path = anita_terms_path or settings.anita_work_terms_path
    active_rubric = viewpoint_rubric()
    rubric_hash = str(active_rubric["rubric_sha256"])
    if request.expected_rubric_sha256 != rubric_hash:
        raise IntakeError("Viewpoint rubric changed; reload it before creating a snapshot")
    request_json = json.dumps(
        request.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    )
    request_hash = hashlib.sha256(request_json.encode("utf-8")).hexdigest()

    db = connect(settings.metadata_db)
    try:
        previous = db.execute(
            "SELECT request_sha256, response_json FROM curation_actions WHERE idempotency_key = ?",
            (str(request.idempotency_key),),
        ).fetchone()
        all_assets = db.execute("SELECT * FROM assets ORDER BY source_id, asset_id").fetchall()
        assignments = {
            (row["source_id"], row["group_id"]): row
            for row in db.execute(
                "SELECT * FROM family_split_assignments WHERE status = 'active'"
            ).fetchall()
        }
        pair_rows = db.execute(
            "SELECT review_json FROM viewpoint_pair_reviews ORDER BY created_at, review_id"
        ).fetchall()
    finally:
        db.close()
    if previous:
        if previous["request_sha256"] != request_hash:
            raise ValueError("Idempotency key was already used for a different snapshot request")
        stored = json.loads(previous["response_json"])
        stored["idempotent_replay"] = True
        return CurationSnapshotResponse(**stored)

    if len(request.asset_ids) != len(set(request.asset_ids)):
        raise ValueError("A staging snapshot must name unique asset IDs")
    assets_by_id = {row["asset_id"]: row for row in all_assets}
    missing_ids = sorted(set(request.asset_ids) - set(assets_by_id))
    if missing_ids:
        raise LookupError(f"Selected staging assets are absent from the catalog: {', '.join(missing_ids)}")
    all_assets = [assets_by_id[asset_id] for asset_id in request.asset_ids]

    registry = load_registry(registry_file)
    source_map = {source["id"]: source for source in registry["sources"]}
    registry_hash = sha256_file(registry_file)
    family_map: dict[tuple[str, str], list[Any]] = {}
    for asset in all_assets:
        if asset["group_id"]:
            family_map.setdefault((asset["source_id"], asset["group_id"]), []).append(asset)

    prepared: list[SnapshotAssetV1] = []
    for row in all_assets:
        if row["state"] != "candidate":
            continue
        metadata = json.loads(row["metadata_json"])
        prototype = is_prototype_asset(settings, metadata)
        if metadata.get("gallery_eligible_candidate") is not True:
            continue
        source = source_map.get(row["source_id"])
        if not source or (not prototype and metadata.get("source_registry_sha256") != registry_hash):
            raise IntakeError(
                f"Eligible candidate {row['asset_id']} is stale against the source registry"
            )
        if (not prototype and row["rights_status"] != "approved") or metadata.get("review_status") != "approved":
            raise IntakeError(
                f"Eligible candidate {row['asset_id']} lacks current rights and curation approval"
            )
        terms_hash = None if prototype else _verify_terms_snapshot(settings.data_root, source)
        if not prototype and metadata.get("terms_snapshot_sha256") != terms_hash:
            raise IntakeError(f"Eligible candidate {row['asset_id']} has stale terms provenance")
        requested = metadata.get("use_permissions")
        allowed = _source_permissions(source, metadata, terms_path=anita_terms_path, prototype_mode=prototype)
        if (
            not isinstance(requested, dict)
            or requested.get("local_display") is not True
            or not allowed.get("local_display")
        ):
            raise PermissionError(
                f"Eligible candidate {row['asset_id']} lacks current local-display permission"
            )
        if any(
            value is True and not allowed.get(key, False)
            for key, value in requested.items()
            if isinstance(value, bool)
        ):
            raise PermissionError(
                f"Eligible candidate {row['asset_id']} requests a use not granted by current terms"
            )
        group_id = row["group_id"]
        assignment = assignments.get((row["source_id"], group_id))
        if not group_id or not assignment or assignment["learning_split"] != "pilot_development":
            raise IntakeError(
                f"Eligible candidate {row['asset_id']} has no audited development-family split"
            )
        family = family_map.get((row["source_id"], group_id), [])
        if any(member["state"] == "locked_test" for member in family):
            raise IntakeError(f"Source family {group_id} includes locked-test material")
        if any(
            json.loads(member["metadata_json"]).get("learning_split") != "pilot_development"
            for member in family
        ):
            raise IntakeError(
                f"Source family {group_id} contains unassigned or conflicting split members"
            )
        authorized_preview_path(
            settings,
            row["asset_id"],
            registry_path=registry_file,
            anita_terms_path=anita_terms_path,
        )
        relative_root = metadata.get("relative_root")
        if not isinstance(relative_root, str):
            raise IntakeError(f"Eligible candidate {row['asset_id']} has no catalog-relative root")
        raw_relative = str(row["relative_path"])
        if "\\" in relative_root or "\\" in raw_relative:
            raise IntakeError(f"Eligible candidate {row['asset_id']} has an unsafe catalog path")
        relative = PurePosixPath(relative_root) / PurePosixPath(raw_relative)
        if relative.is_absolute() or ".." in relative.parts:
            raise IntakeError(f"Eligible candidate {row['asset_id']} has an unsafe catalog path")
        review = metadata.get("curation_review")
        labels = metadata.get("labels")
        if not isinstance(review, dict) or not isinstance(labels, dict):
            raise IntakeError(
                f"Eligible candidate {row['asset_id']} is missing human review metadata"
            )
        try:
            prepared.append(
                SnapshotAssetV1.model_validate_json(
                    json.dumps(
                        {
                            "asset_id": row["asset_id"],
                            "source_id": row["source_id"],
                            "source_work_id": metadata.get("work_id"),
                            "source_work_terms_sha256": metadata.get("anita_work_terms_sha256")
                            if row["source_id"] == "anita-dataset"
                            else None,
                            "relative_path": relative.as_posix(),
                            "sha256": row["sha256"],
                            "byte_length": row["byte_length"],
                            "media_type": row["media_type"],
                            "width": row["width"],
                            "height": row["height"],
                            "source_family": group_id,
                            "learning_split": "pilot_development",
                            "rights_status": row["rights_status"],
                            "authorization_basis": PROTOTYPE_AUTHORIZATION if prototype else "terms-reviewed",
                            "review_status": "approved",
                            "gallery_eligible_candidate": True,
                            "terms_snapshot_sha256": terms_hash,
                            "source_registry_sha256": registry_hash,
                            "license_id": metadata.get("license_id") or "",
                            "attribution": metadata.get("attribution_text") or "",
                            "permissions": requested,
                            "labels": {
                                key: labels[key]
                                for key in (
                                    "style",
                                    "primary_scope",
                                    "secondary_scopes",
                                    "person_count",
                                    "quality",
                                    "sfw",
                                    "character_useful",
                                    "text_coverage",
                                    "clipped",
                                    "damaged",
                                    "duplicate_of",
                                    "review_seconds",
                                    "keep_reject_reason",
                                )
                                if key in labels
                            },
                            "viewpoint": metadata.get("viewpoint"),
                            "parent_asset_id": metadata.get("parent_asset_id"),
                            "crop_rectangle": metadata.get("crop_rectangle"),
                            "asset_revision": row["revision"],
                            "review_id": review.get("review_id", ""),
                            "reviewer_id": review.get("reviewer_id", ""),
                        }
                    )
                )
            )
        except (ValueError, TypeError) as error:
            raise IntakeError(
                f"Eligible candidate {row['asset_id']} failed snapshot schema validation: {error}"
            ) from error

    if not prepared:
        raise IntakeError(
            "No reviewed, rights-approved pilot-development candidates are eligible for a snapshot"
        )
    if len(prepared) != len(request.asset_ids):
        raise IntakeError("Every selected asset must pass staging-gallery review and permission checks")
    selected_ids = {item.asset_id for item in prepared}
    view_matches = []
    for pair_row in pair_rows:
        match_json = json.loads(pair_row["review_json"])
        if (
            match_json.get("query_asset_id") in selected_ids
            and match_json.get("reference_asset_id") in selected_ids
        ):
            view_matches.append(ViewMatchReviewV1.model_validate_json(pair_row["review_json"]))
    try:
        snapshot = CurationSnapshotV1(
            purpose="local-educational-prototype" if any(item.authorization_basis == PROTOTYPE_AUTHORIZATION for item in prepared) else "pilot-development-review-only",
            created_at=datetime.now(UTC),
            created_by=request.requester_id,
            viewpoint_rubric_sha256=rubric_hash,
            items=prepared,
            view_matches=view_matches,
        )
        validate_curation_snapshot_files(snapshot, settings.data_root)
    except (OSError, ValueError) as error:
        raise IntakeError(f"Curation snapshot validation failed: {error}") from error
    manifest_json = json.dumps(
        snapshot.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    artifact_bytes = (manifest_json + "\n").encode("utf-8")
    digest = hashlib.sha256(artifact_bytes).hexdigest()
    snapshot_id = f"curation-v1-{digest[:24]}"
    private_root = settings.data_root / "reports" / "private" / "curation-snapshots"
    for directory in (
        settings.data_root / "reports",
        settings.data_root / "reports" / "private",
        private_root,
    ):
        if directory.is_symlink():
            raise IntakeError("Symbolic links are not permitted in private snapshot storage")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt" and (stat.S_IMODE(directory.stat().st_mode) & 0o077):
            raise IntakeError(
                "Private snapshot storage permissions must be restricted to the current user"
            )
    artifact_path = private_root / f"{snapshot_id}.json"
    created_artifact = _create_immutable_bytes(artifact_path, artifact_bytes)
    response = CurationSnapshotResponse(
        snapshot_id=snapshot_id,
        snapshot_sha256=digest,
        rubric_sha256=rubric_hash,
        item_count=len(prepared),
    )
    db = connect(settings.metadata_db)
    try:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute(
            "SELECT request_sha256, response_json FROM curation_actions WHERE idempotency_key = ?",
            (str(request.idempotency_key),),
        ).fetchone()
        if previous:
            if previous["request_sha256"] != request_hash:
                db.execute("ROLLBACK")
                raise ValueError(
                    "Idempotency key was already used for a different snapshot request"
                )
            stored = json.loads(previous["response_json"])
            db.execute("COMMIT")
            if created_artifact:
                artifact_path.unlink(missing_ok=True)
            stored["idempotent_replay"] = True
            return CurationSnapshotResponse(**stored)
        for item in prepared:
            current = db.execute(
                "SELECT revision, sha256, state FROM assets WHERE asset_id = ?", (item.asset_id,)
            ).fetchone()
            if (
                not current
                or current["revision"] != item.asset_revision
                or current["sha256"] != item.sha256
                or current["state"] != "candidate"
            ):
                db.execute("ROLLBACK")
                raise RuntimeError(
                    "A candidate changed while the immutable snapshot was being validated"
                )
        db.execute(
            "INSERT INTO curation_snapshots(snapshot_id, snapshot_sha256, rubric_sha256, item_count, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                snapshot_id,
                digest,
                rubric_hash,
                len(prepared),
                manifest_json,
                snapshot.created_at.isoformat(),
            ),
        )
        db.execute(
            "INSERT INTO curation_actions(idempotency_key, request_sha256, response_json, created_at) VALUES (?, ?, ?, ?)",
            (
                str(request.idempotency_key),
                request_hash,
                json.dumps(response.model_dump(mode="json"), sort_keys=True),
                utc_now(),
            ),
        )
        db.execute("COMMIT")
        return response
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        if created_artifact:
            artifact_path.unlink(missing_ok=True)
        raise
    finally:
        db.close()


def _create_immutable_bytes(path: Path, payload: bytes) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
            os.chmod(path, 0o600)
            return True
        except FileExistsError:
            if sha256_file(path) != hashlib.sha256(payload).hexdigest():
                raise IntakeError("An immutable artifact path contains unexpected bytes")
            return False
    finally:
        temporary.unlink(missing_ok=True)


def create_crop_asset(
    settings: Settings,
    asset_id: str,
    request: CurationCropRequest,
    *,
    registry_path: Path | None = None,
    anita_terms_path: Path | None = None,
) -> CurationCropResponse:
    registry_file = registry_path or settings.source_registry_path
    anita_terms_path = anita_terms_path or settings.anita_work_terms_path
    request_json = json.dumps(
        request.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    )
    request_hash = hashlib.sha256(request_json.encode("utf-8")).hexdigest()
    db = connect(settings.metadata_db)
    derivative_path: Path | None = None
    created_file = False
    try:
        db.execute("BEGIN IMMEDIATE")
        replay = db.execute(
            "SELECT request_sha256, response_json FROM curation_actions WHERE idempotency_key = ?",
            (str(request.idempotency_key),),
        ).fetchone()
        if replay:
            if replay["request_sha256"] != request_hash:
                db.execute("ROLLBACK")
                raise ValueError("Idempotency key was already used for a different crop request")
            stored = json.loads(replay["response_json"])
            db.execute("COMMIT")
            stored["idempotent_replay"] = True
            return CurationCropResponse(**stored)

        parent = db.execute("SELECT * FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
        if not parent:
            db.execute("ROLLBACK")
            raise LookupError("Crop parent asset was not found")
        if parent["state"] == "locked_test":
            db.execute("ROLLBACK")
            raise PermissionError("Locked test assets cannot be cropped or reviewed")
        if int(parent["revision"]) != request.expected_revision:
            db.execute("ROLLBACK")
            raise RuntimeError("Asset revision changed; reload the candidate before cropping")
        metadata = json.loads(parent["metadata_json"])
        prototype = is_prototype_asset(settings, metadata)
        if not prototype and not source_path_registry_current(metadata, registry_file):
            db.execute("ROLLBACK")
            raise RuntimeError(
                "Asset metadata is stale against the source registry; recatalog its source manifest"
            )
        source = next(
            (
                item
                for item in load_registry(registry_file)["sources"]
                if item["id"] == parent["source_id"]
            ),
            None,
        )
        if not source:
            db.execute("ROLLBACK")
            raise PermissionError("Crop source is not present in the approved source registry")
        allowed = _source_permissions(source, metadata, terms_path=anita_terms_path, prototype_mode=prototype)
        recorded = metadata.get("use_permissions", {})
        if not allowed.get("derive") or recorded.get("derive") is not True:
            db.execute("ROLLBACK")
            raise PermissionError(
                "Derivative creation is not approved by current source and per-work terms"
            )
        parent_path, _parent_media_type = authorized_preview_path(
            settings,
            asset_id,
            registry_path=registry_file,
            anita_terms_path=anita_terms_path,
        )
        if parent_path.stat().st_size > 50 * 1024 * 1024:
            db.execute("ROLLBACK")
            raise IntakeError("Crop source exceeds the 50 MiB local review limit")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(parent_path) as source_image:
                    if (
                        source_image.format not in {"PNG", "JPEG", "WEBP"}
                        or getattr(source_image, "n_frames", 1) != 1
                    ):
                        raise IntakeError(
                            "Only single-frame PNG, JPEG, or WebP assets can be cropped"
                        )
                    oriented = ImageOps.exif_transpose(source_image)
                    width, height = oriented.size
                    if width <= 0 or height <= 0 or width * height > 40_000_000:
                        raise IntakeError("Crop source exceeds the 40-megapixel limit")
                    if (
                        request.x + request.width > 1.0000001
                        or request.y + request.height > 1.0000001
                    ):
                        raise ValueError("Crop rectangle must remain inside the source image")
                    left = round(request.x * width)
                    top = round(request.y * height)
                    right = round((request.x + request.width) * width)
                    bottom = round((request.y + request.height) * height)
                    if (
                        left < 0
                        or top < 0
                        or right > width
                        or bottom > height
                        or right - left < 96
                        or bottom - top < 96
                    ):
                        raise ValueError(
                            "A reviewed detail crop must be in bounds and at least 96 pixels on each edge"
                        )
                    cropped = oriented.crop((left, top, right, bottom))
                    if cropped.mode not in {"RGB", "RGBA"}:
                        cropped = cropped.convert("RGBA" if "A" in cropped.getbands() else "RGB")
                    buffer = io.BytesIO()
                    cropped.save(buffer, format="PNG", optimize=False, compress_level=9)
                    png_bytes = buffer.getvalue()
        except (
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
            UnidentifiedImageError,
            OSError,
        ) as error:
            db.execute("ROLLBACK")
            raise IntakeError("Crop source could not be safely decoded") from error

        digest = hashlib.sha256(png_bytes).hexdigest()
        crop_identity = hashlib.sha256(
            f"{parent['source_id']}\0{asset_id}\0{digest}".encode()
        ).hexdigest()
        crop_asset_id = f"crop-{crop_identity[:32]}"
        relative_path = f"derivatives/{crop_identity[:2]}/{crop_identity}.png"
        derivative_path = settings.data_root / relative_path
        derivative_root = settings.data_root.resolve(strict=True)
        for directory in (
            settings.data_root / "derivatives",
            settings.data_root / "derivatives" / crop_identity[:2],
        ):
            if directory.is_symlink():
                raise IntakeError("Symbolic links are not permitted in derivative storage")
        derivative_path.parent.mkdir(parents=True, exist_ok=True)
        if derivative_path.is_symlink():
            raise IntakeError("Symbolic links are not permitted in derivative storage")
        if derivative_root not in derivative_path.parent.resolve(strict=True).parents:
            raise IntakeError("Derivative storage escaped the dataset root")
        created_file = _create_immutable_bytes(derivative_path, png_bytes)

        crop_width, crop_height = right - left, bottom - top
        permissions = {
            key: bool(value) for key, value in recorded.items() if isinstance(value, bool)
        }
        permissions["derive"] = True
        crop_metadata = {
            "relative_root": ".",
            "source_registry_sha256": sha256_file(registry_file),
            "anita_work_terms_sha256": metadata.get("anita_work_terms_sha256"),
            "work_id": metadata.get("work_id"),
            "group_id": metadata.get("group_id"),
            "candidate_type": "manual_detail_crop",
            "decoder_status": "decoded",
            "license_id": metadata.get("license_id"),
            "attribution_text": metadata.get("attribution_text"),
            "rights_status": parent["rights_status"],
            "use_permissions": permissions,
            "learning_split": metadata.get("learning_split", "unassigned"),
            "review_status": "pending",
            "gallery_member": False,
            "gallery_eligible_candidate": False,
            "parent_asset_id": asset_id,
            "crop_rectangle": {
                "coordinate_space": "exif_normalized_parent_pixels",
                "x": left,
                "y": top,
                "width": crop_width,
                "height": crop_height,
                "parent_width": width,
                "parent_height": height,
                "parent_sha256": parent["sha256"],
                "processing_version": 1,
                "reviewer_id": request.reviewer_id,
                "created_at": utc_now(),
            },
        }
        if prototype:
            crop_metadata["authorization_basis"] = PROTOTYPE_AUTHORIZATION
        encoded_metadata = json.dumps(
            crop_metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        existing_crop = db.execute(
            "SELECT sha256 FROM assets WHERE asset_id = ?", (crop_asset_id,)
        ).fetchone()
        if existing_crop:
            if existing_crop["sha256"] != digest:
                raise IntakeError("Crop asset identity collided with different data")
        else:
            db.execute(
                """INSERT INTO assets(asset_id, source_id, relative_path, sha256, byte_length, media_type, width, height,
                   group_id, rights_status, state, revision, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    crop_asset_id,
                    parent["source_id"],
                    relative_path,
                    digest,
                    len(png_bytes),
                    "image/png",
                    crop_width,
                    crop_height,
                    parent["group_id"],
                    parent["rights_status"],
                    "quarantined",
                    0,
                    encoded_metadata,
                ),
            )
        _refresh_active_family_assignment(db, parent["source_id"], parent["group_id"])
        response = CurationCropResponse(
            asset_id=crop_asset_id,
            parent_asset_id=asset_id,
            revision=0,
            width=crop_width,
            height=crop_height,
            sha256=digest,
        )
        db.execute(
            "INSERT INTO curation_actions(idempotency_key, request_sha256, response_json, created_at) VALUES (?, ?, ?, ?)",
            (
                str(request.idempotency_key),
                request_hash,
                json.dumps(response.model_dump(mode="json"), sort_keys=True),
                utc_now(),
            ),
        )
        db.execute("COMMIT")
        return response
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        if created_file and derivative_path is not None:
            derivative_path.unlink(missing_ok=True)
        raise
    finally:
        db.close()


def review_view_match(
    settings: Settings, request: CurationViewMatchRequest
) -> CurationViewMatchResponse:
    rubric_file = REPOSITORY_ROOT / "config" / "viewpoint-rubric-v1.json"
    try:
        validate_view_match_rubric(request.review, sha256_file(rubric_file))
    except (OSError, ValueError) as error:
        raise IntakeError("View-match review does not match the current rubric") from error
    review_json = json.dumps(
        request.review.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    db = connect(settings.metadata_db)
    try:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute(
            "SELECT review_id, review_json FROM viewpoint_pair_reviews WHERE idempotency_key = ?",
            (str(request.idempotency_key),),
        ).fetchone()
        if previous:
            if previous["review_json"] != review_json:
                db.execute("ROLLBACK")
                raise ValueError(
                    "Idempotency key was already used for a different view-match review"
                )
            db.execute("COMMIT")
            return CurationViewMatchResponse(
                review_id=previous["review_id"], idempotent_replay=True
            )
        for candidate_id in (request.review.query_asset_id, request.review.reference_asset_id):
            asset = db.execute(
                "SELECT state FROM assets WHERE asset_id = ?", (candidate_id,)
            ).fetchone()
            if not asset:
                db.execute("ROLLBACK")
                raise LookupError("Both view-match assets must exist in the local catalog")
            if asset["state"] == "locked_test":
                db.execute("ROLLBACK")
                raise PermissionError("Locked-test assets cannot be used in development curation")
        # Validate bytes and permissions before persisting a human judgment.
        authorized_preview_path(settings, request.review.query_asset_id)
        authorized_preview_path(settings, request.review.reference_asset_id)
        review_id = uuid4()
        db.execute(
            """INSERT INTO viewpoint_pair_reviews(review_id, query_asset_id, reference_asset_id, reviewer_id,
               idempotency_key, rubric_sha256, review_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                str(review_id),
                request.review.query_asset_id,
                request.review.reference_asset_id,
                request.review.reviewer_id,
                str(request.idempotency_key),
                request.review.rubric_sha256,
                review_json,
                utc_now(),
            ),
        )
        db.execute("COMMIT")
        return CurationViewMatchResponse(review_id=review_id)
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def review_asset(
    settings: Settings,
    asset_id: str,
    request: CurationReviewRequest,
    *,
    registry_path: Path | None = None,
    anita_terms_path: Path | None = None,
) -> CurationReviewResponse:
    registry_file = registry_path or settings.source_registry_path
    anita_terms_path = anita_terms_path or settings.anita_work_terms_path
    registry = load_registry(registry_file)
    source_map = {source["id"]: source for source in registry["sources"]}
    payload = request.model_dump(mode="json")
    if request.viewpoint is not None:
        if (
            request.viewpoint.review_state != "unreviewed"
            and request.viewpoint.reviewer_id != request.reviewer_id
        ):
            raise ValueError("Viewpoint reviewer_id must match the curation reviewer_id")
        rubric_file = REPOSITORY_ROOT / "config" / "viewpoint-rubric-v1.json"
        try:
            validate_viewpoint_rubric(request.viewpoint, sha256_file(rubric_file))
        except (IntakeError, OSError) as error:
            raise IntakeError("The active viewpoint rubric is missing or unreadable") from error
        except ValueError as error:
            raise IntakeError(str(error)) from error
    request_json = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    review_id = uuid4()
    now = utc_now()
    db = connect(settings.metadata_db)
    try:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT review_id, asset_id, decision, reviewer_id, expected_revision, labels_json FROM reviews WHERE idempotency_key = ?",
            (str(request.idempotency_key),),
        ).fetchone()
        if existing:
            if (
                existing["asset_id"] != asset_id
                or existing["decision"] != request.decision
                or existing["reviewer_id"] != request.reviewer_id
                or existing["expected_revision"] != request.expected_revision
                or existing["labels_json"] != request_json
            ):
                db.execute("ROLLBACK")
                raise ValueError("Idempotency key was already used for a different review payload")
            current = db.execute(
                "SELECT revision, state, metadata_json FROM assets WHERE asset_id = ?", (asset_id,)
            ).fetchone()
            if not current:
                db.execute("ROLLBACK")
                raise LookupError("Review target asset no longer exists")
            metadata = json.loads(current["metadata_json"])
            db.execute("COMMIT")
            return CurationReviewResponse(
                review_id=existing["review_id"],
                asset_id=asset_id,
                revision=request.expected_revision + 1,
                state=current["state"],
                gallery_member=metadata.get("gallery_member") is True,
                gallery_eligible_candidate=metadata.get("gallery_eligible_candidate") is True,
                idempotent_replay=True,
            )
        asset = db.execute("SELECT * FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
        if not asset:
            db.execute("ROLLBACK")
            raise LookupError("Curation target asset was not found")
        if asset["state"] == "locked_test":
            db.execute("ROLLBACK")
            raise PermissionError("Locked test assets are not available to curation")
        if asset["revision"] != request.expected_revision:
            db.execute("ROLLBACK")
            raise RuntimeError("Asset revision changed; reload the candidate before reviewing it")
        metadata = json.loads(asset["metadata_json"])
        sample_path = settings.data_root / "reports" / "source-yield-sample-pilot-v2.json"
        sample_item: dict[str, Any] | None = None
        if sample_path.is_file() and not sample_path.is_symlink():
            try:
                sample_document = json.loads(sample_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                db.execute("ROLLBACK")
                raise IntakeError("The fixed source-yield sample is corrupt; review is blocked") from error
            if (
                not isinstance(sample_document, dict)
                or sample_document.get("schema_version") != 1
                or not isinstance(sample_document.get("selected"), list)
            ):
                db.execute("ROLLBACK")
                raise IntakeError("The fixed source-yield sample has an unsupported shape")
            if sample_document.get("source_registry_sha256") != sha256_file(registry_file):
                db.execute("ROLLBACK")
                raise RuntimeError("The fixed source-yield sample is stale against the source registry")
            selected_items = sample_document.get("selected", [])
            sample_item = next(
                (item for item in selected_items if isinstance(item, dict) and item.get("asset_id") == asset_id),
                None,
            )
        if sample_item is not None:
            sample_sha256 = sha256_file(sample_path)
            if (
                sample_item.get("source_id") != asset["source_id"]
                or sample_item.get("sha256") != asset["sha256"]
                or request.source_yield_judgment is None
                or request.source_yield_judgment.sample_sha256 != sample_sha256
            ):
                db.execute("ROLLBACK")
                raise ValueError("A fixed-sample review must include its current sample hash and eye-crop judgment")
            if request.viewpoint is None or request.viewpoint.review_state not in {"reviewed", "not_applicable"}:
                db.execute("ROLLBACK")
                raise ValueError("A fixed-sample review must record a reviewed or not-applicable viewpoint")
        elif request.source_yield_judgment is not None:
            db.execute("ROLLBACK")
            raise ValueError("Eye-crop yield judgments are accepted only for the current fixed sample")
        source = source_map.get(asset["source_id"])
        prototype = is_prototype_asset(settings, metadata)
        if not source or (not prototype and metadata.get("source_registry_sha256") != sha256_file(registry_file)):
            db.execute("ROLLBACK")
            raise RuntimeError(
                "Asset metadata is stale against the source registry; recatalog its source manifest"
            )
        candidate_path = ensure_inside(
            settings.data_root / metadata.get("relative_root", ""), asset["relative_path"]
        )
        if (
            candidate_path.is_symlink()
            or not candidate_path.is_file()
            or candidate_path.stat().st_size != asset["byte_length"]
            or sha256_file(candidate_path) != asset["sha256"]
        ):
            db.execute("ROLLBACK")
            raise IntakeError("Candidate asset bytes changed since cataloging")
        allowed = _source_permissions(source, metadata, terms_path=anita_terms_path, prototype_mode=prototype)
        requested_permissions = request.use_permissions.model_dump()
        if any(
            value and not allowed.get(key, False) for key, value in requested_permissions.items()
        ):
            db.execute("ROLLBACK")
            raise PermissionError(
                "Requested source use is not approved in the current source and per-work terms registries"
            )
        if request.use_permissions.cloud_processing and not request.use_permissions.cloud_storage:
            db.execute("ROLLBACK")
            raise ValueError("Cloud processing requires separate cloud-storage permission")
        if prototype and request.rights_status != "review_required":
            db.execute("ROLLBACK")
            raise ValueError("Prototype image labels do not change the source's terms-review status")
        if not prototype and request.rights_status == "approved":
            approved_hash = _verify_terms_snapshot(settings.data_root, source)
            if (
                request.terms_snapshot_sha256 != approved_hash
                or not request.license_id
                or not request.attribution_text
            ):
                db.execute("ROLLBACK")
                raise PermissionError(
                    "Rights approval must name the verified license, attribution, and exact reviewed terms hash"
                )
            if source["id"] == "anita-dataset":
                work = _anita_work_records(anita_terms_path).get(
                    str(metadata.get("work_id", "")).casefold()
                )
                if (
                    not work
                    or work.get("terms_snapshot_sha256") != approved_hash
                    or work.get("license") != request.license_id
                    or work.get("attribution_text") != request.attribution_text
                ):
                    db.execute("ROLLBACK")
                    raise PermissionError(
                        "Anita rights approval does not match the reviewed per-work terms and attribution"
                    )
        elif not prototype and any(requested_permissions.values()):
            db.execute("ROLLBACK")
            raise PermissionError("Use permissions require approved asset rights")
        if (
            request.license_id
            and metadata.get("license_id")
            and request.license_id != metadata.get("license_id")
        ):
            db.execute("ROLLBACK")
            raise PermissionError(
                "Submitted license does not match the cataloged source-work license"
            )
        group_id = metadata.get("group_id")
        group_split_complete = False
        group_rows: list[sqlite3.Row] = []
        needs_group_assignment = False
        membership_sha256: str | None = None
        if request.learning_split != "unassigned":
            if not group_id or (
                source["id"] == "emoreccom-panels"
                and metadata.get("book_identity_verified") is not True
            ):
                db.execute("ROLLBACK")
                raise PermissionError(
                    "A verified source-family group is required before assigning a development split"
                )
            group_rows = db.execute(
                "SELECT asset_id, sha256, state, revision, metadata_json FROM assets WHERE source_id = ? AND group_id = ? ORDER BY asset_id",
                (source["id"], group_id),
            ).fetchall()
            if not group_rows or any(row["state"] == "locked_test" for row in group_rows):
                db.execute("ROLLBACK")
                raise PermissionError(
                    "A source family containing locked-test material cannot be assigned by curation"
                )
            group_metadata = [json.loads(row["metadata_json"]) for row in group_rows]
            if source["id"] == "emoreccom-panels" and any(
                item.get("book_identity_verified") is not True for item in group_metadata
            ):
                db.execute("ROLLBACK")
                raise PermissionError(
                    "Every EmoRecCom family member must have verified book identity"
                )
            existing_assignment = db.execute(
                "SELECT learning_split, membership_sha256 FROM family_split_assignments WHERE source_id = ? AND group_id = ? AND status = 'active'",
                (source["id"], group_id),
            ).fetchone()
            current_splits = [item.get("learning_split", "unassigned") for item in group_metadata]
            if existing_assignment:
                if existing_assignment["learning_split"] != request.learning_split or any(
                    value != request.learning_split for value in current_splits
                ):
                    db.execute("ROLLBACK")
                    raise PermissionError(
                        "This source-family split is immutable; recataloging cannot move it across partitions"
                    )
            elif any(
                value not in {"unassigned", request.learning_split} for value in current_splits
            ):
                db.execute("ROLLBACK")
                raise PermissionError(
                    "Related source-family assets must remain in one learning split"
                )
            needs_group_assignment = existing_assignment is None
            membership_sha256 = _family_membership_sha256(group_rows)
            group_split_complete = True
        labels = (
            request.labels.model_dump()
            if request.labels is not None
            else metadata.get("labels", {})
        )
        gallery_eligible_candidate = (
            request.decision == "keep"
            and request.labels is not None
            and (prototype or request.rights_status == "approved")
            and request.use_permissions.local_display
            and request.use_permissions.evaluation
            and labels["sfw"] == "safe"
            and labels["quality"] >= 2
            and labels["character_useful"]
            and metadata.get("decoder_status") == "decoded"
            and request.learning_split == "pilot_development"
            and group_split_complete
            and bool(group_id)
            and not labels["duplicate_of"]
            and not metadata.get("locked_test")
        )
        metadata.update(
            rights_status=request.rights_status,
            license_id=request.license_id,
            attribution_text=request.attribution_text,
            terms_snapshot_sha256=request.terms_snapshot_sha256,
            use_permissions=requested_permissions,
            labels=labels,
            viewpoint=payload.get("viewpoint"),
            learning_split=request.learning_split,
            review_status="approved" if request.decision in {"keep", "reject"} else "pending",
            gallery_member=False,
            gallery_eligible_candidate=gallery_eligible_candidate,
            curation_review={
                "review_id": str(review_id),
                "reviewer_id": request.reviewer_id,
                "reviewed_at": now,
                "decision": request.decision,
                "note": request.note,
                "source_registry_sha256": sha256_file(registry_file),
            },
        )
        if sample_item is not None and request.source_yield_judgment is not None:
            metadata["source_yield_review"] = {
                **request.source_yield_judgment.model_dump(mode="json"),
                "schema_version": 1,
                "reviewer_id": request.reviewer_id,
                "reviewed_at": now,
                "asset_sha256": asset["sha256"],
            }
        state = (
            "candidate"
            if request.decision == "keep"
            else "rejected"
            if request.decision == "reject"
            else "quarantined"
        )
        new_revision = int(asset["revision"]) + 1
        encoded = json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        db.execute(
            "INSERT INTO reviews(review_id, asset_id, expected_revision, reviewer_id, idempotency_key, decision, labels_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(review_id),
                asset_id,
                request.expected_revision,
                request.reviewer_id,
                str(request.idempotency_key),
                request.decision,
                request_json,
                now,
            ),
        )
        updated = db.execute(
            "UPDATE assets SET rights_status = ?, state = ?, revision = ?, metadata_json = ? WHERE asset_id = ? AND revision = ?",
            (
                request.rights_status,
                state,
                new_revision,
                encoded,
                asset_id,
                request.expected_revision,
            ),
        )
        if updated.rowcount != 1:
            db.execute("ROLLBACK")
            raise RuntimeError("Asset revision changed during review")
        if needs_group_assignment:
            for family_row in group_rows:
                if family_row["asset_id"] == asset_id:
                    continue
                family_metadata = json.loads(family_row["metadata_json"])
                family_metadata["learning_split"] = request.learning_split
                changed = db.execute(
                    "UPDATE assets SET revision = revision + 1, metadata_json = ? WHERE asset_id = ? AND revision = ?",
                    (
                        json.dumps(
                            family_metadata,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        family_row["asset_id"],
                        family_row["revision"],
                    ),
                )
                if changed.rowcount != 1:
                    db.execute("ROLLBACK")
                    raise RuntimeError(
                        "A source-family member changed during atomic split assignment"
                    )
            db.execute(
                """INSERT INTO family_split_assignments(assignment_id, source_id, group_id, learning_split,
                   member_count, membership_sha256, reviewer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    str(uuid4()),
                    source["id"],
                    group_id,
                    request.learning_split,
                    len(group_rows),
                    membership_sha256,
                    request.reviewer_id,
                    now,
                ),
            )
        db.execute("COMMIT")
        return CurationReviewResponse(
            review_id=review_id,
            asset_id=asset_id,
            revision=new_revision,
            state=state,
            gallery_member=False,
            gallery_eligible_candidate=gallery_eligible_candidate,
        )
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def review_history(settings: Settings, asset_id: str) -> list[dict[str, Any]]:
    db = connect(settings.metadata_db)
    try:
        rows = db.execute(
            "SELECT review_id, expected_revision, reviewer_id, decision, labels_json, created_at FROM reviews WHERE asset_id = ? ORDER BY created_at, review_id",
            (asset_id,),
        ).fetchall()
        return [
            {
                "review_id": row["review_id"],
                "expected_revision": row["expected_revision"],
                "reviewer_id": row["reviewer_id"],
                "decision": row["decision"],
                "review": json.loads(row["labels_json"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    finally:
        db.close()
