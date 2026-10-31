from __future__ import annotations

import math
import os

try:
    import resource
except ImportError:
    resource = None
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drawable_research_contracts import CurationSnapshotV1, validate_curation_snapshot_files
from drawable_research_contracts.readiness import (
    REQUIREMENTS_REVISION,
    EvidenceInputV1,
    GateReportV2,
    SourceSelectionProfileV1,
)
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from .inference import load_frozen_encoder
from .io import (
    MLError,
    load_json,
    resolve_private_path,
    sha256_file,
    sha256_json,
    write_json_atomic,
)
from .models import verify_model_registry

CPU_MODEL_IDS = ("mobileclip2-s2-dfndr2b", "dinov2-small")


def _percentile95(values: list[float]) -> float:
    if not values:
        raise MLError("No CPU inference measurements were collected")
    return sorted(values)[max(0, math.ceil(0.95 * len(values)) - 1)]


def _add_input(inputs: dict[str, str], root: Path, path: Path) -> None:
    resolved = path.resolve(strict=True)
    try:
        relative = resolved.relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise MLError("M0 evidence inputs must remain beneath the private data root") from error
    inputs[relative] = sha256_file(resolved)


def _review_gallery_permissions(
    root: Path,
    snapshot: CurationSnapshotV1,
    source_registry_path: Path,
    *,
    anita_terms_path: Path,
) -> tuple[list[Path], dict[str, int]]:
    registry = load_json(source_registry_path)
    registry_hash = sha256_file(source_registry_path)
    sources = {row.get("id"): row for row in registry.get("sources", []) if isinstance(row, dict)}
    anita_terms = load_json(anita_terms_path)
    works = {
        str(row.get("work_id", row.get("folder_id", ""))).casefold(): row
        for row in anita_terms.get("works", [])
        if isinstance(row, dict)
    }
    terms_inputs: list[Path] = []
    source_counts: dict[str, int] = {}
    for item in snapshot.items:
        source = sources.get(item.source_id)
        if (
            source is None
            or item.source_registry_sha256 != registry_hash
            or source.get("rights_status") != "approved"
            or source.get("terms_review", {}).get("status") != "approved"
            or source.get("terms_snapshot_sha256") != item.terms_snapshot_sha256
            or source.get("use_permissions", {}).get("local_display") is not True
            or source.get("use_permissions", {}).get("evaluation") is not True
            or not item.permissions.local_display
            or not item.permissions.evaluation
        ):
            raise MLError(f"Staging asset {item.asset_id} has no current local-display and evaluation permission")
        terms_path = resolve_private_path(
            root,
            f"manifests/terms/{item.source_id}/{item.terms_snapshot_sha256}.json",
        )
        if sha256_file(terms_path) != item.terms_snapshot_sha256:
            raise MLError(f"Terms snapshot changed for staging asset {item.asset_id}")
        terms_inputs.append(terms_path)
        if item.source_id == "anita-dataset":
            if item.source_work_terms_sha256 != sha256_file(anita_terms_path):
                raise MLError(f"Anita work terms changed for staging asset {item.asset_id}")
            work = works.get((item.source_work_id or "").casefold())
            if (
                work is None
                or work.get("rights_status") != "approved"
                or work.get("reviewer_decision") != "approved"
                or work.get("terms_snapshot_sha256") != item.terms_snapshot_sha256
                or work.get("use_permissions", {}).get("local_display") is not True
                or work.get("use_permissions", {}).get("evaluation") is not True
            ):
                raise MLError(f"Anita work permission is missing for staging asset {item.asset_id}")
        source_counts[item.source_id] = source_counts.get(item.source_id, 0) + 1
    return terms_inputs, source_counts


def measure_frozen_cpu(
    data_root: Path,
    snapshot_path: Path,
    model_registry_path: Path,
    source_registry_path: Path,
    anita_terms_path: Path,
    source_profile_path: Path,
    output_path: Path,
    *,
    repeats: int = 5,
) -> dict[str, Any]:
    """Measure the two frozen image encoders on a rights-checked, review-only staging set."""
    if not 5 <= repeats <= 100:
        raise MLError("CPU measurement repeats must be between 5 and 100")
    root = data_root.resolve(strict=True)
    snapshot_file = resolve_private_path(root, snapshot_path.as_posix())
    try:
        snapshot = CurationSnapshotV1.model_validate_json(snapshot_file.read_bytes())
        validate_curation_snapshot_files(snapshot, root)
    except (OSError, ValidationError, ValueError) as error:
        raise MLError(f"The M0 staging gallery is invalid: {error}") from error
    if snapshot.purpose != "pilot-development-review-only" or not 1 <= len(snapshot.items) <= 32:
        raise MLError("M0 model measurement requires a 1–32 asset review-only staging snapshot")
    profile_file = resolve_private_path(root, source_profile_path.as_posix())
    try:
        source_profile = SourceSelectionProfileV1.model_validate_json(profile_file.read_bytes())
    except (OSError, ValidationError, ValueError) as error:
        raise MLError(f"Selected-source profile is invalid: {error}") from error
    selected_sources = {item.source_id: item for item in source_profile.sources}
    for item in snapshot.items:
        selection = selected_sources.get(item.source_id)
        if (
            selection is None
            or "local_display" not in selection.operations
            or "evaluation" not in selection.operations
            or (item.source_id == "anita-dataset" and item.source_work_id not in selection.work_ids)
        ):
            raise MLError(f"Staging asset {item.asset_id} is outside the selected evaluation profile")
    terms_inputs, source_counts = _review_gallery_permissions(
        root, snapshot, source_registry_path, anita_terms_path=anita_terms_path
    )
    model_verification = verify_model_registry(
        root,
        model_registry_path,
        purpose="inference",
        model_ids=set(CPU_MODEL_IDS),
    )
    if model_verification["status"] != "complete":
        blocked = {
            row["model_id"]: row["blockers"]
            for row in model_verification["models"]
            if row["status"] != "complete"
        }
        raise MLError(f"Frozen CPU inference is blocked by model review or artifact checks: {blocked}")

    images: list[tuple[Any, Path]] = []
    image_inputs: list[Path] = []
    for item in snapshot.items:
        path = resolve_private_path(root, item.relative_path)
        try:
            with Image.open(path) as decoded:
                width, height = decoded.size
                if (width, height) != (item.width, item.height) or width * height > 40_000_000:
                    raise MLError(f"Staging image dimensions changed or exceed 40 megapixels: {item.asset_id}")
                decoded.load()
                image = decoded.convert("RGB")
        except MLError:
            raise
        except (OSError, UnidentifiedImageError, ValueError) as error:
            raise MLError(f"Could not decode staging image {item.asset_id}: {error}") from error
        images.append((image, path))
        image_inputs.append(path)

    try:
        import torch
    except ImportError as error:
        raise MLError("Install the locked ML CPU profile with --extra cpu before measuring models") from error
    threads = max(1, min(4, os.cpu_count() or 1))
    torch.set_num_threads(threads)
    input_hashes: dict[str, str] = {}
    _add_input(input_hashes, root, snapshot_file)
    _add_input(input_hashes, root, profile_file)
    for path in image_inputs + terms_inputs:
        _add_input(input_hashes, root, path)
    output_models: dict[str, dict[str, Any]] = {}
    model_registry = load_json(model_registry_path)
    model_rows = {row["id"]: row for row in model_registry["models"]}
    preprocessing_profiles = {
        model_id: model_rows[model_id].get("preprocessing_profile") for model_id in CPU_MODEL_IDS
    }
    model_preprocessing_hash = sha256_json(preprocessing_profiles)
    profile_snapshot = {
        "schema_version": 1,
        "model_registry_sha256": sha256_file(model_registry_path),
        "preprocessing_profiles": preprocessing_profiles,
        "model_preprocessing_sha256": model_preprocessing_hash,
    }
    profile_snapshot_path = resolve_private_path(
        root,
        f"reports/private/model-preprocessing-profiles/{model_preprocessing_hash}.json",
        must_exist=False,
    )
    if profile_snapshot_path.exists():
        if load_json(profile_snapshot_path) != profile_snapshot:
            raise MLError("Model preprocessing profile snapshot path exists with different bytes")
    else:
        write_json_atomic(profile_snapshot_path, profile_snapshot)
    _add_input(input_hashes, root, profile_snapshot_path)
    for model_id in CPU_MODEL_IDS:
        model_row = model_rows[model_id]
        terms_hash = model_row["terms_review"]["terms_snapshot_sha256"]
        terms_path = resolve_private_path(root, f"manifests/model-terms/{model_id}/{terms_hash}.json")
        _add_input(input_hashes, root, terms_path)
        artifact_file = resolve_private_path(root, f"models/{model_id}/artifact.json")
        _add_input(input_hashes, root, artifact_file)
        artifact = load_json(artifact_file)
        for file_row in artifact["files"]:
            path = resolve_private_path(root, f"models/{model_id}/files/{file_row['path']}")
            _add_input(input_hashes, root, path)
        load_started = time.perf_counter()
        encoder = load_frozen_encoder(root, model_id, model_registry_path)
        model_load_ms = (time.perf_counter() - load_started) * 1000
        first_image = images[0][0]
        encoder.encode(first_image)
        encoder.encode(first_image, view="tight")
        elapsed: list[float] = []
        for image, _path in images:
            for _ in range(repeats):
                started = time.perf_counter()
                vector = encoder.encode(image)
                elapsed.append((time.perf_counter() - started) * 1000)
                if vector.shape != (encoder.expected_dimension,):
                    raise MLError(f"{model_id} returned an invalid normalized feature vector")
        output_models[model_id] = {
            "revision": model_row["revision"],
            "weights_sha256": model_row["weights_sha256"],
            "artifact_manifest_sha256": model_row["artifact_manifest_sha256"],
            "embedding_dimension": encoder.expected_dimension,
            "preprocessing_profile_sha256": encoder.preprocessing_sha256,
            "device": "cpu",
            "load_ms": round(model_load_ms, 3),
            "forward_samples": len(elapsed),
            "cpu_p50_ms": round(sorted(elapsed)[max(0, math.ceil(0.50 * len(elapsed)) - 1)], 3),
            "cpu_p95_ms": round(_percentile95(elapsed), 3),
            "cpu_max_ms": round(max(elapsed), 3),
        }
        del encoder
        del vector
        del elapsed
    peak_rss_mib = (
        resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 if resource is not None else 0.0
    )
    model_file_bytes = sum(row["file_bytes"] for row in model_verification["models"])
    produced_at = datetime.now(UTC)
    measurements: dict[str, int | float | bool | str] = {
        "models_measured": len(output_models),
        "mobileclip_cpu_p95_ms": output_models[CPU_MODEL_IDS[0]]["cpu_p95_ms"],
        "dinov2_cpu_p95_ms": output_models[CPU_MODEL_IDS[1]]["cpu_p95_ms"],
        "peak_rss_mib": round(peak_rss_mib, 3),
        "artifact_disk_mib": round(model_file_bytes / (1024 * 1024), 3),
        "staging_assets": len(snapshot.items),
        "inference_repeats_per_asset": repeats,
        "cpu_threads": threads,
        "total_forward_samples_per_model": len(snapshot.items) * repeats,
    }
    gate_report = GateReportV2(
        schema_version=2,
        requirements_revision=REQUIREMENTS_REVISION,
        artifact_type="drawable-gate-report",
        gate_id="frozen_cpu_forward",
        producer="drawable-ml models measure-cpu",
        produced_at=produced_at,
        checks={
            "model_terms_reviewed": True,
            "frozen_weights_verified": True,
            "forward_pass_verified": True,
            "profile_accurate": True,
        },
        measurements=measurements,
        profile_hashes={
            "source_selection": sha256_file(profile_file),
            "model_preprocessing": model_preprocessing_hash,
        },
        inputs=[
            EvidenceInputV1(path=path, sha256=digest)
            for path, digest in sorted(input_hashes.items())
        ],
        summary=(
            f"Measured the pinned MobileCLIP2-S2 and DINOv2-small frozen encoders on CPU using "
            f"{len(snapshot.items)} approved staging assets, {repeats} repeats per asset, and {threads} CPU threads."
        ),
    )
    target = output_path if output_path.is_absolute() else root / output_path
    try:
        target.resolve(strict=False).relative_to(root)
    except ValueError as error:
        raise MLError("CPU measurement output must remain inside the private data root") from error
    write_json_atomic(target, gate_report.model_dump(mode="json"), refuse_overwrite=True)
    return {
        "schema_version": 1,
        "status": "measured_pending_owner_review",
        "gate_report_path": target.relative_to(root).as_posix(),
        "gate_report_sha256": sha256_file(target),
        "gate_id": "frozen_cpu_forward",
        "measurement_profile": "frozen_cpu_forward_only",
        "gpu_probed": False,
        "network_used": False,
        "training_started": False,
        "data_uploaded": False,
        "source_counts": source_counts,
        "models": output_models,
        "measurements": measurements,
    }
