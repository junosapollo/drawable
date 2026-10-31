"""Shared, evidence-bound readiness contracts for API and ML tooling.

File presence is never evidence. An owner attestation points to a versioned
measurement report, and the validator rechecks both that report and every
input hash before marking a gate verified.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import Field, field_validator

from .viewpoint import SHA256_PATTERN, StrictModel

REQUIREMENTS_REVISION: Literal["2026-10-04-practical-r1"] = "2026-10-04-practical-r1"


class GateSpec(StrictModel):
    gate_id: str
    milestone: Literal[
        "m0", "m1", "pilot", "m3", "m5", "m6", "m7",
        "training_preparation", "training_execution",
    ]
    title: str
    required_checks: tuple[str, ...] = ()
    required_measurements: tuple[str, ...] = ()
    minimums: dict[str, int] = Field(default_factory=dict)
    maximums: dict[str, int | float] = Field(default_factory=dict)
    required_profile_hashes: tuple[str, ...] = ()


class EvidenceInputV1(StrictModel):
    path: str = Field(min_length=1, max_length=1000)
    sha256: str = Field(pattern=SHA256_PATTERN.pattern)

    @field_validator("path")
    @classmethod
    def safe_relative_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or "\\" in value or "\x00" in value:
            raise ValueError(
                "Evidence paths must be normalized and relative to the private data root"
            )
        return value


PermissionName = Literal[
    "local_display", "training", "evaluation", "derive", "trace", "export",
    "public_demo", "redistribute", "cloud_storage", "cloud_processing",
]


class SelectedSourceV1(StrictModel):
    source_id: str = Field(min_length=1, max_length=160)
    acquisition_method: Literal["official_archive", "official_api", "project_created"]
    work_ids: list[str] = Field(default_factory=list, max_length=500)
    operations: list[PermissionName] = Field(min_length=1)
    acquisition_evidence: list[EvidenceInputV1] = Field(default_factory=list, max_length=1000)

    @field_validator("work_ids", "operations")
    @classmethod
    def values_are_unique(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("Selected source work IDs and operations must be unique")
        return value


class SourceSelectionProfileV1(StrictModel):
    schema_version: Literal[1]
    profile_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
    sources: list[SelectedSourceV1] = Field(min_length=1, max_length=1000)

    @field_validator("sources")
    @classmethod
    def source_ids_are_unique(cls, value: list[SelectedSourceV1]) -> list[SelectedSourceV1]:
        ids = [item.source_id for item in value]
        if len(ids) != len(set(ids)):
            raise ValueError("Selected source IDs must be unique")
        return value


class GateReportV1(StrictModel):
    schema_version: Literal[1]
    artifact_type: Literal["drawable-gate-report"]
    gate_id: str = Field(min_length=1, max_length=100)
    producer: str = Field(min_length=1, max_length=120)
    produced_at: datetime
    checks: dict[str, bool]
    measurements: dict[str, int | float | bool | str]
    inputs: list[EvidenceInputV1] = Field(min_length=1)
    summary: str = Field(min_length=1, max_length=2000)

    @field_validator("produced_at")
    @classmethod
    def timestamp_has_timezone(cls, value: datetime) -> datetime:
        if value.utcoffset() is None or value > datetime.now(UTC):
            raise ValueError("Gate reports require a current, timezone-aware timestamp")
        return value


class GateReportV2(StrictModel):
    """Current evidence contract, tied to the requirements and selected profiles."""

    schema_version: Literal[2]
    requirements_revision: Literal["2026-10-04-practical-r1"]
    artifact_type: Literal["drawable-gate-report"]
    gate_id: str = Field(min_length=1, max_length=100)
    producer: str = Field(min_length=1, max_length=120)
    produced_at: datetime
    checks: dict[str, bool]
    measurements: dict[str, int | float | bool | str]
    profile_hashes: dict[str, str] = Field(default_factory=dict)
    inputs: list[EvidenceInputV1] = Field(min_length=1)
    summary: str = Field(min_length=1, max_length=2000)

    @field_validator("produced_at")
    @classmethod
    def timestamp_has_timezone(cls, value: datetime) -> datetime:
        if value.utcoffset() is None or value > datetime.now(UTC):
            raise ValueError("Gate reports require a current, timezone-aware timestamp")
        return value

    @field_validator("measurements")
    @classmethod
    def measurements_are_finite(
        cls, value: dict[str, int | float | bool | str]
    ) -> dict[str, int | float | bool | str]:
        for item in value.values():
            if isinstance(item, float) and not math.isfinite(item):
                raise ValueError("Evidence measurements must be finite")
        return value

    @field_validator("profile_hashes")
    @classmethod
    def profile_hashes_are_sha256(cls, value: dict[str, str]) -> dict[str, str]:
        for digest in value.values():
            if not SHA256_PATTERN.fullmatch(digest):
                raise ValueError("Profile identities must be SHA-256 hashes")
        return value


class GateAttestationV1(StrictModel):
    schema_version: Literal[1]
    gate_id: str = Field(min_length=1, max_length=100)
    report_path: str = Field(min_length=1, max_length=1000)
    report_sha256: str = Field(pattern=SHA256_PATTERN.pattern)
    reviewer_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
    reviewed_at: datetime
    review_note: str = Field(min_length=12, max_length=2000)

    @field_validator("report_path")
    @classmethod
    def safe_report_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or "\\" in value or "\x00" in value:
            raise ValueError("Evidence report must stay beneath the private data root")
        return value

    @field_validator("reviewed_at")
    @classmethod
    def reviewed_timestamp_has_timezone(cls, value: datetime) -> datetime:
        if value.utcoffset() is None or value > datetime.now(UTC):
            raise ValueError("Owner review time must be current and timezone-aware")
        return value


class ReadinessLedgerV1(StrictModel):
    schema_version: Literal[1]
    attestations: dict[str, GateAttestationV1]


SPECS: tuple[GateSpec, ...] = (
    GateSpec(
        gate_id="official_archive_reconciliation",
        milestone="m0",
        title="Official archives and clean extraction reconciliation",
        required_checks=(
            "receipts_verified",
            "archives_hash_verified",
            "clean_extractions_reconciled",
            "acquisition_methods_evidenced",
        ),
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="source_work_rights_review",
        milestone="m0",
        title="Source and work permission review",
        required_checks=(
            "source_terms_reviewed",
            "work_terms_reviewed",
            "actual_use_permissions_recorded",
            "terms_snapshots_hashed",
            "training_rights_decided",
            "local_display_rights_decided",
            "derive_rights_decided",
            "trace_rights_decided",
            "export_rights_decided",
            "publication_rights_decided",
            "demonstration_rights_decided",
            "permissions_recorded_per_source_and_work",
            "selected_profile_reviewed",
            "unselected_rows_quarantined",
        ),
        required_measurements=(
            "sources_reviewed",
            "works_reviewed",
            "permission_decisions_recorded",
        ),
        minimums={"sources_reviewed": 1, "permission_decisions_recorded": 1},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="source_yield_review",
        milestone="m0",
        title="Fixed, timed source and viewpoint yield review",
        required_checks=(
            "sample_identity_verified",
            "owner_judgments_complete",
            "review_time_measured",
        ),
        required_measurements=(
            "reviewed_candidates",
            "median_review_seconds_per_candidate",
            "useful_eye_crop_candidates",
            "viewpoint_identifiable_candidates",
            "ambiguous_viewpoint_candidates",
        ),
        minimums={"reviewed_candidates": 1},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="ten_feasibility_sequences",
        milestone="m0",
        title="Ten consented and replay-verified feasibility recordings",
        required_checks=("consent_rechecked", "replay_verified", "render_hashes_verified"),
        minimums={"accepted_sequences": 10},
    ),
    GateSpec(
        gate_id="human_effort_storage",
        milestone="m0",
        title="Owner effort, disk and projected review cost",
        required_checks=(
            "active_effort_measured",
            "storage_headroom_checked",
        ),
        required_measurements=(
            "pilot_annotation_minutes",
            "disk_free_gib",
            "projected_review_hours_for_full_program",
        ),
        maximums={"pilot_annotation_minutes": 600},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="small_approved_gallery",
        milestone="m0",
        title="Small, individually approved, permitted gallery",
        required_checks=(
            "rights_rechecked",
            "every_asset_reviewed",
            "checksums_verified",
            "staging_build_valid",
        ),
        required_measurements=("approved_assets", "source_families"),
        minimums={"approved_assets": 1, "source_families": 1},
    ),
    GateSpec(
        gate_id="frozen_cpu_forward",
        milestone="m0",
        title="Hash-pinned frozen-model CPU forward and resource measurements",
        required_checks=(
            "model_terms_reviewed",
            "frozen_weights_verified",
            "forward_pass_verified",
            "profile_accurate",
        ),
        required_measurements=(
            "models_measured",
            "mobileclip_cpu_p95_ms",
            "dinov2_cpu_p95_ms",
            "peak_rss_mib",
            "artifact_disk_mib",
        ),
        minimums={"models_measured": 2},
        maximums={"mobileclip_cpu_p95_ms": 10000, "dinov2_cpu_p95_ms": 10000},
        required_profile_hashes=("source_selection", "model_preprocessing"),
    ),
    GateSpec(
        gate_id="clean_clone_ci",
        milestone="m1",
        title="Reproducible clean checkout and CI checks",
        required_checks=(
            "frontend_ci_passed",
            "python_ci_passed",
            "contract_drift_passed",
            "clean_checkout",
        ),
    ),
    GateSpec(
        gate_id="bounded_search_api",
        milestone="m1",
        title="Bounded search API and cancellation contract",
        required_checks=(
            "multipart_limits_enforced",
            "generation_races_tested",
            "queue_bounded",
            "health_responsive",
        ),
        required_measurements=(
            "queue_capacity",
            "queue_capacity_excess_rejected",
            "stale_responses_applied",
        ),
        minimums={"queue_capacity": 1},
        maximums={"stale_responses_applied": 0},
    ),
    GateSpec(
        gate_id="curation_workflow",
        milestone="m1",
        title="Versioned human review, viewpoint and prefix workflow",
        required_checks=(
            "proposals_stay_unapproved",
            "split_history_validated",
            "prefix_reviews_supported",
        ),
    ),
    GateSpec(
        gate_id="offline_runtime",
        milestone="m1",
        title="Installed real-mode no-network startup",
        required_checks=(
            "real_mode_honestly_not_ready",
            "fixture_mode_starts",
            "network_disabled_runtime_tested",
        ),
    ),
    GateSpec(
        gate_id="fresh_clone_report",
        milestone="m1",
        title="Reproduction report from a fresh local checkout",
        required_checks=(
            "private_data_excluded",
            "source_tree_hashes_recorded",
            "offline_report_complete",
        ),
    ),
    GateSpec(
        gate_id="pilot_gallery",
        milestone="pilot",
        title="Approved 200–500 asset pilot gallery",
        required_checks=(
            "rights_and_asset_review_passed",
            "build_validated",
            "five_style_gaps_reported",
        ),
        minimums={"enabled_assets": 200},
        maximums={"enabled_assets": 500},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="pilot_frozen_cpu_retrieval",
        milestone="pilot",
        title="Frozen-model local CPU end-to-end search",
        required_checks=(
            "real_encoder_used",
            "current_build_served",
            "cpu_latency_measured",
            "offline_search_verified",
        ),
        required_measurements=(
            "cpu_search_p95_ms",
            "requests_completed",
            "stale_responses_applied",
        ),
        minimums={"requests_completed": 1},
        maximums={"cpu_search_p95_ms": 10000, "stale_responses_applied": 0},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="pilot_report",
        milestone="pilot",
        title="Descriptive pilot report with viewpoint slice",
        required_checks=(
            "recognition_failures_separated",
            "ranking_failures_separated",
            "gallery_gaps_reported",
            "results_marked_experimental",
        ),
        required_measurements=("pilot_queries", "viewpoint_queries", "viewpoint_cells_available"),
        minimums={"pilot_queries": 20},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="pilot_drawings",
        milestone="pilot",
        title="Twenty development-only drawings",
        required_checks=("consent_rechecked", "prefixes_reviewed", "development_only_split"),
        minimums={"development_drawings": 20},
    ),
    GateSpec(
        gate_id="document_correctness",
        milestone="pilot",
        title="Document portability, recovery and renderer checks",
        required_checks=(
            "migration_verified",
            "worker_parity_verified",
            "capacity_and_recovery_verified",
            "portable_roundtrip_verified",
        ),
    ),
    GateSpec(
        gate_id="development_data_adequacy",
        milestone="m3",
        title="Reviewed, leakage-checked data adequate for a bounded development recipe",
        required_checks=(
            "profile_scoped",
            "development_data_reviewed",
            "source_query_families_covered",
            "protected_inputs_excluded",
            "limitations_reported",
        ),
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="gold_references_2000",
        milestone="m6",
        title="Two thousand accepted human-reviewed gold references",
        required_checks=(
            "every_gold_asset_reviewed",
            "gold_quotas_passed",
            "rights_and_safety_rechecked",
        ),
        minimums={"accepted_gold_assets": 2000},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="enabled_gallery_10000",
        milestone="m6",
        title="Ten thousand approved enabled references",
        required_checks=(
            "scope_style_quotas_passed",
            "asset_rights_rechecked",
            "every_enabled_asset_approved",
        ),
        minimums={"enabled_assets": 10000},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="candidate_pool_coverage",
        milestone="m6",
        title="Candidate processing and measured rejection/yield",
        required_checks=("candidate_yield_reported", "rejection_counts_reported"),
        minimums={"screened_candidates": 20000},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="family_splits_and_gallery",
        milestone="m3",
        title="Versioned, leakage-checked development gallery",
        required_checks=(
            "source_families_grouped",
            "near_duplicates_grouped",
            "development_candidate_universe_verified",
            "development_gallery_versioned",
        ),
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="final_gallery_freeze",
        milestone="m6",
        title="Full qualification gallery and selected artifacts frozen",
        required_checks=(
            "final_gallery_build_frozen",
            "selected_profile_complete",
            "all_artifact_hashes_verified",
            "profile_accurate_preprocessing_verified",
        ),
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="full_query_corpus",
        milestone="m6",
        title="Expanded 170 in-domain query drawings",
        required_checks=("consent_rechecked", "scope_quotas_reported", "sequences_family_split"),
        minimums={"in_domain_drawings": 170},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="unknown_query_corpus",
        milestone="m6",
        title="Thirty unknown/ambiguous queries",
        required_checks=("consent_rechecked", "heldout_unknown_drawings_protected"),
        minimums={"unknown_drawings": 30},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="locked_test_corpus",
        milestone="m6",
        title="Sealed 250-query in-domain confirmatory set",
        required_checks=(
            "query_snapshots_frozen",
            "no_locked_test_rankings_generated",
            "no_test_labels_used_for_model_selection",
        ),
        minimums={"in_domain_locked_queries": 250},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="protected_holdout",
        milestone="m3",
        title="Protected thresholds, calibration and locked test partitions",
        required_checks=(
            "query_splits_verified",
            "asset_splits_verified",
            "no_test_rankings_generated",
            "single_creator_disclosed",
        ),
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="frozen_comparator",
        milestone="m3",
        title="Shared-gallery frozen comparator development report",
        required_checks=(
            "bigg_checkpoint_and_terms_verified",
            "same_gallery_verified",
            "mobileclip_comparator_run",
            "development_only_results",
            "baseline_feasibility_reported",
            "ndcg_gain_target_feasibility_documented",
        ),
        required_measurements=("comparator_ndcg_at_8", "mobileclip_ndcg_at_8"),
        maximums={"comparator_ndcg_at_8": 1, "mobileclip_ndcg_at_8": 1},
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="relevance_judgments",
        milestone="m5",
        title="Shared blinded relevance pools for selection and calibration",
        required_checks=(
            "system_identity_hidden",
            "missing_judgments_block_metrics",
            "fixed_k_metrics_verified",
        ),
        minimums={
            "training_pairs": 2000,
            "training_prefixes": 100,
            "model_selection_pairs": 300,
            "threshold_pairs": 300,
            "calibration_audit_pairs": 400,
        },
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="viewpoint_protocol",
        milestone="m3",
        title="Frozen rubric, challenge set and owner-reviewed viewpoint targets",
        required_checks=(
            "prefix_labels_use_visible_prefix",
            "viewpoint_axes_separate",
            "challenge_pool_frozen",
            "numerical_targets_owner_approved",
            "independent_review_gap_disclosed",
        ),
        required_measurements=(
            "same_near_pairs",
            "incompatible_view_pairs",
            "ambiguous_prefixes",
            "viewpoint_cells_available",
        ),
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="confirmatory_evaluation",
        milestone="m7",
        title="One-time protected confirmatory evaluation",
        required_checks=(
            "artifacts_and_protocol_frozen_before_rankings",
            "shared_blinded_judgments_complete",
            "all_release_gates_reported",
            "limitations_and_failures_reported",
        ),
        required_profile_hashes=("source_selection",),
    ),
    GateSpec(
        gate_id="model_terms_and_profiles",
        milestone="training_preparation",
        title="Separate inference, training and cloud-processing model terms",
        required_checks=(
            "exact_model_bytes_verified",
            "inference_terms_reviewed",
            "training_and_derivative_terms_reviewed",
            "cloud_profile_recorded",
        ),
    ),
    GateSpec(
        gate_id="training_manifest_validated",
        milestone="training_preparation",
        title="Train/model-selection manifest schema and leakage validation",
        required_checks=(
            "train_and_model_selection_only",
            "rights_and_consent_verified",
            "protected_splits_excluded",
            "viewpoint_versions_compatible",
        ),
    ),
    GateSpec(
        gate_id="manual_bundle_inspected",
        milestone="training_preparation",
        title="Separately permitted Colab bundle reviewed and hash-verified",
        required_checks=(
            "cloud_storage_consent",
            "cloud_processing_permissions",
            "bundle_hash_verified",
            "manual_transfer_inspected",
        ),
    ),
    GateSpec(
        gate_id="experiment_recipe_frozen",
        milestone="training_preparation",
        title="Reproducible training recipe bound to code and data hashes",
        required_checks=(
            "recipe_schema_validated",
            "recipe_hash_bound",
            "optimizer_and_precision_recipe_reviewed",
        ),
    ),
    GateSpec(
        gate_id="training_execution_loop",
        milestone="training_execution",
        title="Owner-reviewed trainer implementation and checkpoint resume tests",
        required_checks=("run_entry_point_tested", "resume_verified", "protected_splits_blocked"),
    ),
    GateSpec(
        gate_id="backward_feasibility",
        milestone="training_execution",
        title="Separately authorized Colab forward/backward feasibility",
        required_checks=(
            "exact_runtime_recorded",
            "approved_inputs_only",
            "memory_and_precision_measured",
        ),
    ),
    GateSpec(
        gate_id="expiring_training_authorization",
        milestone="training_execution",
        title="Purpose-, hash-, step- and time-bounded owner authorization",
        required_checks=("authorization_current", "all_hashes_match", "step_and_time_limits_set"),
    ),
)

SPEC_BY_ID = {spec.gate_id: spec for spec in SPECS}

STAGES: dict[str, tuple[str, ...]] = {
    "m0": tuple(spec.gate_id for spec in SPECS if spec.milestone == "m0"),
    "m1": tuple(spec.gate_id for spec in SPECS if spec.milestone in {"m0", "m1"}),
    "pilot": tuple(spec.gate_id for spec in SPECS if spec.milestone in {"m0", "m1", "pilot"}),
    "m2": tuple(spec.gate_id for spec in SPECS if spec.milestone in {"m0", "m1", "pilot"}),
    "m3": tuple(spec.gate_id for spec in SPECS if spec.milestone in {"m0", "m1", "pilot", "m3"}),
    "m5": tuple(spec.gate_id for spec in SPECS if spec.milestone in {"m0", "m1", "pilot", "m3", "m5"}),
    "m6": tuple(spec.gate_id for spec in SPECS if spec.milestone in {"m0", "m1", "pilot", "m3", "m5", "m6"}),
    "m7": tuple(spec.gate_id for spec in SPECS if spec.milestone in {"m0", "m1", "pilot", "m3", "m5", "m6", "m7"}),
    "training_preparation": tuple(
        spec.gate_id
        for spec in SPECS
        if spec.milestone in {"m0", "m1", "pilot", "m3", "training_preparation"}
    ),
    "training": tuple(
        spec.gate_id
        for spec in SPECS
        if spec.milestone in {"m0", "m1", "pilot", "m3", "training_preparation"}
    ),
    "training_execution": tuple(
        spec.gate_id
        for spec in SPECS
        if spec.milestone
        in {"m0", "m1", "pilot", "m3", "training_preparation", "training_execution"}
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _private_file(root: Path, relative: str) -> Path:
    relative_path = PurePosixPath(relative)
    if (
        not relative
        or relative_path.is_absolute()
        or ".." in relative_path.parts
        or "\\" in relative
        or "\x00" in relative
        or relative_path.as_posix() != relative
    ):
        raise ValueError("Evidence paths must be normalized and beneath the private data root")
    path = root.joinpath(*PurePosixPath(relative).parts)
    cursor = path
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError("Evidence may not traverse symbolic links")
        cursor = cursor.parent
    resolved = path.resolve(strict=True)
    if resolved == root or root not in resolved.parents or not resolved.is_file():
        raise ValueError("Evidence file must be beneath the private data root")
    return resolved


def _validate_gate_report(root: Path, gate_id: str, report_path: str) -> tuple[GateReportV2, Path]:
    spec = SPEC_BY_ID.get(gate_id)
    if spec is None:
        raise ValueError("Unknown readiness gate")
    path = _private_file(root, report_path)
    raw_report = path.read_bytes()
    try:
        parsed_report = json.loads(raw_report)
        report_schema = parsed_report.get("schema_version") if isinstance(parsed_report, dict) else None
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("Gate report is not valid JSON") from error
    if report_schema == 1:
        raise ValueError(
            "Schema-v1 gate evidence is historical and cannot attest the revised requirements"
        )
    report = GateReportV2.model_validate_json(raw_report)
    if report.gate_id != gate_id:
        raise ValueError("Report is bound to a different readiness gate")
    missing_profiles = [
        key for key in spec.required_profile_hashes if key not in report.profile_hashes
    ]
    if missing_profiles:
        raise ValueError(f"Selected profile hashes are missing: {', '.join(missing_profiles)}")
    missing_checks = [key for key in spec.required_checks if report.checks.get(key) is not True]
    if missing_checks:
        raise ValueError(f"Required checks did not pass: {', '.join(missing_checks)}")
    missing_measurements = [
        name
        for name in spec.required_measurements
        if type(report.measurements.get(name)) not in {int, float}
    ]
    if missing_measurements:
        raise ValueError(
            f"Required numeric measurements are missing: {', '.join(missing_measurements)}"
        )
    negative_measurements: list[str] = []
    for name in spec.required_measurements:
        observed = report.measurements[name]
        if (type(observed) is int and observed < 0) or (type(observed) is float and observed < 0):
            negative_measurements.append(name)
    if negative_measurements:
        raise ValueError(
            f"Required measurements cannot be negative: {', '.join(negative_measurements)}"
        )
    if gate_id == "frozen_cpu_forward" and report.measurements["peak_rss_mib"] <= 0:
        raise ValueError("Measurement peak_rss_mib must be greater than zero")
    for name, minimum in spec.minimums.items():
        minimum_observed = report.measurements.get(name)
        if type(minimum_observed) is not int or minimum_observed < minimum:
            raise ValueError(f"Measurement {name} must be an integer >= {minimum}")
    for name, maximum in spec.maximums.items():
        maximum_observed = report.measurements.get(name)
        if type(maximum_observed) is int:
            numeric_observed: int | float = maximum_observed
        elif type(maximum_observed) is float:
            numeric_observed = maximum_observed
        else:
            raise ValueError(f"Measurement {name} must be <= {maximum}")
        if numeric_observed > maximum:
            raise ValueError(f"Measurement {name} must be <= {maximum}")
        if (
            name == "pilot_annotation_minutes"
            and numeric_observed >= 300
            and report.checks.get("five_hour_checkpoint_completed") is not True
        ):
            raise ValueError(
                "The five-hour annotation checkpoint must be recorded at or after 300 minutes"
            )
        if (
            name == "pilot_annotation_minutes"
            and numeric_observed >= 600
            and report.checks.get("annotation_stopped_at_budget") is not True
        ):
            raise ValueError("The 10-hour pilot annotation hard stop must be recorded")
    for item in report.inputs:
        source = _private_file(root, item.path)
        if sha256_file(source) != item.sha256:
            raise ValueError(f"Input checksum changed: {item.path}")
    return report, path


def validate_readiness(data_root: Path, stage: str, ledger_path: Path | None) -> dict[str, Any]:
    if stage not in STAGES:
        raise ValueError(f"Unknown readiness stage: {stage}")
    root = data_root.resolve()
    attestations: dict[str, GateAttestationV1] = {}
    invalid: dict[str, str] = {}
    if ledger_path is not None:
        candidate = ledger_path if ledger_path.is_absolute() else root / ledger_path
        try:
            ledger_relative = candidate.absolute().relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError("Readiness ledger must be inside the private data root") from error
        ledger_path = _private_file(root, ledger_relative)
        ledger = ReadinessLedgerV1.model_validate_json(ledger_path.read_bytes())
        attestations = ledger.attestations
        for gate_id, attestation in attestations.items():
            try:
                if attestation.gate_id != gate_id:
                    raise ValueError("Unknown gate or attestation identity mismatch")
                report_path = _private_file(root, attestation.report_path)
                if sha256_file(report_path) != attestation.report_sha256:
                    raise ValueError("Owner-attested report checksum changed")
                _validate_gate_report(root, gate_id, attestation.report_path)
            except (OSError, TypeError, ValueError) as error:
                invalid[gate_id] = str(error)

    required = STAGES[stage]
    verified = [gate for gate in required if gate in attestations and gate not in invalid]
    missing = {
        gate: f"evidence_invalid:{invalid[gate]}"
        if gate in invalid
        else "owner-reviewed_evidence_missing"
        for gate in required
        if gate not in verified
    }
    m3_complete = all(gate in attestations and gate not in invalid for gate in STAGES["m3"])
    m5_complete = all(gate in attestations and gate not in invalid for gate in STAGES["m5"])
    m6_complete = all(gate in attestations and gate not in invalid for gate in STAGES["m6"])
    m7_complete = all(gate in attestations and gate not in invalid for gate in STAGES["m7"])
    preparation_complete = all(
        gate in attestations and gate not in invalid for gate in STAGES["training_preparation"]
    )
    execution_gates_present = all(
        gate in attestations and gate not in invalid for gate in STAGES["training_execution"]
    )
    return {
        "schema_version": 2,
        "requirements_revision": REQUIREMENTS_REVISION,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "stage": stage,
        "status": "complete" if not missing else "blocked",
        "m3_complete": m3_complete,
        "m5_complete": m5_complete,
        "m6_complete": m6_complete,
        "m7_complete": m7_complete,
        "preparation_complete": preparation_complete,
        "execution_status": "blocked",
        "trainer_implementation_status": "not_implemented",
        "training_execution_evidence_complete": execution_gates_present,
        "training_authorized": False,
        "training_started": False,
        "optimizer_created": False,
        "backward_passes_run": False,
        "data_uploaded": False,
        "gpu_status": "not_probed",
        "required_gates": list(required),
        "verified_evidence": {
            gate: {
                "report_path": attestations[gate].report_path,
                "sha256": attestations[gate].report_sha256,
                "reviewed_by": attestations[gate].reviewer_id,
            }
            for gate in verified
        },
        "blockers": missing,
        "training_execution_blockers": [
            "trainer_run_resume_command_not_implemented",
            *(
                gate
                for gate in STAGES["training_execution"]
                if gate not in attestations or gate in invalid
            ),
        ],
    }


def attest_gate(
    data_root: Path,
    gate_id: str,
    report_path: str,
    reviewer_id: str,
    note: str,
    ledger_path: Path | None,
) -> tuple[ReadinessLedgerV1, dict[str, Any]]:
    if gate_id not in SPEC_BY_ID:
        raise ValueError("Unknown readiness gate")
    root = data_root.resolve()
    report, report_file = _validate_gate_report(root, gate_id, report_path)
    current = ReadinessLedgerV1(schema_version=1, attestations={})
    if ledger_path is not None:
        candidate = ledger_path if ledger_path.is_absolute() else root / ledger_path
        try:
            ledger_relative = candidate.absolute().relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError("Existing ledger must remain inside the private data root") from error
        resolved = _private_file(root, ledger_relative)
        current = ReadinessLedgerV1.model_validate_json(resolved.read_bytes())
    attestation = GateAttestationV1(
        schema_version=1,
        gate_id=gate_id,
        report_path=report_file.relative_to(root).as_posix(),
        report_sha256=sha256_file(report_file),
        reviewer_id=reviewer_id,
        reviewed_at=datetime.now(UTC),
        review_note=note,
    )
    attestations = dict(current.attestations)
    attestations[gate_id] = attestation
    next_ledger = ReadinessLedgerV1(schema_version=1, attestations=attestations)
    return next_ledger, report.model_dump(mode="json")
