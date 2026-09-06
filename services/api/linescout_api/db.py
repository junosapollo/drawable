"""SQLite (WAL mode) connection management and forward-only migrations.

Migrations are plain SQL files in ``linescout_api/migrations`` named
``NNNN_description.sql``. Each runs once, in order, inside a transaction, and
its number is recorded in ``schema_migrations``. There is no down-migration:
the database is a local cache of manifest + event data and can be rebuilt.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from importlib import resources
from pathlib import Path

log = logging.getLogger(__name__)

_MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


def connect(db_path: Path | str) -> sqlite3.Connection:
    """Open a connection with the pragmas every LineScout connection needs."""
    if isinstance(db_path, Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def list_migrations() -> list[tuple[int, str, str]]:
    """Return ``(number, name, sql)`` sorted by number, validating names and gaps."""
    package = resources.files("linescout_api") / "migrations"
    found: list[tuple[int, str, str]] = []
    for entry in package.iterdir():
        match = _MIGRATION_NAME.match(entry.name)
        if not match:
            continue
        found.append((int(match.group(1)), entry.name, entry.read_text(encoding="utf-8")))
    found.sort()
    for expected, (number, name, _) in enumerate(found, start=1):
        if number != expected:
            msg = f"migration numbering gap or duplicate at {name} (expected {expected:04d})"
            raise RuntimeError(msg)
    return found


def applied_versions(connection: sqlite3.Connection) -> set[int]:
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version INTEGER PRIMARY KEY,"
        " name TEXT NOT NULL,"
        " applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
    )
    return {row["version"] for row in connection.execute("SELECT version FROM schema_migrations")}


def migrate(connection: sqlite3.Connection) -> list[str]:
    """Apply pending migrations. Returns the names applied in this call."""
    done = applied_versions(connection)
    applied: list[str] = []
    for version, name, sql in list_migrations():
        if version in done:
            continue
        log.info("applying migration %s", name)
        # ``executescript`` would issue an implicit COMMIT and break atomicity,
        # so split the file into statements and run them inside one transaction.
        connection.execute("BEGIN")
        try:
            for statement in split_statements(sql):
                connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations(version, name) VALUES (?, ?)", (version, name)
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        applied.append(name)
    return applied


def split_statements(sql: str) -> list[str]:
    """Split a migration file into complete SQL statements.

    Uses :func:`sqlite3.complete_statement` so semicolons inside string
    literals, comments, or CHECK expressions do not split a statement.
    """
    statements: list[str] = []
    buffer: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if not buffer and (not stripped or stripped.startswith("--")):
            continue
        buffer.append(line)
        candidate = "\n".join(buffer)
        if sqlite3.complete_statement(candidate):
            statements.append(candidate.strip())
            buffer = []
    if any(line.strip() and not line.strip().startswith("--") for line in buffer):
        msg = "migration ends with an incomplete SQL statement"
        raise RuntimeError(msg)
    return statements


def schema_version(connection: sqlite3.Connection) -> int:
    row = connection.execute(
        "SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations"
    ).fetchone()
    return int(row["v"]) if row else 0


@contextmanager
def transaction(connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    connection.execute("BEGIN")
    try:
        yield connection
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
