# Multimodal Intake Gateway

[![CI](https://github.com/baishiqi45-dotcom/mmi-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/baishiqi45-dotcom/mmi-gateway/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://github.com/baishiqi45-dotcom/mmi-gateway/actions/workflows/scorecard.yml/badge.svg)](https://github.com/baishiqi45-dotcom/mmi-gateway/actions/workflows/scorecard.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=20.19](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](package.json)

Provider-neutral intake for text, documents, web pages, images, audio, and video. MMI turns raw project material into a reviewable candidate packet without claiming source truth, project truth, or production readiness.

> **Status:** reference slice. MMI is one intake component behind a broader AI
> production-control workflow. It is not the main product, not a project truth
> store, and not a production-readiness claim.

Use it when an AI agent needs a clean first pass over messy project material
before retrieval, planning, implementation, or human review.

## Why

Most AI project workflows need the same first step: collect mixed inputs, preserve provenance, ask a model or manual reviewer for a candidate description, and stop before downstream systems treat that description as fact. MMI provides that boundary as a small TypeScript library and CLI.

MMI is useful when you need to:

- scan a local project folder without uploading private media by default
- preserve provenance across text, documents, images, audio, video, and web sources
- produce candidate observations, review queues, and agent handoff files
- keep provider-specific responses out of downstream truth stores
- give the next agent a structured packet instead of a vague summary

If you reuse the pattern, keep the same boundary: intake creates review
material, not accepted project truth.

## Install

GitHub install works immediately:

```bash
npm install -g github:baishiqi45-dotcom/mmi-gateway
mmi selftest --json
```

One-off run without a global install:

```bash
npm exec --package github:baishiqi45-dotcom/mmi-gateway -- mmi selftest --json
```

NPM install path after the first public package publish:

```bash
npm install mmi-gateway
```

For source checkout development:

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Quickstart

Local project-folder intake, no API key:

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

This creates the usual candidate packet plus practical local review artifacts:

- `project_intake_manifest.json`
- `START_HERE.md`
- `START_HERE.json`
- `visual_asset_library.json`
- `visual_contact_sheet.html`
- `video_window_review_matrix.json`
- `top_review_targets.jsonl`
- `atoms.ndjson`
- `review_queue.jsonl`
- `review_decisions.template.jsonl`
- `object_evidence_ledger.json`
- `term_correction_queue.jsonl`
- `project_foundation_candidate.json`
- `human_review_surface.md`
- `gap_and_blocker_report.md`

Local private media is not uploaded automatically. If `ffprobe` or `ffmpeg` is
available, MMI uses it for local video metadata. Keyframe extraction is
opt-in with `--extract-keyframes`; otherwise video windows stay as lightweight
review scaffolds.

When the receiving agent can inspect images/video locally, use the agent-first
perception bundle instead of uploading long media to a provider:

```bash
mmi perceive ./my-project/.mmi --json
```

This writes `.mmi/perception/agent_review_targets.jsonl`,
`.mmi/perception/transcript_sidecars.jsonl`, `.mmi/perception/perception_manifest.json`,
and clear blockers if audio/video needs a remote ASR route. It does not mutate
`packet.json`, and it does not call Qwen or upload visual media by default.

For speech extraction with DashScope Paraformer, provide reviewed HTTP(S) or
OSS URLs for selected audio/video targets:

```bash
mmi perceive ./my-project/.mmi \
  --asr \
  --target-type video_window \
  --url-map ./urls.jsonl \
  --json

mmi asr fetch ./my-project/.mmi --wait --json
```

`mmi asr fetch` reads `.mmi/perception/asr_tasks.jsonl`, polls task state when
requested, downloads successful `transcription_url` results, and writes
review-required transcript sidecars under `.mmi/perception/transcripts/`. It
also refreshes `transcript_sidecars.jsonl` and `agent_review_targets.jsonl` so
the next agent can find fetched transcripts from the normal review entrypoint.
Transcript downloads are limited to HTTP(S) URLs and `--max-transcript-bytes`
(20 MB by default).

Use Qwen visual perception only as an explicit fallback, for example when the
next agent cannot view the media itself:

```bash
mmi perceive ./my-project/.mmi \
  --visual-provider dashscope \
  --target-type image \
  --allow-local-media \
  --limit 3 \
  --json
```

After a project intake run, another agent can start with:

```bash
mmi review ./my-project/.mmi --json
mmi review ./my-project/.mmi \
  --decisions ./my-project/.mmi/review_decisions.template.jsonl \
  --json
```

`review_decisions.template.jsonl` is a fill-in file. Replace each `decision`
with `accept`, `edit`, `discard`, or `defer`; MMI writes review summaries
without mutating `packet.json`.

One-minute starter path:

```bash
mmi init --starter --profile agent --config ./my-project/mmi.config.json --json
mmi doctor --config ./my-project/mmi.config.json --json
mmi ingest --config ./my-project/mmi.config.json \
  --out ./my-project/mmi-runs/starter-run \
  --file ./my-project/sources/starter.md \
  --json
mmi validate ./my-project/mmi-runs/starter-run --json
mmi handoff ./my-project/mmi-runs/starter-run --json
```

The starter/manual path does not call an external provider and does not need an
API key. Expected result: `ok: true`, a `gateway_manifest.json`, a `packet.json`,
and an `agent_handoff.md` that says the packet is candidate-only.

Agent-safe dry run before provider dispatch:

```bash
mmi ingest --config ./my-project/mmi.config.json \
  --sources ./sources.jsonl \
  --out ./my-project/mmi-runs/run-001 \
  --dry-run \
  --json
```

The output directory contains:

- `gateway_manifest.json`: machine-readable map for tools and agents
- `packet.json`: complete machine-readable packet
- `sources.json`: normalized source list
- `evidence_atoms.jsonl`: candidate evidence atoms
- `claims.jsonl`: review-required claims
- `review_items.jsonl`: human-review queue
- `source_matrix.json`: unbound source matrix draft
- `issues.json`: gateway issues produced during intake
- `agent_handoff.md`: compact instructions for the next agent or workflow step
- `README.md`: human-readable packet boundary

Every `--json` response includes:

- `schema: "mmi.gateway.cli_result"`
- `schemaVersion`
- `gatewayVersion`
- `ok`
- `data`
- `nextCommands`

If `ok` is false, read `issues`, then run `mmi explain <issue-code> --json`.

For copy-paste paths, run:

```bash
mmi recipes --json
```

## Provider Model

Core ships with:

- `manual`: no provider call; useful for local text, pointers, tests, and private media
- `mock`: deterministic provider for examples and CI
- `dashscope`: Qwen-Omni OpenAI-compatible inspection for public or signed text/image/audio/video URLs
- `openai-compatible`: generic `/chat/completions` adapter for compatible APIs

`mmi perceive` is separate from the generic provider adapter. Its default mode
is `agent_review_first`: it builds local review targets and transcript/ASR
pointers for agents like Codex that can inspect media directly. `--asr`
submits Paraformer tasks only for reviewed remote URLs, and
`mmi asr fetch` retrieves finished transcripts as sidecars. `--visual-provider
dashscope` opts into Qwen visual perception for selected targets.

| Provider | API key | Network | Local files | Best use |
| --- | --- | --- | --- | --- |
| `manual` | no | no | pointer-only | first run, private material, CI |
| `mock` | no | no | no | deterministic tests and recipes |
| `dashscope` | `DASHSCOPE_API_KEY` | yes | no by default | reviewed public/signed multimodal URLs |
| `openai-compatible` | configured env var | yes | no by default | compatible text or URL-capable providers |
| `module` | adapter-defined | adapter-defined | adapter-defined | project-owned provider plugins |

For provider-backed runs, copy `.env.example` into your local secret workflow
or export the variables directly. Never put API keys in `mmi.config.json`.

Providers implement one interface:

```ts
import type { ProviderAdapter } from "mmi-gateway";

export const myProvider: ProviderAdapter = {
  apiVersion: 1,
  id: "my-provider",
  displayName: "My Provider",
  capabilities: {
    sourceTypes: ["text", "image"],
    acceptsLocalFiles: false,
    acceptsRemoteUrls: true,
    acceptsDataUrls: false,
  },
  async inspect(source, context) {
    return {
      sourceId: source.id,
      providerId: "my-provider",
      content: "Candidate description only.",
      confidence: 0.5,
      confidenceBasis: "Provider observation; human review required.",
    };
  },
};
```

## Use As A Library

```ts
import { createGateway, createManualProvider } from "mmi-gateway";

const gateway = createGateway({
  defaultProvider: "manual",
  providers: [createManualProvider()],
  projectId: "demo",
});

const result = await gateway.run({
  outputDir: "mmi-runs/run-001",
  sources: [{ type: "text", text: "Brief text", privacy: "synthetic" }],
});

console.log(result.packet.status);
```

## Project Integrations

MMI core does not import Next.js, databases, or project-specific code. Project
integrations should live outside the core package and read the canonical packet
directory.

Good integration targets include webhooks, queues, file systems, CRMs, creative
runtimes, research notebooks, or local knowledge bases. The boundary test is
simple: deleting an integration should not break core provider tests.

## Safety Defaults

- Local private text/document upload to providers is blocked unless policy explicitly allows it.
- Local media upload is blocked unless a storage adapter creates an explicit signed URL.
- Data URLs are blocked by default.
- Provider responses are converted into candidate observations, not raw response logs.
- Every output is review-required and candidate-only.
- Secret-like packet content fails closed before `packet.json` is written.
- API keys are read from environment variables and are never written into packets.

## Documentation

- [Configuration](CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Provider Authoring](PROVIDER_AUTHORING.md)
- [API Reference](docs/API_REFERENCE.md)
- [Agent Integration](docs/AGENT_INTEGRATION.md)
- [Recipes](docs/RECIPES.md)
- [Source Manifest Recipe](docs/SOURCE_MANIFEST_RECIPE.md)
- [Exit Codes](docs/EXIT_CODES.md)
- [Error Codes](docs/ERROR_CODES.md)
- [Open Source Readiness](docs/OPEN_SOURCE_READINESS.md)
- [Release Guide](docs/RELEASE.md)
- [Promotion Plan](docs/PROMOTION.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Schema imports:

- `mmi-gateway/schema` exports the TypeScript/Zod schema helpers.
- `mmi-gateway/schema.json` exports the versioned JSON Schema file.
- `mmi-gateway/source-manifest.schema.json` exports the source manifest schema.
- `mmi-gateway/cli-result.schema.json` exports the CLI JSON response schema.

Helpful CLI utilities:

- `mmi explain <issue-code>` prints the recovery path for an issue.
- `mmi ingest-project <folder>` scans a local project folder and writes visual/video/project-foundation review artifacts.
- `mmi perceive <project-intake-dir>` writes an agent-readable perception bundle, with optional ASR and visual-provider fallback.
- `mmi asr fetch|poll <project-intake-dir>` retrieves submitted ASR task results into review-required transcript sidecars.
- `mmi review <project-intake-dir>` summarizes or applies filled review decisions.
- `mmi recipes --json` lists copy-pasteable integration flows.
- `mmi schema --kind source-manifest` prints the source manifest JSON Schema.
- `mmi selftest --json` runs a no-network ingest/validate/manifest/secret-fail-closed smoke test.
- `mmi init --starter --profile agent|dashscope|openai-compatible` writes a runnable starter config and sample source.
- `mmi --version` prints the package version.

## CI

The repository workflow should run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run selftest
```

## License

MIT
