#!/usr/bin/env python
"""Write the API's OpenAPI document and the manifest JSON schema to packages/contracts.

Run from the repository root with the API virtualenv:

    services/api/.venv/bin/python scripts/export_openapi.py

The output is committed. CI regenerates it and fails if the committed copy is
stale, which keeps ``packages/contracts`` in lockstep with the Python models.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = REPO_ROOT / "packages" / "contracts"


def main() -> int:
    from linescout_api.config import Settings
    from linescout_api.main import create_app
    from linescout_api.schemas import Stroke, StrokePoint, StrokeSequence
    from linescout_ml.manifest import dump_json_schema

    # Curation on so the full surface is documented; no DB/gallery needed to build the schema.
    settings = Settings(_env_file=None, curation_mode=True, gallery_manifest=None)  # type: ignore[call-arg]
    spec = create_app(settings).openapi()

    # The stroke sequence travels gzipped inside a multipart part, so FastAPI
    # does not see it as a JSON body. Publish its schema explicitly.
    for model in (StrokePoint, Stroke, StrokeSequence):
        schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
        defs = schema.pop("$defs", {})
        spec["components"]["schemas"].update(defs)
        spec["components"]["schemas"][model.__name__] = schema

    CONTRACTS.mkdir(parents=True, exist_ok=True)
    (CONTRACTS / "openapi.json").write_text(
        json.dumps(spec, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (CONTRACTS / "manifest.schema.json").write_text(dump_json_schema(), encoding="utf-8")
    print(f"wrote {CONTRACTS / 'openapi.json'} and {CONTRACTS / 'manifest.schema.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
