from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


class MLError(ValueError):
    """An expected, user-actionable ML preparation failure."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def load_json(path: Path) -> Any:
    if path.is_symlink() or not path.is_file():
        raise MLError(f"Expected a regular, non-symlink JSON file: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MLError(f"Could not read valid UTF-8 JSON from {path}: {error}") from error


def resolve_private_path(root: Path, relative: str, *, must_exist: bool = True) -> Path:
    candidate_text = Path(relative)
    if candidate_text.is_absolute() or not relative or "\\" in relative:
        raise MLError("Data paths must be nonempty, relative POSIX paths inside the private data root")
    if any(part in {"", ".", ".."} for part in relative.split("/")):
        raise MLError("Data path contains a noncanonical path component")
    root = root.resolve()
    candidate = root.joinpath(*relative.split("/"))
    cursor = candidate
    while cursor != root:
        if cursor.is_symlink():
            raise MLError("Data paths may not traverse symbolic links")
        cursor = cursor.parent
    try:
        resolved = candidate.resolve(strict=must_exist)
        resolved.relative_to(root)
    except (OSError, ValueError) as error:
        raise MLError("Data path is missing or escapes the private data root") from error
    if must_exist and not resolved.is_file():
        raise MLError("Data path must identify a regular file")
    return resolved


def write_json_atomic(path: Path, value: Any, *, refuse_overwrite: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if (path.exists() or path.is_symlink()) and refuse_overwrite:
        raise MLError(f"Refusing to overwrite existing immutable artifact: {path}")
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if refuse_overwrite:
            try:
                os.link(temporary, path)
            except FileExistsError as error:
                raise MLError(f"Refusing to overwrite existing immutable artifact: {path}") from error
            temporary.unlink()
        else:
            os.replace(temporary, path)
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)
