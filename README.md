# drawable

A line-art reference copilot for character artists.

## Run the frontend

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/draw`.

The frontend does not require a backend. Its fixture service simulates live reference results after each completed stroke. Type `slow`, `error`, or `empty` into the optional reference hint to exercise those states.

Use **Export drawing → drawable project · Editable** to save a lossless `.drawable` project. **Import sketch** accepts `.drawable`, PNG, and self-contained SVG files and opens each imported sketch as an independent drawing in a new tab.

## Checks

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

The artist workspace is at `/draw`. `/curate`, `/benchmark`, and `/setup` provide responsive fixture-based scaffolds for the later research workflows.
