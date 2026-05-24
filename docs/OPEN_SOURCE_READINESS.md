# Open Source Readiness

This package is structured so it can become a standalone open-source project.

## Ready

- Standalone TypeScript package boundary at the repository root.
- MIT license.
- CLI with `init`, `init --starter`, `doctor`, `providers`, `ingest`, and `validate`.
- CLI recipe discovery with `mmi recipes --json`.
- Agent-readable `--json`, `nextCommands`, `--sources-json`, `--sources` JSONL,
  `--stdin-json`, `--stdin-jsonl`, `handoff`, and `explain` surfaces.
- SDK entry points with typed providers and stable packet readers/writers.
- Versioned JSON Schema at `schemas/v1/candidate-packet.schema.json`.
- Source manifest JSON Schema for upstream systems.
- Provider V1 contract with explicit `apiVersion`.
- Build, typecheck, and Vitest scripts.
- Safety defaults for review-required candidate packets, including fail-closed packet writes for secret-like output.

## Still Intentional Boundaries

- Local private media upload is blocked until a reviewed storage adapter creates a signed URL.
- ASR/transcription pipelines are provider or storage extensions, not core.
- Provider observations are candidate perceptions, not validation.
- Project-specific adapters should live outside the core package.

## Release Checklist

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Run `node dist/cli.js init --starter --config /tmp/mmi-starter/mmi.config.json --json`.
- Run `node dist/cli.js ingest --text "release smoke" --out /tmp/mmi-release-smoke --json`.
- Run `node dist/cli.js validate /tmp/mmi-release-smoke --json`.
- Run `node dist/cli.js handoff /tmp/mmi-release-smoke --json`.
- Run `node dist/cli.js recipes --json`.
- Run `npm pack --dry-run`.
- Install the packed tarball in a temporary project and run `npx mmi doctor`, `npx mmi ingest`, and `npx mmi validate`.
- Smoke the custom provider module example from the packed package.
- Review `SECURITY.md` before enabling any provider that touches private media.
