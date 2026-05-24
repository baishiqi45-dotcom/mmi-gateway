#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-./mmi-golden-path}"
CONFIG="$ROOT/mmi.config.json"
RUN_DIR="$ROOT/mmi-runs/starter-run"

npx @mmi/gateway init --starter --profile agent --config "$CONFIG" --json
npx @mmi/gateway selftest --json
npx @mmi/gateway ingest --config "$CONFIG" --out "$RUN_DIR" --file "$ROOT/sources/starter.md" --dry-run --json
npx @mmi/gateway ingest --config "$CONFIG" --out "$RUN_DIR" --file "$ROOT/sources/starter.md" --json
npx @mmi/gateway validate "$RUN_DIR" --json
npx @mmi/gateway handoff "$RUN_DIR" --json

printf 'MMI golden path wrote %s\n' "$RUN_DIR"
