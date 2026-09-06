#!/usr/bin/env python
"""Reset every asset in the loaded manifest back to ``review_state='unreviewed'``.

This is a demo helper for the Milestone 2 curation UI: the synthetic
manifest ships every asset pre-accepted so unit tests have a known
starting point, but for a live demo we want the curation queue to be
populated. Run this against the API's database (the default lives at
``data/linescout.sqlite3``) once the API has been started at least once
and the gallery has been loaded.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = REPO_ROOT / "data" / "linescout.sqlite3"


def main() -> int:
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DB_PATH
    if not db_path.is_file():
        print(f"No database at {db_path}. Start the API once and re-run.")
        return 1
    with sqlite3.connect(db_path) as conn:
        before = conn.execute(
            "SELECT review_state, COUNT(*) FROM assets GROUP BY review_state"
        ).fetchall()
        conn.execute("DELETE FROM curation_labels")
        conn.execute("UPDATE assets SET review_state = 'unreviewed', review_quality = NULL, enabled = 1")
        conn.commit()
        after = conn.execute(
            "SELECT review_state, COUNT(*) FROM assets GROUP BY review_state"
        ).fetchall()
    print(f"Before: {dict(before)}")
    print(f"After:  {dict(after)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
