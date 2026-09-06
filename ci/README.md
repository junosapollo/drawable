# CI workflow (pending install)

`github-ci.yml` is the GitHub Actions workflow for this repository. It lives
here instead of `.github/workflows/` only because the automation account that
opened the Milestone 1 pull request is not allowed to create workflow files.

To enable CI, a repository member runs:

```bash
git mv ci/github-ci.yml .github/workflows/ci.yml
git commit -m "Enable CI workflow"
git push
```

What it runs on every push/PR:

- **web** — `npm run check` (contracts + web TypeScript), `npm test`, `npm run build`
- **python** — ruff, `mypy --strict`, pytest for `ml` and `services/api`
- **synthetic-smoke** — regenerates the synthetic fixture and fails on drift,
  regenerates `packages/contracts` and fails if stale, then boots the API
  against the fixture gallery and runs `scripts/smoke_search.py`

Every step is reproducible locally with `npm run check`, `npm test`,
`npm run build`, `npm run check:py`, `npm run contracts`, and `npm run smoke`.
