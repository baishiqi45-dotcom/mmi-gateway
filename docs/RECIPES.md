# Recipes

These recipes are intentionally small. They show how to connect MMI without
turning it into a workflow server.

## Manual First Run

No API key, no network provider call:

```bash
mmi init --starter --profile agent --config ./mmi.config.json --json
mmi selftest --json
mmi ingest --config ./mmi.config.json \
  --out ./mmi-runs/run-001 \
  --file ./sources/starter.md \
  --dry-run \
  --json
mmi ingest --config ./mmi.config.json \
  --out ./mmi-runs/run-001 \
  --file ./sources/starter.md \
  --json
mmi validate ./mmi-runs/run-001 --json
mmi handoff ./mmi-runs/run-001 --json
```

## Agent JSONL Intake

Use JSONL when an agent already streams one source record per line:

```bash
printf '%s\n' \
  '{"id":"brief","type":"text","text":"Project brief.","privacy":"synthetic","rights":"not_reviewed"}' \
  | mmi ingest --stdin-jsonl --out ./mmi-runs/jsonl-run --json
```

Read `gateway_manifest.json` first, then `issues.json`, then `agent_handoff.md`.

## Local Project Folder Intake

Use this when the useful first step is "open this messy project folder" rather
than "consume a hand-built source manifest":

```bash
mmi ingest-project ./my-project \
  --profile creative-project \
  --out ./my-project/.mmi \
  --dry-run \
  --json

mmi ingest-project ./my-project \
  --profile creative-project \
  --out ./my-project/.mmi \
  --json
```

Start with:

- `.mmi/START_HERE.md`
- `.mmi/top_review_targets.jsonl`
- `.mmi/human_review_surface.md`
- `.mmi/visual_contact_sheet.html`
- `.mmi/video_window_review_matrix.json`
- `.mmi/atoms.ndjson`
- `.mmi/review_decisions.template.jsonl`
- `.mmi/project_foundation_candidate.json`
- `.mmi/gap_and_blocker_report.md`

By default this route is local-first. It may call local `ffprobe`/`ffmpeg` when
available, but it does not upload local private media to a provider. Use
`--dry-run --json` first to inspect discovered files without writing output.
Keyframe extraction is opt-in with `--extract-keyframes`.

To turn review into structured files:

```bash
mmi review ./my-project/.mmi --json
mmi review ./my-project/.mmi \
  --decisions ./my-project/.mmi/review_decisions.template.jsonl \
  --json
```

## Agent Review Perception

Use this after `ingest-project` when an agent can inspect local images/video
itself and mainly needs a good target list, transcript sidecars, ASR blockers,
and optional keyframes:

```bash
mmi perceive ./my-project/.mmi --json
```

This writes `.mmi/perception/agent_review_targets.jsonl` and does not call a
visual provider by default.

For audio or speech extraction through DashScope Paraformer, give MMI reviewed
remote URLs:

```bash
mmi perceive ./my-project/.mmi \
  --asr \
  --target-type video_window \
  --url-map ./urls.jsonl \
  --json

mmi asr fetch ./my-project/.mmi --wait --json
```

Example `urls.jsonl`:

```jsonl
{"sourceId":"src_video_001","url":"https://storage.example/clip.mp4"}
```

Review `.mmi/perception/asr_results.jsonl` and
`.mmi/perception/transcripts/` before using transcript text downstream.
Fetched transcripts are also added back into `transcript_sidecars.jsonl` and
`agent_review_targets.jsonl`.

When the receiving agent cannot see media, add an explicit visual fallback:

```bash
mmi perceive ./my-project/.mmi \
  --visual-provider dashscope \
  --target-type image \
  --limit 3 \
  --allow-local-media \
  --json
```

## Remote Media URL

Provider dispatch should receive reviewed remote URLs or signed URLs, not raw
local private media paths:

```json
{"id":"clip_001","type":"video","uri":"https://cdn.example/clip.mp4","privacy":"public","rights":"not_reviewed","provider":"mock"}
```

```bash
mmi ingest --sources ./sources.jsonl --out ./mmi-runs/media-run --json
```

## Custom Provider Module

See `examples/custom-provider-module/`. The module must export a
`ProviderAdapter` or a factory returning one, set `apiVersion: 1`, and avoid
external API calls in `healthCheck()`.

## Signed URL Storage Boundary

Use `createSignedUrlStorageBoundaryPlugins()` when a provider needs a signed
URL but the persisted packet should not store the signed URL itself. See
`examples/signed-url-storage.ts`.

## Downstream Integrations

Keep downstream integrations outside the core package. Read
`gateway_manifest.json` first, then map `packet.json`, `review_items.jsonl`, and
`source_matrix.json` into your project workflow as candidate-only input.
