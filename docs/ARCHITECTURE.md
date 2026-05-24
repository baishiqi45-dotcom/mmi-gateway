# Architecture

MMI Gateway is split into a provider-neutral core plus replaceable edges.

```text
SourceInput[]
  -> normalize sources
  -> optional pre-ingest plugins (for example reviewed signed URLs)
  -> provider registry
  -> ProviderAdapter.inspect()
  -> EvidenceAtom[]
  -> CandidatePacket
  -> file writer / downstream integration
```

Project-folder intake adds a thin local layer before the generic packet:

```text
project folder
  -> source discovery
  -> local image/video/text scaffolds
  -> source-linked project atoms
  -> review surface and blocker report
  -> generic candidate packet
```

This layer is intentionally file-based. It does not start a server, create a
truth database, or launch provider jobs.

## Core

The core owns source normalization, provider dispatch, packet assembly, schema
validation, safety invariants, and generic file output. It has no project-
specific ontology.

The public contract is the product surface: `ProviderAdapter` V1, the versioned
candidate packet schema, typed issue codes, and the CLI JSON output. The
pipeline behind that contract can evolve as long as those contracts remain
stable.

## Providers

Providers implement `ProviderAdapter`. They return one `ProviderObservation`
per source. The core converts that observation into an `EvidenceAtom` and keeps
all outputs `needs_review`.

Built-ins:

- `manual`: no external call, pointer-only or text capture.
- `mock`: deterministic tests and examples.
- `dashscope`: Alibaba DashScope/Qwen-Omni OpenAI-compatible calls.
- `openai-compatible`: generic `/chat/completions` adapter for compatible APIs.

## Downstream Integrations

Downstream integrations map the generic packet directory into local workflow
shapes. They should live outside this core package unless they are generic
enough for every consumer.

## Non-Goals

- It does not validate source truth.
- It does not create ProjectBase acceptance.
- It does not bind a source matrix.
- It does not upload local private media by default.
- It does not persist raw provider responses.
- It does not turn project-folder intake artifacts into project truth.

## Output Contract

Each successful write emits one canonical directory dialect:

- `gateway_manifest.json`
- `packet.json`
- `sources.json`
- `evidence_atoms.jsonl`
- `claims.jsonl`
- `review_items.jsonl`
- `source_matrix.json`
- `issues.json`
- `agent_handoff.md`
- `README.md`

Older alternate writer names are not part of the public contract.

`mmi ingest-project` additionally writes local project intake artifacts such as
`project_intake_manifest.json`, `visual_asset_library.json`,
`video_window_review_matrix.json`, `atoms.ndjson`,
`project_foundation_candidate.json`, `human_review_surface.md`, and
`gap_and_blocker_report.md`.
