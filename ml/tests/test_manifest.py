from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from linescout_ml.cli import main
from linescout_ml.manifest import (
    Manifest,
    ManifestRecord,
    check_split_integrity,
    make_asset_id,
    manifest_json_schema,
)
from linescout_ml.synthetic import write_synthetic_dataset
from linescout_ml.taxonomy import (
    DEFAULT_STYLE_ORDER,
    DatasetSplit,
    LineArtOrigin,
    PrimaryStyle,
    ScopeLabel,
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "synthetic" / "manifest.json"


def _base_record(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "asset_id": make_asset_id("synthetic", "item-1"),
        "source_dataset": "synthetic",
        "source_item_id": "item-1",
        "source_work_id": "work-1",
        "license_id": "CC0-1.0",
        "original_path": "originals/a.png",
        "line_art_path": "line_art/a.png",
        "thumbnail_path": "thumbnails/a.png",
        "origin": "native_line_art",
        "primary_style": "manga_anime",
        "scopes": ["eye"],
        "person_count": 1,
        "sfw": {"safe": True, "confidence": 0.99, "method": "manual"},
        "width": 512,
        "height": 512,
        "text_coverage": 0.0,
        "ink_coverage": 0.05,
        "phash": "0123456789abcdef",
        "quality_score": 0.9,
        "split": "train",
        "enabled": True,
        "pipeline_version": "test-1",
        "checksum": "a" * 64,
    }
    record.update(overrides)
    return record


def test_taxonomy_matches_spec() -> None:
    assert [s.value for s in ScopeLabel] == [
        "eye",
        "face_head",
        "hair",
        "hand",
        "foot",
        "upper_body_clothing",
        "full_body",
        "multi_character",
        "unknown",
    ]
    assert [s.value for s in PrimaryStyle] == [
        "manga_anime",
        "western_ink",
        "realistic_academic",
        "cartoon",
        "gesture_sketch",
    ]
    assert [s.value for s in LineArtOrigin] == ["native_line_art", "extracted_line_art"]
    # Fixed default row order: manga, realistic, Western comic, cartoon, gesture.
    assert DEFAULT_STYLE_ORDER == (
        PrimaryStyle.MANGA_ANIME,
        PrimaryStyle.REALISTIC_ACADEMIC,
        PrimaryStyle.WESTERN_INK,
        PrimaryStyle.CARTOON,
        PrimaryStyle.GESTURE_SKETCH,
    )


def test_asset_id_is_deterministic_and_crop_sensitive() -> None:
    from linescout_ml.manifest import CropBox

    plain = make_asset_id("Manga109", "ARMS/012")
    assert plain == make_asset_id("Manga109", "ARMS/012")
    assert plain.startswith("ls_manga109_")
    assert plain != make_asset_id("Manga109", "ARMS/012", CropBox(x=0, y=0, width=10, height=10))


def test_valid_record_round_trips() -> None:
    record = ManifestRecord.model_validate(_base_record())
    assert record.origin is LineArtOrigin.NATIVE
    assert ManifestRecord.model_validate_json(record.model_dump_json()) == record


@pytest.mark.parametrize(
    ("overrides", "fragment"),
    [
        ({"origin": "extracted_line_art"}, "extraction_model"),
        ({"extraction_model": "anime2sketch", "extraction_version": "1"}, "native assets must not"),
        ({"sfw": {"safe": False, "confidence": 0.9, "method": "opennsfw2"}}, "safe=true"),
        ({"review": {"state": "rejected", "quality": 1}}, "cannot be rejected"),
        ({"scopes": ["multi_character"], "person_count": 1}, "person_count >= 2"),
        ({"scopes": ["eye", "eye"]}, "unique"),
        ({"scopes": ["unknown"]}, "query-only"),
        ({"width": 200}, "256"),
        ({"original_path": "/abs/path.png"}, "relative"),
        ({"original_path": "../escape.png"}, "relative"),
        ({"crop": {"x": 500, "y": 0, "width": 100, "height": 100}}, "exceeds"),
        ({"asset_id": "not-an-id"}, "pattern"),
        ({"extra_field": 1}, "extra"),
    ],
)
def test_invalid_records_are_rejected(overrides: dict[str, object], fragment: str) -> None:
    with pytest.raises(ValidationError) as info:
        ManifestRecord.model_validate(_base_record(**overrides))
    assert fragment in str(info.value)


def test_manifest_rejects_duplicate_ids() -> None:
    with pytest.raises(ValidationError, match="duplicate asset_id"):
        Manifest.model_validate(
            {
                "dataset_version": "2026.09.06",
                "records": [_base_record(), _base_record()],
            }
        )


def test_split_integrity_flags_cross_split_works() -> None:
    a = ManifestRecord.model_validate(_base_record())
    b = ManifestRecord.model_validate(
        _base_record(
            asset_id=make_asset_id("synthetic", "item-2"), source_item_id="item-2", split="test"
        )
    )
    problems = check_split_integrity([a, b])
    assert len(problems) == 1 and "work-1" in problems[0]
    b_ok = b.model_copy(update={"split": DatasetSplit.GALLERY_ONLY})
    assert check_split_integrity([a, b_ok]) == []


def test_committed_fixture_is_valid_and_deterministic(tmp_path: Path) -> None:
    committed = Manifest.model_validate_json(FIXTURE.read_text(encoding="utf-8"))
    assert check_split_integrity(committed.records) == []
    assert any(not r.enabled for r in committed.records)
    assert {r.primary_style for r in committed.enabled_records} == set(PrimaryStyle)

    regenerated_path = write_synthetic_dataset(tmp_path, count=len(committed.records), seed=7)
    regenerated = Manifest.model_validate_json(regenerated_path.read_text(encoding="utf-8"))
    assert regenerated.content_hash() == committed.content_hash(), (
        "synthetic fixture drifted; regenerate with `linescout-manifest synth`"
    )


def test_cli_validate_with_files(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    manifest_path = write_synthetic_dataset(tmp_path / "ds", count=9, seed=1)
    assert main(["validate", str(manifest_path), "--require-files"]) == 0
    assert "OK" in capsys.readouterr().out

    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["records"][0]["thumbnail_path"] = "thumbnails/missing.png"
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(data), encoding="utf-8")
    assert (
        main(["validate", str(broken), "--data-root", str(tmp_path / "ds"), "--require-files"]) == 1
    )
    assert "missing thumbnail" in capsys.readouterr().err


def test_json_schema_exposes_enums() -> None:
    schema = manifest_json_schema()
    defs = schema["$defs"]
    assert set(defs["ScopeLabel"]["enum"]) == {s.value for s in ScopeLabel}
    assert set(defs["PrimaryStyle"]["enum"]) == {s.value for s in PrimaryStyle}
