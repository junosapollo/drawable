#!/usr/bin/env bash
# Lint, type-check, and test both Python packages exactly as CI does.
set -euo pipefail
cd "$(dirname "$0")/.."

run() { local pkg=$1 module=$2
  echo "==> $pkg: ruff"; (cd "$pkg" && .venv/bin/ruff check . && .venv/bin/ruff format --check .)
  echo "==> $pkg: mypy"; (cd "$pkg" && .venv/bin/mypy "$module")
  echo "==> $pkg: pytest"; (cd "$pkg" && .venv/bin/pytest -q)
}
run ml linescout_ml
run services/api linescout_api
echo "==> scripts: ruff"; services/api/.venv/bin/ruff check --config services/api/pyproject.toml scripts/
