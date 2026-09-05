# drawable

A local-first line-art reference copilot for character artists. The current implementation is a frontend vertical slice with a layered pressure-sensitive canvas, responsive professional workspace, local autosave/export, and deterministic procedural reference fixtures.

## Run the frontend

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/draw`.

The frontend does not require a backend. Its fixture service simulates live reference results after each completed stroke. Type `slow`, `error`, or `empty` into the optional reference hint to exercise those states.

## Checks

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

The artist workspace is at `/draw`. `/curate`, `/benchmark`, and `/setup` provide responsive fixture-based scaffolds for the later research workflows.
