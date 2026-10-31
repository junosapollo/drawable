from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import pytest

torch = pytest.importorskip("torch")
from drawable_research_contracts import CurationSnapshotV1
from PIL import Image
from test_snapshot_cli import make_snapshot

from drawable_ml import prototype
from drawable_ml.io import MLError
from drawable_ml.prototype import rank_vectors


def test_build_preserves_review_identity_and_rejects_corrupt_vectors_or_source_bytes(
    tmp_path, monkeypatch
) -> None:
    image_path = tmp_path / "reference.png"
    Image.new("RGB", (16, 16), "black").save(image_path)
    snapshot_data = make_snapshot("reference.png").model_dump(mode="json")
    snapshot_data["purpose"] = "local-educational-prototype"
    snapshot_data["items"][0].update(
        width=16,
        height=16,
        byte_length=image_path.stat().st_size,
        sha256=hashlib.sha256(image_path.read_bytes()).hexdigest(),
        authorization_basis="owner-local-educational-prototype",
        rights_status="review_required",
        terms_snapshot_sha256=None,
        permissions={"local_display": True, "evaluation": True},
    )
    snapshot = CurationSnapshotV1.model_validate_json(json.dumps(snapshot_data))
    snapshot_path = tmp_path / "snapshot.json"
    snapshot_path.write_text(snapshot.model_dump_json())
    rows = {}
    files = []
    for model_id in prototype.MODEL_IDS:
        relative = f"models/{model_id}/files/weights.safetensors"
        path = tmp_path / relative
        path.parent.mkdir(parents=True)
        path.write_bytes(b"fixture-only-not-a-real-model")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows[model_id] = {
            "artifact_source": {
                "weights_file": "weights.safetensors",
                "artifact_directory_files": ["weights.safetensors"],
                "weights_bytes": path.stat().st_size,
                "weights_sha256": digest,
            },
            "preprocessing_profile": {"fixture": True},
        }
        files.append({"path": relative, "bytes": path.stat().st_size, "sha256": digest})
    monkeypatch.setattr(prototype, "_models", lambda: rows)
    monkeypatch.setattr(prototype, "acquire_models", lambda root: files)

    def encoder(dimension):
        def encode(image, *, view="full"):
            vector = torch.zeros(dimension)
            vector[0] = 1
            return vector

        return SimpleNamespace(model_id="fixture-only", encode=encode)

    monkeypatch.setattr(
        prototype,
        "_load_models",
        lambda root, structural: {"semantic": encoder(512), "structural": encoder(384)},
    )
    first = prototype.prepare(tmp_path, "snapshot.json")
    assert first["item_count"] == 1
    assert prototype.load_build(tmp_path)["asset_ids"] == ["asset-1"]
    assert prototype.prepare(tmp_path, "snapshot.json")["reused"] is True
    pointer_path = tmp_path / "prototype/search/active.json"
    pointer_bytes = pointer_path.read_bytes()
    vectors = tmp_path / f"prototype/search/builds/{first['build_id']}/vectors.safetensors"
    vectors.write_bytes(vectors.read_bytes() + b"corrupt")
    with pytest.raises(MLError, match="vectors checksum"):
        prototype.load_build(tmp_path)
    image_path.write_bytes(image_path.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="byte length changed"):
        prototype.prepare(tmp_path, "snapshot.json")
    assert pointer_path.read_bytes() == pointer_bytes


def test_frozen_ranking_renormalizes_only_enabled_branches_and_breaks_ties_by_id() -> None:
    vectors = {
        "semantic": torch.tensor(
            [[[1.0, 0.0], [1.0, 0.0]], [[0.0, 1.0], [0.0, 1.0]], [[1.0, 0.0], [1.0, 0.0]]]
        ),
        "structural": torch.tensor(
            [[[0.0, 1.0], [0.0, 1.0]], [[1.0, 0.0], [1.0, 0.0]], [[0.0, 1.0], [0.0, 1.0]]]
        ),
    }
    query = torch.tensor([[1.0, 0.0], [1.0, 0.0]])
    semantic = rank_vectors(vectors, {"semantic": query}, ["z", "b", "a"])
    assert semantic == [(2, 1.0), (0, 1.0), (1, 0.5)]
    combined = rank_vectors(vectors, {"semantic": query, "structural": query}, ["z", "b", "a"])
    assert combined[0][0] == 2
    assert abs(combined[0][1] - (0.35 * 1 + 0.25 * 0.5) / 0.6) < 1e-6
    assert abs(combined[-1][1] - (0.35 * 0.5 + 0.25 * 1) / 0.6) < 1e-6
