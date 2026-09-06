#!/usr/bin/env python
"""End-to-end smoke test against a running API: health, search, asset fetch.

    python scripts/smoke_search.py http://127.0.0.1:8000

Exits non-zero if any step disagrees with the Milestone 1 contract. Uses only
the standard library plus Pillow so it runs from the API virtualenv.
"""

from __future__ import annotations

import io
import json
import sys
import urllib.error
import urllib.request
import uuid

from PIL import Image, ImageDraw


def _multipart(
    fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]
) -> tuple[bytes, str]:
    boundary = f"----linescout{uuid.uuid4().hex}"
    body = bytearray()
    for name, value in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    for name, (filename, data, content_type) in files.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        body += f"Content-Type: {content_type}\r\n\r\n".encode()
        body += data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def _figure_png() -> bytes:
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((220, 60, 290, 140), outline="black", width=4)
    draw.line((255, 140, 255, 330), fill="black", width=4)
    draw.line((255, 330, 180, 470), fill="black", width=4)
    draw.line((255, 330, 330, 470), fill="black", width=4)
    draw.line((255, 190, 150, 280), fill="black", width=4)
    draw.line((255, 190, 360, 280), fill="black", width=4)
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _get(url: str) -> tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status, response.read(), response.headers.get("content-type", "")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("content-type", "")


def main(base: str) -> int:
    failures: list[str] = []

    def check(condition: bool, message: str) -> None:
        print(("ok   " if condition else "FAIL ") + message)
        if not condition:
            failures.append(message)

    status, raw, _ = _get(f"{base}/api/v1/health")
    health = json.loads(raw)
    check(status == 200, "health returns 200")
    check(health["ready"] is True, f"api is ready (warnings={health['warnings']})")
    check(health["gallery_size"] > 0, f"gallery loaded ({health['gallery_size']} assets)")

    session = str(uuid.uuid4())
    fields = {
        "session_id": session,
        "revision": "12",
        "canvas_width": "2048",
        "canvas_height": "2048",
        "stroke_count": "14",
        "point_count": "900",
    }
    body, content_type = _multipart(fields, {"image": ("s.png", _figure_png(), "image/png")})
    request = urllib.request.Request(
        f"{base}/api/v1/search", data=body, headers={"Content-Type": content_type}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        search = json.loads(response.read())
    check(search["revision"] == 12, "search echoes the request revision")
    check(search["mode"] == "confident", f"full figure is confident (got {search['mode']})")
    check(search["groups"] and search["groups"][0]["kind"] == "best_match", "Best Match is first")
    check(len(search["groups"][0]["results"]) <= 8, "Best Match has at most 8 results")
    check(
        all(len(g["results"]) <= 6 for g in search["groups"][1:]),
        "style rows have at most 6 results",
    )
    check(
        search["timing"]["total_ms"] < 250,
        f"fixture search under 250 ms ({search['timing']['total_ms']} ms)",
    )

    first = search["groups"][0]["results"][0]
    status, data, kind = _get(f"{base}{first['thumbnail_url']}")
    check(status == 200 and kind == "image/png" and len(data) > 0, "thumbnail is served")
    status, data, kind = _get(f"{base}{first['asset_url']}")
    check(status == 200 and kind == "image/png", "trace-compatible line art is served")

    body, content_type = _multipart(fields, {"image": ("s.png", b"not a png", "image/png")})
    request = urllib.request.Request(
        f"{base}/api/v1/search", data=body, headers={"Content-Type": content_type}
    )
    try:
        urllib.request.urlopen(request, timeout=10)
        check(False, "malformed image is rejected")
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read())
        check(
            error.code == 400 and payload["error"]["code"] == "image_malformed",
            "malformed image -> 400 image_malformed",
        )

    status, raw, _ = _get(f"{base}/api/v1/curation/progress")
    check(status == 404, "curation endpoints hidden without CURATION_MODE")

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"))
