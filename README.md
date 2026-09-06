# drawable · LineScout

A local, line-art reference copilot for character artists: draw on a
pressure-sensitive canvas and matching references appear after every stroke.
Everything runs on your machine — no accounts, no cloud, no paid services.

> **Status: Milestone 1 (project foundation).** The canvas is fully usable and
> the API serves the complete v1 wire contract, but rankings come from a
> deterministic fixture over a synthetic gallery until the retrieval models
> land in Milestone 4. See [Roadmap](#roadmap).

## Quick start

Requirements: **Node.js 22+**, **Python 3.11**, and [`uv`](https://docs.astral.sh/uv/)
(`pip install uv` works). Linux and current Chrome/Edge are the primary targets.
No GPU is required for Milestone 1.

```bash
npm install          # frontend + generated contracts
npm run setup:py     # creates ml/.venv and services/api/.venv with uv
npm run dev:all      # API on :8000 and the web app on :5173, together
```

Open <http://127.0.0.1:5173/draw>. The reference panel badge shows which
backend you are on:

| Badge | Meaning |
|---|---|
| **API fixture** | Live FastAPI worker, deterministic ranker over the synthetic gallery (default) |
| **GPU** / **CPU fallback** | Live worker with real models (Milestone 4+) |
| **Fixture** | No API reachable; the frontend simulates results so drawing still works |

Run the two halves separately if you prefer:

```bash
npm run dev:api      # serves the synthetic gallery by default
npm run dev          # Vite; proxies /api → http://127.0.0.1:8000
```

Configuration is optional and documented in [`.env.example`](.env.example).
Nothing needs a secret, an absolute path, or a paid service.

## Checks

```bash
npm run check        # TypeScript (contracts + web)
npm test             # Vitest
npm run build        # production bundle
npm run check:py     # ruff + mypy --strict + pytest for ml and services/api
npm run smoke        # end-to-end contract check against a running API
npm run test:e2e     # Playwright (needs `npx playwright install chromium`)
npm run contracts    # regenerate packages/contracts from the API (CI fails if stale)
```

CI runs all of the above except Playwright, plus a synthetic-data smoke test
that boots the API against the committed fixture gallery.

## Repository layout

```
apps/web/            React 19 + Vite canvas, reference panel, curation & benchmark shells
services/api/        FastAPI worker: health, search, events, preferences, assets, curation (gated)
ml/                  Taxonomy, manifest schema + validator, synthetic fixture generator
packages/contracts/  TypeScript types generated from the API's OpenAPI document
scripts/             setup, checks, contract export, smoke test, dev runner
data/                Local datasets, indexes, models, SQLite — never committed
```

### API surface (`/api/v1`)

| Endpoint | Milestone 1 |
|---|---|
| `GET /health` | readiness, CUDA/GPU, model + dataset/index versions, gallery size, warnings |
| `POST /search` | full multipart contract with structured `400/413/422`; blank input → `200 mode=insufficient` |
| `POST /events` · `GET/PUT /preferences` | interaction logging, Laplace-smoothed 30-day-half-life style affinity |
| `GET /assets/{id}/thumbnail` · `/line-art` | enabled + SFW assets only; missing files auto-disable the asset |
| `/curation/*` | mounted only with `LINESCOUT_CURATION_MODE=1`; progress works, the rest is 501 until Milestone 2 |

Interactive docs: <http://127.0.0.1:8000/api/v1/docs>.

## Datasets

No third-party dataset is redistributed with this repository. `ml/fixtures/synthetic/`
is a generated, license-free stand-in used by tests and the default dev setup.
Real sources (Quick, Draw!, Amateur Drawings, Human-Art, Manga109, eBDtheque,
Safebooru, Smithsonian/Met Open Access) are downloaded into `data/` in
Milestone 2 under their own terms — several require an access application,
so start those early.

## Roadmap

| # | Milestone | Status |
|---|---|---|
| 1 | Reproducible project foundation | **This branch** |
| 2 | Dataset and curation pipeline | next |
| 3 | Headless Clippy baseline | |
| 4 | LineScout retrieval models | |
| 5 | Polished canvas and live search | canvas ~70% done |
| 6 | Preference learning and calibrated ranking | event/preference plumbing done |
| 7 | Locked evaluation and demonstration release | |

## License

All rights reserved. See [`LICENSE`](LICENSE).
