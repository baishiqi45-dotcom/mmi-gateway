# Agent Integration

This guide is for agents and automation scripts that need a stable contract.

## Minimal Flow

For a messy local project folder, start here:

```bash
npx @mmi/gateway ingest-project ./project --out ./project/.mmi --dry-run --json
npx @mmi/gateway ingest-project ./project --out ./project/.mmi --json
npx @mmi/gateway review ./project/.mmi --json
npx @mmi/gateway validate ./project/.mmi --json
```

Read `START_HERE.md`, `project_intake_manifest.json`,
`top_review_targets.jsonl`, and `gap_and_blocker_report.md` before opening the
raw folder again.

For an already curated source manifest:

```bash
npx @mmi/gateway doctor --json
npx @mmi/gateway selftest --json
npx @mmi/gateway ingest --sources-json ./sources.json --out ./mmi-run --dry-run --json
npx @mmi/gateway ingest --sources-json ./sources.json --out ./mmi-run --json
npx @mmi/gateway validate ./mmi-run --json
npx @mmi/gateway handoff ./mmi-run --json
```

Discover copy-pasteable flows with:

```bash
npx @mmi/gateway recipes --json
```

For stream-oriented callers, `--sources` and `--stdin-jsonl` also accept JSONL:

```bash
jq -c '.sources[]' sources.json | npx @mmi/gateway ingest --stdin-jsonl --out ./mmi-run --json
```

## What To Read

For `ingest-project`:

1. `START_HERE.md`
2. `project_intake_manifest.json`
3. `top_review_targets.jsonl`
4. `human_review_surface.md`
5. `visual_contact_sheet.html`
6. `review_queue.jsonl`
7. `review_decisions.template.jsonl`
8. `video_window_review_matrix.json`
9. `atoms.ndjson`
10. `gap_and_blocker_report.md`
11. `packet.json`
12. `agent_handoff.md`

`source_manifest.json` metadata includes `originKind`, `assetRole`, and
`assetRoleReason`. Treat `raw_capture` and `original_media` as better first
review candidates than `derived_frame` or `generated_artifact`.

For plain `ingest`:

1. `gateway_manifest.json`
2. `issues.json`
3. `packet.json`
4. `review_items.jsonl`
5. `source_matrix.json`
6. `agent_handoff.md`

## What Not To Do

- Do not treat `claims.jsonl` as verified claims.
- Do not bind `source_matrix.json`.
- Do not turn `review_items.jsonl` into a review verdict automatically.
- Do not send local private text/document content to a provider unless `allowLocalTextUpload` was explicitly reviewed.
- Do not upload local private media without a reviewed signed-URL storage boundary.
- Do not treat `accept` in `review_decisions.template.jsonl` as source truth;
  it only means the candidate atom may continue into the next workflow step.

## Review Decisions

The project intake queue is intentionally file-based:

```bash
npx @mmi/gateway review ./project/.mmi --json
```

Fill `review_decisions.template.jsonl` with:

```jsonl
{"reviewItemId":"review_project_00001","decision":"accept","reviewerNote":"useful first-pass atom","rightsStatus":"not_reviewed"}
{"reviewItemId":"review_project_00002","decision":"edit","editedContent":"Corrected candidate text.","reviewerNote":"fixed wording"}
{"reviewItemId":"review_project_00003","decision":"discard","reviewerNote":"duplicate frame"}
{"reviewItemId":"review_project_00004","decision":"defer","nextAction":"needs human rights check"}
```

Then run:

```bash
npx @mmi/gateway review ./project/.mmi \
  --decisions ./project/.mmi/review_decisions.template.jsonl \
  --json
```

This writes `review_decision_summary.json`, `accepted_atoms.jsonl`,
`edited_atoms.jsonl`, `discarded_review_items.jsonl`, and
`deferred_review_items.jsonl`. It does not mutate `packet.json`.

## Recovery Loop

When a JSON response has `ok: false`, inspect `issues`.

```bash
npx @mmi/gateway explain <issue-code> --json
```

Every issue object includes `severity` and `recovery`. Prefer fixing the
upstream source manifest or config, then rerun `ingest --dry-run --json`.
Every JSON response also includes `nextCommands`; agents may execute those only
after checking that the command is appropriate for the current workspace.

## Source Manifest

Use a source manifest when another system already owns IDs, privacy, rights, or
metadata.

```bash
npx @mmi/gateway schema --kind source-manifest > source-manifest.schema.json
```

The gateway accepts either:

- `{ "sources": [ ... ] }`
- `[ ... ]`
- JSONL with one source object per line

The object form is preferred because it is easier to extend without breaking
callers.

Published schemas:

- `@mmi/gateway/source-manifest.schema.json`
- `@mmi/gateway/cli-result.schema.json`
- `@mmi/gateway/schema.json`

Exit codes are documented in `docs/EXIT_CODES.md`.
