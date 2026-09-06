from __future__ import annotations

import io
import uuid
import warnings
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from linescout_api.config import DevicePolicy, Settings
from linescout_api.main import create_app

warnings.filterwarnings("ignore", message=".*httpx.*starlette.testclient.*")

REPO_ROOT = Path(__file__).resolve().parents[3]
SYNTHETIC_MANIFEST = REPO_ROOT / "ml" / "fixtures" / "synthetic" / "manifest.json"

DrawFn = Callable[[ImageDraw.ImageDraw, int], None]


def make_settings(tmp_path: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "db_path": tmp_path / "test.sqlite3",
        "data_dir": tmp_path,
        "gallery_manifest": SYNTHETIC_MANIFEST,
        "device": DevicePolicy.AUTO,
        "fixture_mode": True,
        "curation_mode": False,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def session_id() -> str:
    return str(uuid.uuid4())


def png_bytes(draw: DrawFn | None = None, size: int = 512, mode: str = "RGBA") -> bytes:
    background = (0, 0, 0, 0) if mode == "RGBA" else 255 if mode == "L" else (255, 255, 255)
    image = Image.new(mode, (size, size), background)  # type: ignore[arg-type]
    if draw is not None:
        draw(ImageDraw.Draw(image), size)
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def draw_arc(d: ImageDraw.ImageDraw, s: int) -> None:
    d.arc((s * 0.4, s * 0.43, s * 0.6, s * 0.55), 0, 180, fill="black", width=4)


def draw_eye(d: ImageDraw.ImageDraw, s: int) -> None:
    d.arc((s * 0.35, s * 0.4, s * 0.65, s * 0.6), 180, 360, fill="black", width=4)
    d.arc((s * 0.35, s * 0.4, s * 0.65, s * 0.6), 0, 180, fill="black", width=4)
    d.ellipse((s * 0.46, s * 0.46, s * 0.54, s * 0.54), outline="black", width=4)


def draw_figure(d: ImageDraw.ImageDraw, s: int) -> None:
    d.ellipse((s * 0.43, s * 0.12, s * 0.57, s * 0.27), outline="black", width=4)
    d.line((s * 0.5, s * 0.27, s * 0.5, s * 0.64), fill="black", width=4)
    d.line((s * 0.5, s * 0.64, s * 0.35, s * 0.92), fill="black", width=4)
    d.line((s * 0.5, s * 0.64, s * 0.65, s * 0.92), fill="black", width=4)
    d.line((s * 0.5, s * 0.37, s * 0.3, s * 0.55), fill="black", width=4)
    d.line((s * 0.5, s * 0.37, s * 0.7, s * 0.55), fill="black", width=4)


def draw_two_figures(d: ImageDraw.ImageDraw, s: int) -> None:
    for cx in (0.25, 0.75):
        d.ellipse((s * (cx - 0.06), s * 0.1, s * (cx + 0.06), s * 0.24), outline="black", width=4)
        d.line((s * cx, s * 0.24, s * cx, s * 0.62), fill="black", width=4)
        d.line((s * cx, s * 0.62, s * (cx - 0.12), s * 0.93), fill="black", width=4)
        d.line((s * cx, s * 0.62, s * (cx + 0.12), s * 0.93), fill="black", width=4)


def search_form(session_id: str, **overrides: object) -> dict[str, str]:
    form: dict[str, object] = {
        "session_id": session_id,
        "revision": 1,
        "canvas_width": 2048,
        "canvas_height": 2048,
        "stroke_count": 1,
        "point_count": 40,
    }
    form.update(overrides)
    return {key: str(value) for key, value in form.items()}


def post_search(
    client: TestClient,
    session_id: str,
    image: bytes,
    strokes: bytes | None = None,
    **overrides: object,
) -> tuple[int, dict[str, object]]:
    files: dict[str, tuple[str, bytes, str]] = {"image": ("snapshot.png", image, "image/png")}
    if strokes is not None:
        files["strokes"] = ("strokes.json.gz", strokes, "application/gzip")
    response = client.post("/api/v1/search", data=search_form(session_id, **overrides), files=files)
    return response.status_code, response.json()
