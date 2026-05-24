# Recipes

These recipes are intentionally small. They show how to connect MMI without
turning it into a workflow server.

## Manual First Run

No API key, no network provider call:

```bash
npx @mmi/gateway init --starter --profile agent --config ./mmi.config.json --json
npx @mmi/gateway selftest --json
npx @mmi/gateway ingest --config ./mmi.config.json \
  --out ./mmi-runs/run-001 \
  --file ./sources/starter.md \
  --dry-run \
  --json
npx @mmi/gateway ingest --config ./mmi.config.json \
  --out ./mmi-runs/run-001 \
  --file ./sources/starter.md \
  --json
npx @mmi/gateway validate ./mmi-runs/run-001 --json
npx @mmi/gateway handoff ./mmi-runs/run-001 --json
```

## Agent JSONL Intake

Use JSONL when an agent already streams one source record per line:

```bash
printf '%s\n' \
  '{"id":"brief","type":"text","text":"Project brief.","privacy":"synthetic","rights":"not_reviewed"}' \
  | npx @mmi/gateway ingest --stdin-jsonl --out ./mmi-runs/jsonl-run --json
```

Read `gateway_manifest.json` first, then `issues.json`, then `agent_handoff.md`.

## Remote Media URL

Provider dispatch should receive reviewed remote URLs or signed URLs, not raw
local private media paths:

```json
{"id":"clip_001","type":"video","uri":"https://cdn.example/clip.mp4","privacy":"public","rights":"not_reviewed","provider":"mock"}
```

```bash
npx @mmi/gateway ingest --sources ./sources.jsonl --out ./mmi-runs/media-run --json
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
