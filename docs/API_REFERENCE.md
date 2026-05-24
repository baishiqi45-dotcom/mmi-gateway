# API Reference

## `createGateway(config)`

Creates a reusable gateway instance.

```ts
import { createGateway, createManualProvider } from "@mmi/gateway";

const gateway = createGateway({
  defaultProvider: "manual",
  providers: [createManualProvider()],
});
```

## `gateway.run(input)`

Runs intake and returns a `GatewayRunResult`.

```ts
const result = await gateway.run({
  outputDir: "mmi-runs/run-001",
  sources: [{ type: "text", text: "Brief text" }],
});
```

Important fields:

- `result.packet`: the generic `CandidatePacket`.
- `result.issues`: non-empty means the packet needs attention.
- `result.filesWritten`: absolute paths written by the generic writer.

`CandidatePacket` includes both `schemaVersion` and `gatewayVersion` so
consumers can gate migrations explicitly.

The writer emits `gateway_manifest.json`, `packet.json`, `sources.json`,
`evidence_atoms.jsonl`, `claims.jsonl`, `review_items.jsonl`,
`source_matrix.json`, `issues.json`, `agent_handoff.md`, and `README.md`.
Agents should read `gateway_manifest.json` first.

## Project Folder Intake Helpers

```ts
import { discoverProjectSources, writeProjectIntakeArtifacts } from "@mmi/gateway";

const discovery = await discoverProjectSources("./project");

await writeProjectIntakeArtifacts(discovery, {
  outputDir: "./project/.mmi",
  profile: "creative-project",
});
```

These helpers power `mmi ingest-project`. They are local-first and file-based:
they can call local `ffprobe`/`ffmpeg` when available, but they do not upload
local private media or promote project truth.

`discoverProjectSources()` classifies local files with `originKind`,
`assetRole`, and `assetRoleReason` metadata. Project intake artifacts use those
fields to place raw captures and original media ahead of derived frames,
generated artifacts, and project-note sidecars.

## Project Review Decisions

```ts
import { applyReviewDecisions, summarizeReviewQueue } from "@mmi/gateway";

const queue = await summarizeReviewQueue("./project/.mmi");
const summary = await applyReviewDecisions("./project/.mmi", "./project/.mmi/review_decisions.template.jsonl");
```

The review decision helper writes summaries such as `accepted_atoms.jsonl` and
`review_decision_summary.json` without mutating `packet.json`.

## Project Perception Helper

```ts
import { runProjectPerception } from "@mmi/gateway";

const result = await runProjectPerception("./project/.mmi", {
  asr: true,
  targetTypes: ["video_window"],
  urlMapPath: "./urls.jsonl",
});
```

This helper powers `mmi perceive`. It consumes an existing `ingest-project`
directory and writes sidecar files under `.mmi/perception/`. The default mode is
agent-first: it creates `agent_review_targets.jsonl` and
`transcript_sidecars.jsonl` for a receiving agent that can inspect local media
itself. It does not call a visual provider unless `visualProvider` is set.

Set `asr: true` to submit DashScope Paraformer tasks for reviewed HTTP(S) or
OSS URLs. Direct local audio/video paths are reported in
`perception_blockers.json` with recovery instructions instead of being silently
uploaded.

Set `visualProvider: "dashscope"` only when a provider visual pass is useful.
Provider observations, perceived atoms, and their review queue stay in
`.mmi/perception/` and do not mutate the canonical `packet.json`.

## CLI JSON Contract

All `--json` CLI responses include:

- `schema`: `mmi.gateway.cli_result`
- `schemaVersion`
- `gatewayVersion`
- `ok`
- `command`
- `data`
- `nextCommands`

Issue arrays include `severity` and `recovery` fields so another agent can fix
common failures without scraping human text.

Use `@mmi/gateway/cli-result.schema.json` for external validation.

## `ProviderAdapter`

```ts
type ProviderAdapter = {
  apiVersion: 1;
  id: string;
  displayName: string;
  capabilities: ProviderCapability;
  inspect(source: NormalizedSource, context: ProviderContext): Promise<ProviderObservation>;
  healthCheck?(context): Promise<ProviderHealth> | ProviderHealth;
  dispose?(): Promise<void> | void;
};
```

Providers must return candidate observations only. The core performs schema and
safety checks after provider output.

CLI config can load provider modules with `providers[].type = "module"`.
Programmatic callers can use `gatewayConfigFromFileAsync(config, { baseDir })`
or pass providers directly to `createGateway`.

## Downstream Integrations

Use `gateway_manifest.json` as the stable entrypoint for downstream tools.
Integrations should read the canonical packet directory and preserve the
candidate-only safety invariants.

## Storage Adapter Helpers

```ts
import { createGateway, createMockProvider, createSignedUrlStoragePlugin } from "@mmi/gateway";

const gateway = createGateway({
  defaultProvider: "mock",
  providers: [createMockProvider()],
  plugins: [
    createSignedUrlStoragePlugin({
      id: "project-storage",
      async createSignedUrl(source) {
        return { signedUrl: `https://storage.example/${source.id}?sig=reviewed` };
      },
    }),
  ],
});
```

This helper rewrites local private image/audio/video sources to reviewed signed
URLs before provider dispatch. It does not upload anything by itself.

For persisted packet output, prefer `createSignedUrlStorageBoundaryPlugins()`.
It gives the provider a signed URL during dispatch, then redacts that signed URL
from `packet.json` and `evidence_atoms.jsonl`. Signed URL metadata is also
excluded from the packet unless you explicitly opt in:

```ts
import { createGateway, createMockProvider, createSignedUrlStorageBoundaryPlugins } from "@mmi/gateway";

const gateway = createGateway({
  defaultProvider: "mock",
  providers: [createMockProvider()],
  plugins: createSignedUrlStorageBoundaryPlugins({
    id: "project-storage",
    async createSignedUrl(source) {
      return { signedUrl: `https://storage.example/${source.id}?sig=reviewed` };
    },
  }),
});
```
