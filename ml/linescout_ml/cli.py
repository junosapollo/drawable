"""``linescout-manifest`` command line: validate manifests and emit the JSON schema.

Usage::

    linescout-manifest validate path/to/manifest.json [--data-root DIR] [--require-files]
    linescout-manifest schema [--out path/to/schema.json]
    linescout-manifest synth --out path/to/manifest.json [--count 24] [--seed 7]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from linescout_ml.manifest import Manifest, check_split_integrity, dump_json_schema
from linescout_ml.synthetic import write_synthetic_dataset


def _cmd_validate(args: argparse.Namespace) -> int:
    path = Path(args.manifest)
    try:
        manifest = Manifest.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, ValidationError) as error:
        print(f"INVALID {path}: {error}", file=sys.stderr)
        return 1

    problems = check_split_integrity(manifest.records)
    if args.require_files:
        root = Path(args.data_root or path.parent)
        for record in manifest.enabled_records:
            for label, rel in (
                ("original", record.original_path),
                ("line_art", record.line_art_path),
                ("thumbnail", record.thumbnail_path),
            ):
                if not (root / rel).is_file():
                    problems.append(f"{record.asset_id}: missing {label} file {rel}")

    if problems:
        for problem in problems:
            print(f"PROBLEM {problem}", file=sys.stderr)
        return 1

    enabled = len(manifest.enabled_records)
    print(
        f"OK {path}: {len(manifest.records)} records, {enabled} enabled, "
        f"dataset_version={manifest.dataset_version}, content_hash={manifest.content_hash()[:12]}"
    )
    return 0


def _cmd_schema(args: argparse.Namespace) -> int:
    text = dump_json_schema()
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        sys.stdout.write(text)
    return 0


def _cmd_synth(args: argparse.Namespace) -> int:
    manifest_path = write_synthetic_dataset(Path(args.out), count=args.count, seed=args.seed)
    summary = json.loads(manifest_path.read_text(encoding="utf-8"))
    print(f"wrote {manifest_path} with {len(summary['records'])} records")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="linescout-manifest")
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate", help="validate a manifest JSON file")
    validate.add_argument("manifest")
    validate.add_argument(
        "--data-root", help="directory the manifest's relative paths resolve from"
    )
    validate.add_argument(
        "--require-files", action="store_true", help="also check enabled asset files exist"
    )
    validate.set_defaults(func=_cmd_validate)

    schema = sub.add_parser("schema", help="print or write the manifest JSON schema")
    schema.add_argument("--out")
    schema.set_defaults(func=_cmd_schema)

    synth = sub.add_parser("synth", help="write a small synthetic dataset for smoke tests")
    synth.add_argument("--out", required=True, help="output directory")
    synth.add_argument("--count", type=int, default=24)
    synth.add_argument("--seed", type=int, default=7)
    synth.set_defaults(func=_cmd_synth)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
