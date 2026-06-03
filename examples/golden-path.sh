#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-./mmi-golden-path}"
CONFIG="$ROOT/mmi.config.json"
RUN_DIR="$ROOT/mmi-runs/starter-run"

mmi init --starter --profile agent --config "$CONFIG" --json
mmi selftest --json
mmi ingest --config "$CONFIG" --out "$RUN_DIR" --file "$ROOT/sources/starter.md" --dry-run --json
mmi ingest --config "$CONFIG" --out "$RUN_DIR" --file "$ROOT/sources/starter.md" --json
mmi validate "$RUN_DIR" --json
mmi handoff "$RUN_DIR" --json

printf 'MMI golden path wrote %s\n' "$RUN_DIR"
