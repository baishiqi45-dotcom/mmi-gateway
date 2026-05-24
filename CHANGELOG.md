# Changelog

## 0.7.0

- Added `mmi asr fetch|poll` to retrieve DashScope Paraformer task results and write review-required transcript sidecars.
- Added `runAsrTaskFetch()` for SDK callers.
- Added ASR fetch manifests, raw task response storage, transcript download handling, and tests/docs for the submit-then-fetch workflow.
- Added HTTP(S)-only transcript downloads, transcript size limits, refreshed transcript indexes, atomic perception writes, and `.env.example`.

## 0.6.0

- Added `mmi perceive` as an agent-first perception bundle for project intake outputs.
- Added `.mmi/perception/agent_review_targets.jsonl`, transcript sidecar indexing, ASR task/blocker files, optional provider observations, and provider perception review queues.
- Added explicit DashScope Paraformer ASR submission for reviewed HTTP(S)/OSS URLs via `--asr` and `--url-map`.
- Added optional Qwen visual fallback with `--visual-provider dashscope`; visual provider calls are not made by default.
- Exported `runProjectPerception()` for SDK callers and added perception tests/docs.

## 0.5.0

- Added raw/derived/generated project source classification for local folder intake.
- Added raw-first visual prioritization so original captures outrank derived video frames and generated artifacts.
- Added `START_HERE.md`, `START_HERE.json`, `top_review_targets.jsonl`, and `review_decisions.template.jsonl` project intake outputs.
- Added `mmi review` to summarize review queues and apply filled review decision files without mutating `packet.json`.
- Changed project intake keyframe extraction to opt-in with `--extract-keyframes`.
- Hardened `ingest-project --json` error handling, dry-run replay options, preview truncation flags, and provider mode reporting.

## 0.4.0

- Added `mmi ingest-project <folder>` for local-first project folder intake.
- Added recursive source discovery with safe defaults for common media and document files.
- Added project review artifacts: visual asset library, contact sheet HTML, video window review matrix, project atoms, review queue, object/evidence ledger, term correction queue, project foundation candidate, and blocker report.
- Added graceful local video degradation when `ffprobe`/`ffmpeg` is missing or cannot read a file.
- Fixed source matrix row linking so rows map by `sourceId` instead of array position.

## 0.3.0

- Added recipe discovery with `mmi recipes --json`.
- Added source manifest, custom provider module, signed URL storage, and golden-path examples.
- Added provider observation identity checks before evidence atom creation.
- Added signed URL storage boundary plugins that redact signed URLs from persisted packets.
- Expanded agent, release, security, and open-source readiness docs.

## 0.2.0

- Added 12-point agent/CLI experience improvements.
- Added `mmi handoff`, `mmi explain`, `mmi selftest`, `mmi --version`, and starter init flow.
- Added JSONL source manifest input, CLI result schema, and source manifest schema.
- Added issue recovery metadata with `severity`, `recovery`, and `suggestedFix`.
- Added provider health checks and module provider loading contract.
- Added fail-closed validation support for `run_error.json`.
- Added default local private text/document provider-dispatch block.
- Added sanitized plugin/provider issue redaction before returning or writing errors.
- Added trusted-publishing release workflow scaffold.

## 0.1.0

- Initial open-source package foundation.
- Provider-neutral CLI and SDK.
- Candidate-only packet writer and validator.
- Manual, mock, DashScope, and OpenAI-compatible providers.
- Agent-readable JSON CLI output.
- Source manifest input.
- Fail-closed packet writes for secret-like output.
- ProviderAdapter V1 contract.
