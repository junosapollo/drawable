# linescout-ml

Dataset manifest schema, taxonomy, and validation for LineScout. Ingestion,
filtering, training, index construction, and evaluation are added in later
milestones; Milestone 1 ships only the shared contract.

```bash
cd ml
uv venv --python 3.11 .venv
uv pip install -e ".[dev]"

# Validate a manifest (and check that enabled assets' files exist)
.venv/bin/linescout-manifest validate ../data/gallery/manifest.json --require-files

# Emit the JSON schema
.venv/bin/linescout-manifest schema --out ../packages/contracts/manifest.schema.json

# Regenerate the committed synthetic fixture (deterministic; safe to commit)
.venv/bin/linescout-manifest synth --out fixtures/synthetic --count 24 --seed 7

# Checks
.venv/bin/ruff check . && .venv/bin/mypy linescout_ml && .venv/bin/pytest
```

`fixtures/synthetic/` is the only dataset committed to Git. Real datasets live
under `data/` (ignored) and are never redistributed.
