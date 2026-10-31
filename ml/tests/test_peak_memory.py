from __future__ import annotations

import builtins
import ctypes
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from drawable_ml import feasibility, peak_memory
from drawable_ml.io import MLError


@pytest.mark.parametrize(
    ("platform", "peak", "expected"),
    [
        ("linux", 8192, 8.0),  # Linux resource values are KiB.
        ("darwin", 8 * 1024 * 1024, 8.0),  # macOS values are bytes.
    ],
)
def test_resource_peak_memory_is_converted_to_mib(monkeypatch, platform, peak, expected) -> None:
    monkeypatch.setattr(peak_memory.sys, "platform", platform)
    monkeypatch.setattr(
        peak_memory,
        "import_module",
        lambda _: SimpleNamespace(RUSAGE_SELF=0, getrusage=lambda _: SimpleNamespace(ru_maxrss=peak)),
    )
    assert peak_memory.peak_rss_mib() == expected


def test_windows_peak_memory_is_converted_from_bytes(monkeypatch) -> None:
    monkeypatch.setattr(peak_memory.sys, "platform", "win32")
    monkeypatch.setattr(peak_memory, "_windows_peak_rss_bytes", lambda: 12 * 1024 * 1024)
    assert peak_memory.peak_rss_mib() == 12.0


def test_windows_api_failure_is_reported_as_measurement_error(monkeypatch) -> None:
    class NativeFunction:
        def __init__(self, callback):
            self.callback = callback

        def __call__(self, *args):
            return self.callback(*args)

    kernel32 = SimpleNamespace(GetCurrentProcess=NativeFunction(lambda: 42))
    psapi = SimpleNamespace(GetProcessMemoryInfo=NativeFunction(lambda *_: 0))

    def load_library(name, **_):
        return kernel32 if name == "kernel32" else psapi

    monkeypatch.setattr(ctypes, "WinDLL", load_library, raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
    with pytest.raises(MLError, match=r"Windows could not read process peak memory \(error 5\)"):
        peak_memory._windows_peak_rss_bytes()


@pytest.mark.parametrize("peak", [0, -1, math.inf, math.nan])
def test_nonpositive_or_nonfinite_memory_is_rejected(monkeypatch, peak) -> None:
    monkeypatch.setattr(peak_memory.sys, "platform", "linux")
    monkeypatch.setattr(
        peak_memory,
        "import_module",
        lambda _: SimpleNamespace(RUSAGE_SELF=0, getrusage=lambda _: SimpleNamespace(ru_maxrss=peak)),
    )
    with pytest.raises(MLError, match="invalid process peak-memory"):
        peak_memory.peak_rss_mib()


def test_missing_resource_counter_fails_clearly(monkeypatch) -> None:
    monkeypatch.setattr(peak_memory.sys, "platform", "linux")

    def unavailable(_):
        raise ImportError("unavailable")

    monkeypatch.setattr(peak_memory, "import_module", unavailable)
    with pytest.raises(MLError, match="Could not read process peak memory on Linux"):
        peak_memory.peak_rss_mib()


def test_unsupported_platform_fails_clearly(monkeypatch) -> None:
    monkeypatch.setattr(peak_memory.sys, "platform", "freebsd")
    with pytest.raises(MLError, match="not supported on freebsd"):
        peak_memory.peak_rss_mib()


def test_native_peak_memory_counter_is_positive() -> None:
    assert peak_memory.peak_rss_mib() > 0


def _mocked_feasibility_inputs(tmp_path: Path, monkeypatch):
    root = tmp_path / "data"
    root.mkdir()
    snapshot_path = root / "snapshot.json"
    snapshot_path.write_text("{}", encoding="utf-8")
    source_profile_path = root / "source-profile.json"
    source_profile_path.write_text("{}", encoding="utf-8")
    source_registry_path = root / "source-registry.json"
    source_registry_path.write_text("{}", encoding="utf-8")
    anita_terms_path = root / "anita-terms.json"
    anita_terms_path.write_text("{}", encoding="utf-8")
    evidence_path = root / "input.json"
    evidence_path.write_text('{"approved":true}\n', encoding="utf-8")
    image_path = root / "references" / "asset.png"
    image_path.parent.mkdir()
    Image.new("RGB", (2, 2), color="white").save(image_path)

    item = SimpleNamespace(
        source_id="source-1",
        source_work_id=None,
        relative_path="references/asset.png",
        width=2,
        height=2,
        asset_id="asset-1",
    )
    snapshot = SimpleNamespace(purpose="pilot-development-review-only", items=[item])
    source_selection = SimpleNamespace(
        source_id="source-1", operations={"local_display", "evaluation"}, work_ids=set()
    )
    source_profile = SimpleNamespace(sources=[source_selection])
    monkeypatch.setattr(
        feasibility.CurationSnapshotV1,
        "model_validate_json",
        classmethod(lambda cls, *_args, **_kwargs: snapshot),
    )
    monkeypatch.setattr(
        feasibility.SourceSelectionProfileV1,
        "model_validate_json",
        classmethod(lambda cls, *_args, **_kwargs: source_profile),
    )
    monkeypatch.setattr(feasibility, "validate_curation_snapshot_files", lambda *_: None)
    monkeypatch.setattr(feasibility, "_review_gallery_permissions", lambda *_args, **_kwargs: ([], {}))

    model_ids = feasibility.CPU_MODEL_IDS
    model_registry_path = root / "models.json"
    model_rows = []
    for index, model_id in enumerate(model_ids):
        artifact_path = root / "models" / model_id / "artifact.json"
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text('{"files":[]}\n', encoding="utf-8")
        terms_digest = str(index + 4) * 64
        terms_path = root / "manifests" / "model-terms" / model_id / f"{terms_digest}.json"
        terms_path.parent.mkdir(parents=True, exist_ok=True)
        terms_path.write_text("{}\n", encoding="utf-8")
        model_rows.append({
            "id": model_id,
            "revision": f"revision-{index}",
            "weights_sha256": str(index) * 64,
            "artifact_manifest_sha256": str(index + 2) * 64,
            "terms_review": {"terms_snapshot_sha256": str(index + 4) * 64},
            "preprocessing_profile": {"size": 2 + index},
        })
    model_registry_path.write_text(json.dumps({"models": model_rows}), encoding="utf-8")
    monkeypatch.setattr(
        feasibility,
        "verify_model_registry",
        lambda *_args, **_kwargs: {
            "status": "complete",
            "models": [{"model_id": model_id, "file_bytes": 128} for model_id in model_ids],
        },
    )
    monkeypatch.setattr(
        feasibility,
        "_add_input",
        lambda inputs, _root, _path: inputs.update({"input.json": feasibility.sha256_file(evidence_path)}),
    )

    class Encoder:
        expected_dimension = 4
        preprocessing_sha256 = "f" * 64

        def encode(self, _image, **_kwargs):
            return SimpleNamespace(shape=(4,))

    monkeypatch.setattr(feasibility, "load_frozen_encoder", lambda *_args, **_kwargs: Encoder())
    real_import = builtins.__import__

    def import_without_torch(name, *args, **kwargs):
        if name == "torch":
            return SimpleNamespace(set_num_threads=lambda _threads: None)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_torch)
    return root, snapshot_path, model_registry_path, source_registry_path, anita_terms_path, source_profile_path


def test_mocked_inference_writes_measured_report_and_failure_writes_no_report(tmp_path, monkeypatch) -> None:
    paths = _mocked_feasibility_inputs(tmp_path, monkeypatch)
    root, snapshot, registry, sources, anita_terms, source_profile = paths
    report_path = root / "reports" / "private" / "cpu-report.json"
    measurements = iter([32.0, 48.0])
    monkeypatch.setattr(feasibility, "peak_rss_mib", lambda: next(measurements))

    report = feasibility.measure_frozen_cpu(
        root,
        snapshot.relative_to(root),
        registry,
        sources,
        anita_terms,
        source_profile.relative_to(root),
        report_path.relative_to(root),
        repeats=5,
    )
    assert report["measurements"]["peak_rss_mib"] == 48.0
    assert "lifetime peak" in json.loads(report_path.read_text(encoding="utf-8"))["summary"]

    failed_report = root / "reports" / "private" / "failed-report.json"
    memory_reads = iter([32.0, MLError("native counter unavailable after inference")])

    def fail_final_memory_read() -> float:
        reading = next(memory_reads)
        if isinstance(reading, MLError):
            raise reading
        return reading

    monkeypatch.setattr(feasibility, "peak_rss_mib", fail_final_memory_read)
    with pytest.raises(MLError, match="native counter unavailable"):
        feasibility.measure_frozen_cpu(
            root,
            snapshot.relative_to(root),
            registry,
            sources,
            anita_terms,
            source_profile.relative_to(root),
            failed_report.relative_to(root),
            repeats=5,
        )
    assert not failed_report.exists()


def test_memory_preflight_fails_before_model_verification(tmp_path, monkeypatch) -> None:
    paths = _mocked_feasibility_inputs(tmp_path, monkeypatch)
    root, snapshot, registry, sources, anita_terms, source_profile = paths
    verified = False

    def verify_models(*_args, **_kwargs):
        nonlocal verified
        verified = True
        raise AssertionError("model verification should not run without a memory counter")

    monkeypatch.setattr(feasibility, "verify_model_registry", verify_models)
    monkeypatch.setattr(
        feasibility,
        "peak_rss_mib",
        lambda: (_ for _ in ()).throw(MLError("native counter unavailable")),
    )
    report_path = root / "reports" / "private" / "failed-preflight-report.json"

    with pytest.raises(MLError, match="native counter unavailable"):
        feasibility.measure_frozen_cpu(
            root,
            snapshot.relative_to(root),
            registry,
            sources,
            anita_terms,
            source_profile.relative_to(root),
            report_path.relative_to(root),
            repeats=5,
        )

    assert not verified
    assert not report_path.exists()
