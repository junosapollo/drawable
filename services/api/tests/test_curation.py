"""End-to-end tests for the Milestone 2 curation engine.

Covers:

* ``GET /curation/next`` — stratified queue + filter behaviour, queue-empty
  semantics, and the gallery-required gate.
* ``POST /curation/labels`` — validation, dual-write to ``curation_labels``
  and ``assets``, the ``assets.enabled`` flip, and the in-memory
  ``state.assets`` refresh.
* ``POST /curation/snapshots`` — JSON file emission, snapshot id binding to
  the label rows, and the breakdown shape.
* ``GET /curation/progress`` — the new ``by_style`` and ``by_scope`` fields.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from linescout_ml.taxonomy import PrimaryStyle, ScopeLabel
from PIL import Image

from linescout_api.gallery import enabled_assets
from linescout_api.main import create_app
from tests.conftest import SYNTHETIC_MANIFEST, make_settings

# ----------------------------------------------------------------- helpers


def _curation_client(tmp_path: Path) -> TestClient:
    """A TestClient with curation mode on, gallery loaded, and real PNGs written.

    The synthetic fixture's ``thumbnail_path`` / ``line_art_path`` point at
    files that the test suite creates on the fly — :func:`enabled_assets`
    is loaded by the app lifespan once those files exist.

    The caller is responsible for using the returned object as a context
    manager so the FastAPI lifespan (which builds ``app.state.linescout``)
    actually runs.
    """
    return TestClient(create_app(make_settings(tmp_path, curation_mode=True)))


def _seed_files(tmp_path: Path) -> None:
    """Write a 16×16 PNG for every referenced asset path in the synthetic manifest."""
    manifest = json.loads(SYNTHETIC_MANIFEST.read_text(encoding="utf-8"))
    base = SYNTHETIC_MANIFEST.parent
    for record in manifest["records"]:
        for key in ("line_art_path", "thumbnail_path"):
            target = base / record[key]
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.is_file():
                Image.new("RGBA", (16, 16), (0, 0, 0, 0)).save(target, "PNG")


@pytest.fixture
def curation_client(tmp_path: Path):
    """Yield a TestClient whose lifespan has run (so ``app.state.linescout`` is built).

    The synthetic manifest ships every asset pre-accepted, which would leave
    the curation queue empty. We force every asset back to ``unreviewed`` in
    the database once the lifespan is up, so the queue logic is exercised
    end-to-end without touching the committed fixture.

    Using ``yield`` inside the ``with`` block keeps the lifespan alive for
    every test that consumes the fixture; the client is closed automatically
    on teardown.
    """
    _seed_files(tmp_path)
    with _curation_client(tmp_path) as client:
        state = client.app.state.linescout
        if state.gallery is not None:
            state.connection.execute(
                "UPDATE assets SET review_state = 'unreviewed', review_quality = NULL"
            )
        yield client


# ----------------------------------------------------------------- progress


def test_progress_breakdowns_match_assets_table(curation_client: TestClient) -> None:
    body = curation_client.get("/api/v1/curation/progress").json()
    assert body["reviewed"] == 0
    assert body["accepted"] == 0
    assert body["rejected"] == 0
    assert body["target"] == 2000
    # The synthetic fixture's remaining queue is the gap between the manifest
    # size and the (empty) review log.
    assert body["remaining"] == 2000 - 0

    # Every style / scope bucket must appear. No work has been done, so
    # ``reviewed``/``accepted``/``rejected`` are zero everywhere; ``remaining``
    # matches the live count of unreviewed assets in that bucket.
    assert set(body["by_style"]) == {s.value for s in PrimaryStyle}
    assert set(body["by_scope"]) == {s.value for s in ScopeLabel if s is not ScopeLabel.UNKNOWN}
    for payload in body["by_style"].values():
        assert payload["reviewed"] == 0
        assert payload["accepted"] == 0
        assert payload["rejected"] == 0
    for payload in body["by_scope"].values():
        assert payload["reviewed"] == 0
        assert payload["accepted"] == 0
        assert payload["rejected"] == 0

    # The remaining counts must equal the live unreviewed-asset count in the
    # database for every style bucket. Pull those counts directly so the test
    # is independent of fixture content.
    state = curation_client.app.state.linescout
    for style in PrimaryStyle:
        row = state.connection.execute(
            "SELECT COUNT(*) AS n FROM assets"
            " WHERE primary_style = ? AND review_state = 'unreviewed' AND sfw_safe = 1",
            (style.value,),
        ).fetchone()
        assert body["by_style"][style.value]["remaining"] == int(row["n"])


# ----------------------------------------------------------------- next


def test_next_returns_stratified_candidate(curation_client: TestClient) -> None:
    body = curation_client.get("/api/v1/curation/next").json()
    assert "asset_id" in body
    assert body["primary_style"] in {s.value for s in PrimaryStyle}
    assert body["review_state"] == "unreviewed"
    # The wire response must always expose the asset URLs the UI needs.
    assert body["thumbnail_url"].startswith("/api/v1/assets/")
    assert body["line_art_url"].startswith("/api/v1/assets/")
    assert body["line_art_url"].endswith("/line-art")


def test_next_style_filter_only_returns_that_style(curation_client: TestClient) -> None:
    """Drain the queue for one style; every served candidate must match the filter."""
    seen_styles: set[str] = set()
    seen_assets: set[str] = set()
    while True:
        response = curation_client.get("/api/v1/curation/next", params={"style": "manga_anime"})
        if response.status_code == 404:
            break
        body = response.json()
        seen_styles.add(body["primary_style"])
        seen_assets.add(body["asset_id"])
        assert body["primary_style"] == "manga_anime"
        # Mark the candidate as rejected so the next ``/next`` advances;
        # the style filter would otherwise serve the same asset again.
        curation_client.post(
            "/api/v1/curation/labels",
            json=_label(body["asset_id"], decision="reject", quality=1),
        )
    assert seen_styles == {"manga_anime"}
    # The reject decisions must not have leaked into the other style buckets.
    body = curation_client.get("/api/v1/curation/progress").json()
    # ``seen_assets`` is the set of asset_ids that were served and rejected —
    # every one of them must show up in the global rejected counter, and the
    # accepted counter must stay at zero (nothing was kept).
    assert body["rejected"] == len(seen_assets)
    assert body["accepted"] == 0
    # The other four style buckets must remain at zero reviewed/rejected.
    for style in ("western_ink", "realistic_academic", "cartoon", "gesture_sketch"):
        assert body["by_style"][style]["reviewed"] == 0
        assert body["by_style"][style]["rejected"] == 0


def test_next_scope_filter_only_returns_that_scope(curation_client: TestClient) -> None:
    """Drain the queue for one scope; the served candidates must respect the filter."""
    seen: set[tuple[str, ...]] = set()
    while True:
        response = curation_client.get("/api/v1/curation/next", params={"scope": "eye"})
        if response.status_code == 404:
            break
        body = response.json()
        scopes = tuple(body["scopes"])
        seen.add(scopes)
        # The candidate either declares ``eye`` or only carries ``unknown``;
        # both are valid per the queue logic in curation.py.
        assert "eye" in scopes or scopes == ("unknown",)
        # Advance the queue by rejecting the asset (so it never reappears).
        curation_client.post(
            "/api/v1/curation/labels",
            json=_label(body["asset_id"], decision="reject", quality=1),
        )
    assert seen  # we drained at least one candidate


def test_next_returns_404_when_queue_empty(curation_client: TestClient) -> None:
    # Drain the full queue by rejecting every served candidate. The queue
    # only advances when a label moves the asset out of ``unreviewed``.
    while True:
        response = curation_client.get("/api/v1/curation/next")
        if response.status_code == 404:
            break
        body = response.json()
        curation_client.post(
            "/api/v1/curation/labels",
            json=_label(body["asset_id"], decision="reject", quality=1),
        )
    # Now the queue is empty.
    response = curation_client.get("/api/v1/curation/next")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "queue_empty"


def test_next_404_without_gallery(tmp_path: Path) -> None:
    """Without a gallery manifest, the curation queue is meaningless."""
    with TestClient(
        create_app(make_settings(tmp_path, curation_mode=True, gallery_manifest=None))
    ) as client:
        # ``make_settings`` defaults to ``fixture_mode=True`` which still
        # triggers a warning but no manifest; the lifespan therefore leaves
        # ``gallery`` as None.
        response = client.get("/api/v1/curation/next")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "gallery_unavailable"


# ----------------------------------------------------------------- labels


def _label(asset_id: str, **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "asset_id": asset_id,
        "decision": "keep",
        "quality": 3,
    }
    payload.update(overrides)
    return payload


def test_label_keep_dual_writes_and_enables_asset(curation_client: TestClient) -> None:
    first = curation_client.get("/api/v1/curation/next").json()
    response = curation_client.post("/api/v1/curation/labels", json=_label(first["asset_id"]))
    assert response.status_code == 201
    body = response.json()
    assert body["asset_id"] == first["asset_id"]
    assert body["decision"] == "keep"
    assert body["review_state"] == "accepted"
    assert body["review_quality"] == 3
    assert body["enabled"] is True

    # The asset is no longer a candidate: it has been accepted.
    after = curation_client.get("/api/v1/curation/next").json()
    assert after["asset_id"] != first["asset_id"]


def test_label_reject_disables_asset_and_records(curation_client: TestClient) -> None:
    first = curation_client.get("/api/v1/curation/next").json()
    response = curation_client.post(
        "/api/v1/curation/labels",
        json=_label(first["asset_id"], decision="reject", quality=1, note="blurry"),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["review_state"] == "rejected"
    assert body["enabled"] is False
    assert body["review_quality"] == 1

    # The in-memory ``enabled_assets`` list should no longer contain the
    # rejected asset, which is what /search and /assets/* observe.
    with curation_client:
        # Use a fresh cursor on the connection held by the app.
        state = curation_client.app.state.linescout
        enabled = {asset.asset_id for asset in enabled_assets(state.connection)}
    assert first["asset_id"] not in enabled


def test_label_quality_required_on_keep(curation_client: TestClient) -> None:
    first = curation_client.get("/api/v1/curation/next").json()
    response = curation_client.post(
        "/api/v1/curation/labels", json={"asset_id": first["asset_id"], "decision": "keep"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_label_validates_quality_range(curation_client: TestClient) -> None:
    first = curation_client.get("/api/v1/curation/next").json()
    response = curation_client.post(
        "/api/v1/curation/labels",
        json=_label(first["asset_id"], quality=5),
    )
    assert response.status_code == 422


def test_label_validates_duplicate_scopes(curation_client: TestClient) -> None:
    first = curation_client.get("/api/v1/curation/next").json()
    response = curation_client.post(
        "/api/v1/curation/labels",
        json=_label(first["asset_id"], scopes=["eye", "eye"]),
    )
    assert response.status_code == 422


def test_label_unknown_asset_404(curation_client: TestClient) -> None:
    response = curation_client.post(
        "/api/v1/curation/labels", json=_label("ls_does_not_exist_0000000000000000")
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "asset_not_found"


def test_label_updates_assets_metadata(curation_client: TestClient) -> None:
    """Reviewer-supplied primary_style / scopes / crop must persist on the asset.

    ``malformed_anatomy`` / ``poor_extraction`` are flag columns on the
    ``curation_labels`` audit row — they describe the review, not the asset —
    so we assert them against the label rather than the assets cache.
    """
    first = curation_client.get("/api/v1/curation/next").json()
    response = curation_client.post(
        "/api/v1/curation/labels",
        json=_label(
            first["asset_id"],
            primary_style="cartoon",
            scopes=["full_body"],
            crop={"x": 0, "y": 0, "width": 8, "height": 8},
            malformed_anatomy=True,
            poor_extraction=True,
            note="head is too small",
        ),
    )
    assert response.status_code == 201

    state = curation_client.app.state.linescout
    asset_row = state.connection.execute(
        "SELECT primary_style, scopes_json, crop_json FROM assets WHERE asset_id = ?",
        (first["asset_id"],),
    ).fetchone()
    assert asset_row["primary_style"] == "cartoon"
    assert json.loads(asset_row["scopes_json"]) == ["full_body"]
    assert json.loads(asset_row["crop_json"]) == {
        "x": 0,
        "y": 0,
        "width": 8,
        "height": 8,
    }

    label_row = state.connection.execute(
        "SELECT malformed_anatomy, poor_extraction, note"
        " FROM curation_labels WHERE asset_id = ?"
        " ORDER BY id DESC LIMIT 1",
        (first["asset_id"],),
    ).fetchone()
    assert label_row["malformed_anatomy"] == 1
    assert label_row["poor_extraction"] == 1
    assert label_row["note"] == "head is too small"


def test_label_progress_reflects_writes(curation_client: TestClient) -> None:
    body0 = curation_client.get("/api/v1/curation/progress").json()
    assert body0["reviewed"] == 0
    first = curation_client.get("/api/v1/curation/next").json()
    curation_client.post("/api/v1/curation/labels", json=_label(first["asset_id"]))
    body1 = curation_client.get("/api/v1/curation/progress").json()
    assert body1["reviewed"] == 1
    assert body1["accepted"] == 1
    assert body1["remaining"] == 1999
    # The asset's primary_style bucket should have an updated accepted count.
    assert body1["by_style"][first["primary_style"]]["accepted"] == 1


# ----------------------------------------------------------------- snapshots


def test_snapshot_writes_json_file_and_marks_labels(
    curation_client: TestClient, tmp_path: Path
) -> None:
    first = curation_client.get("/api/v1/curation/next").json()
    curation_client.post("/api/v1/curation/labels", json=_label(first["asset_id"]))
    response = curation_client.post("/api/v1/curation/snapshots")
    assert response.status_code == 201
    body = response.json()
    assert body["snapshot_id"].startswith("curation_")
    assert body["label_count"] == 1
    target = Path(body["path"])
    assert target.is_file()
    payload = json.loads(target.read_text(encoding="utf-8"))
    assert payload["snapshot_id"] == body["snapshot_id"]
    assert payload["label_count"] == 1
    assert payload["labels"][0]["asset_id"] == first["asset_id"]
    # Snapshot id is bound back onto the label row in the audit table.
    state = curation_client.app.state.linescout
    row = state.connection.execute(
        "SELECT snapshot_id FROM curation_labels WHERE asset_id = ?",
        (first["asset_id"],),
    ).fetchone()
    assert row["snapshot_id"] == body["snapshot_id"]


def test_snapshot_includes_only_kept_labels(curation_client: TestClient) -> None:
    keep_id = curation_client.get("/api/v1/curation/next").json()["asset_id"]
    curation_client.post("/api/v1/curation/labels", json=_label(keep_id))

    reject_id = curation_client.get("/api/v1/curation/next").json()["asset_id"]
    curation_client.post(
        "/api/v1/curation/labels", json=_label(reject_id, decision="reject", quality=1)
    )

    body = curation_client.post("/api/v1/curation/snapshots").json()
    assert body["label_count"] == 1
    target = Path(body["path"])
    payload = json.loads(target.read_text(encoding="utf-8"))
    assert {label["asset_id"] for label in payload["labels"]} == {keep_id}


def test_snapshot_404_without_gallery(tmp_path: Path) -> None:
    with TestClient(
        create_app(make_settings(tmp_path, curation_mode=True, gallery_manifest=None))
    ) as client:
        response = client.post("/api/v1/curation/snapshots")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "gallery_unavailable"


def test_snapshot_breaks_down_by_style(curation_client: TestClient) -> None:
    # Label one asset per style, then export the snapshot.
    seen_styles: set[str] = set()
    safety = 50  # the synthetic fixture has 24 assets; this is well under the cap.
    while len(seen_styles) < 2 and safety > 0:
        candidate = curation_client.get("/api/v1/curation/next").json()
        seen_styles.add(candidate["primary_style"])
        curation_client.post("/api/v1/curation/labels", json=_label(candidate["asset_id"]))
        safety -= 1
    assert len(seen_styles) == 2, f"expected two distinct styles, got {seen_styles}"

    body = curation_client.post("/api/v1/curation/snapshots").json()
    assert body["label_count"] == 2
    total = sum(body["style_breakdown"].values())
    assert total == 2
    for style in seen_styles:
        assert body["style_breakdown"][style] == 1
