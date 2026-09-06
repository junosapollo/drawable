# data/

Local datasets, downloaded sources, model checkpoints, embeddings, FAISS
indexes, thumbnails, the SQLite database, and user drawings live here.

**Nothing in this directory is committed** (see the repository `.gitignore`);
only this README is tracked so the folder exists on a fresh clone.

Layout produced by later milestones:

```
data/
  linescout.sqlite3          # API metadata/events/preferences (auto-created)
  sources/<dataset>/         # raw downloads; each dataset keeps its own terms
  gallery/<version>/         # manifest.json + originals/ line_art/ thumbnails/
  indexes/<version>/         # FAISS indexes + id maps
  models/                    # checkpoints (hashes recorded in model cards)
  sequences/                 # the 150 project progressive sketch sequences
```

To try the API without any real data, point it at the committed synthetic
fixture: `LINESCOUT_GALLERY_MANIFEST=ml/fixtures/synthetic/manifest.json`.
