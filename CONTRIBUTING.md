# Contributing

Thanks for helping improve MMI Gateway.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run selftest
npm pack --dry-run
```

## Adding A Provider

1. Implement `ProviderAdapter` with `apiVersion: 1`.
2. Add request-serialization tests for every supported modality.
3. Add error and empty-content tests.
4. Ensure no API keys, signed URLs, cookies, or raw provider responses are written into packets.
5. Document provider config in `CONFIGURATION.md`.
6. Keep CLI-facing config schema strict; typos should fail `doctor`, not silently fall through.

## Downstream Integrations

Downstream integrations should read the canonical packet directory and preserve
candidate-only semantics. They cannot mark source truth, project truth,
source-matrix binding, or production permission.

## Pull Requests

Include the commands you ran and note whether the change touches core,
providers, CLI, docs, schemas, or examples.
Run a packed-package consumer smoke when changing `package.json`, exports, the CLI bin, or examples.
