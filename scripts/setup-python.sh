#!/usr/bin/env bash
# Create the two Python virtualenvs (ml, services/api) with uv.
# Requires: Python 3.11 and uv (https://docs.astral.sh/uv/ — or `pip install uv`).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found. Install it with one of:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  pip install --user uv" >&2
  exit 1
fi

for pkg in ml services/api; do
  echo "==> $pkg"
  (cd "$pkg" && uv venv --python 3.11 .venv --quiet && uv pip install --quiet -e ".[dev]")
done

echo
echo "Done. Next:"
echo "  npm run dev:all        # API + web together (fixture ranker over the synthetic gallery)"
echo "  npm run check:py       # ruff + mypy + pytest for both packages"
