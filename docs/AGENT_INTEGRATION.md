# Agent Integration

This guide is for agents and automation scripts that need a stable contract.

## Minimal Flow

For a messy local project folder, start here:

```bash
mmi ingest-project ./project --out ./project/.mmi --dry-run --json
mmi ingest-project ./project --out ./project/.mmi --json
mmi perceive ./project/.mmi --json
mmi review ./project/.mmi --json
mmi validate ./project/.mmi --json
```

Read `START_HERE.md`, `project_intake_manifest.json`,
`top_review_targets.jsonl`, and `gap_and_blocker_report.md` before opening the
raw folder again.

For an already curated source manifest:

```bash
mmi doctor --json
mmi selftest --json
mmi ingest --sources-json ./sources.json --out ./mmi-run --dry-run --json
mmi ingest --sources-json ./sources.json --out ./mmi-run --json
mmi validate ./mmi-run --json
mmi handoff ./mmi-run --json
```

Discover copy-pasteable flows with:

```bash
mmi recipes --json
```

For stream-oriented callers, `--sources` and `--stdin-jsonl` also accept JSONL:

```bash
jq -c '.sources[]' sources.json | mmi ingest --stdin-jsonl --out ./mmi-run --json
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

## Perception Bundle

Use `mmi perceive` after `ingest-project` when the next agent needs a tighter
review bundle:

```bash
mmi perceive ./project/.mmi --json
```

Default mode is `agent_review_first`. It reads `top_review_targets.jsonl` and
`source_manifest.json`, then writes under `.mmi/perception/`:

1. `perception_manifest.json`
2. `agent_review_targets.jsonl`
3. `transcript_sidecars.jsonl`
4. `perception_blockers.json`
5. `asr_tasks.jsonl`
6. `provider_observations.jsonl`
7. `perceived_atoms.ndjson`
8. `perception_review_queue.jsonl`

For Codex-like agents that can inspect local media, start with
`agent_review_targets.jsonl`, open the referenced image/video/keyframe paths,
and compare them against transcript sidecars. Do not upload long videos to a
provider just to duplicate what the receiving agent can already inspect.

Use ASR only when you have reviewed remote URLs:

```bash
mmi perceive ./project/.mmi \
  --asr \
  --target-type video_window \
  --url-map ./urls.jsonl \
  --json

mmi asr fetch ./project/.mmi --wait --json
```

`urls.jsonl` can map either `sourceId` or `targetId`:

```jsonl
{"sourceId":"src_video_001","url":"https://storage.example/clip.mp4"}
```

`mmi asr fetch` reads `asr_tasks.jsonl`, writes raw task responses to
`asr_task_responses/`, and writes successful transcript downloads to
`transcripts/`. It also refreshes `transcript_sidecars.jsonl` and
`agent_review_targets.jsonl`, so agents can stay on the same review entrypoint.
Treat every transcript as `review_required`; it is an input for the receiving
agent, not project truth. Transcript downloads are HTTP(S)-only and size-limited
by `--max-transcript-bytes`.

Use visual provider fallback only when the receiving agent cannot inspect media
itself, or when the user explicitly wants provider perception:

```bash
mmi perceive ./project/.mmi \
  --visual-provider dashscope \
  --target-type image \
  --limit 3 \
  --allow-local-media \
  --json
```

`perceive` never mutates `packet.json`; provider observations stay in
`.mmi/perception/` and remain pending review.

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
mmi review ./project/.mmi --json
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
mmi review ./project/.mmi \
  --decisions ./project/.mmi/review_decisions.template.jsonl \
  --json
```

This writes `review_decision_summary.json`, `accepted_atoms.jsonl`,
`edited_atoms.jsonl`, `discarded_review_items.jsonl`, and
`deferred_review_items.jsonl`. It does not mutate `packet.json`.

## Recovery Loop

When a JSON response has `ok: false`, inspect `issues`.

```bash
mmi explain <issue-code> --json
```

Every issue object includes `severity` and `recovery`. Prefer fixing the
upstream source manifest or config, then rerun `ingest --dry-run --json`.
Every JSON response also includes `nextCommands`; agents may execute those only
after checking that the command is appropriate for the current workspace.

## Source Manifest

Use a source manifest when another system already owns IDs, privacy, rights, or
metadata.

```bash
mmi schema --kind source-manifest > source-manifest.schema.json
```

The gateway accepts either:

- `{ "sources": [ ... ] }`
- `[ ... ]`
- JSONL with one source object per line

The object form is preferred because it is easier to extend without breaking
callers.

Published schemas:

- `mmi-gateway/source-manifest.schema.json`
- `mmi-gateway/cli-result.schema.json`
- `mmi-gateway/schema.json`

Exit codes are documented in `docs/EXIT_CODES.md`.
