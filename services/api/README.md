# linescout-api

FastAPI runtime for LineScout. One Uvicorn worker; GPU inference (Milestone 4)
is serialised behind a single-request semaphore.

```bash
cd services/api
uv venv --python 3.11 .venv
uv pip install -e ".[dev]"           # light deps only; add ",gpu" for torch later

# Run against the synthetic gallery (no models, deterministic fixture results)
.venv/bin/python -m linescout_api.main      # synthetic gallery by default

# Health, docs, OpenAPI
curl -s http://127.0.0.1:8000/api/v1/health | python -m json.tool
open http://127.0.0.1:8000/api/v1/docs

# Checks
.venv/bin/ruff check . && .venv/bin/mypy linescout_api && .venv/bin/pytest
```

## Configuration

Every setting has a local, free default. Override with `LINESCOUT_*` variables
or a `.env` file here. Relative paths resolve from the repository root.

| Variable | Default | Notes |
|---|---|---|
| `LINESCOUT_HOST` / `LINESCOUT_PORT` | `0.0.0.0` / `8000` | |
| `LINESCOUT_DEVICE` | `auto` | `auto`, `cuda` (fail if missing), `cpu` |
| `LINESCOUT_FIXTURE_MODE` | `true` | Deterministic ranker until models exist |
| `LINESCOUT_GALLERY_MANIFEST` | unset | Path to a validated `manifest.json` |
| `LINESCOUT_DB_PATH` | `data/linescout.sqlite3` | SQLite in WAL mode |
| `LINESCOUT_CURATION_MODE` | `false` | Mounts `/api/v1/curation/*` |
| `LINESCOUT_CORS_ORIGINS` | Vite dev origins | Comma-separated |

## Endpoints

| Method | Path | Milestone 1 status |
|---|---|---|
| `GET` | `/api/v1/health` | Complete |
| `POST` | `/api/v1/search` | Full multipart validation (400/413/422), insufficient rule, fixture ranking |
| `POST` | `/api/v1/events` | Complete |
| `GET`/`PUT` | `/api/v1/preferences` | Complete (Laplace + 30-day half-life) |
| `GET` | `/api/v1/assets/{id}/thumbnail` · `/line-art` | Complete; enabled + SFW assets only |
| `*` | `/api/v1/curation/*` | Gated by `CURATION_MODE`; progress works, rest 501 until M2 |
