# Changelog

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
