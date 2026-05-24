# Configuration

Create `mmi.config.json` with `mmi init` or by hand.

Starter profiles:

```bash
npx @mmi/gateway init --profile agent --config ./mmi.config.json
npx @mmi/gateway init --profile dashscope --config ./mmi.config.json
npx @mmi/gateway init --profile openai-compatible --config ./mmi.config.json
```

```json
{
  "projectId": "my-project",
  "defaultProvider": "manual",
  "prompt": "Return a concise candidate evidence description. Do not validate the source as fact.",
  "policy": {
    "allowLocalMediaUpload": false,
    "allowLocalTextUpload": false,
    "allowDataUrls": false,
    "requireReview": true,
    "failOnProviderError": false,
    "failOnUnsafeOutput": true
  },
  "providers": [
    { "type": "manual" },
    { "type": "mock" },
    {
      "type": "dashscope",
      "apiKeyEnv": "DASHSCOPE_API_KEY",
      "model": "qwen3.5-omni-plus"
    }
  ]
}
```

## Fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `projectId` | string | omitted | Optional project identifier copied into packets. |
| `defaultProvider` | string | `manual` | Provider used when a source does not specify one. |
| `prompt` | string | built-in candidate prompt | Provider inspection prompt. |
| `policy.allowLocalMediaUpload` | boolean | `false` | Keep false unless a storage adapter creates signed URLs. |
| `policy.allowLocalTextUpload` | boolean | `false` | Keep false unless local private text/document content is reviewed for provider dispatch. |
| `policy.allowDataUrls` | boolean | `false` | Enable only for explicit trusted data URLs. |
| `policy.requireReview` | boolean | `true` | Packets remain review-required. |
| `policy.maxSourceBytes` | number | none | Maximum UTF-8 source text or CLI-read local file size before an issue is emitted. |
| `policy.failOnProviderError` | boolean | `false` | When false, provider failures become issues and manual pointer evidence is kept. |
| `policy.failOnUnsafeOutput` | boolean | `true` | When true, secret-like or schema-invalid packets produce `run_error.json` instead of `packet.json`. |
| `providers[].type` | string | `manual`, `mock` | `manual`, `mock`, `dashscope`, `openai-compatible`, or `module`. |
| `providers[].id` | string | provider default | Optional custom provider id for manual/mock/openai-compatible. |
| `providers[].apiKeyEnv` | string | provider-specific | Name of the environment variable, not the key value. |
| `providers[].model` | string | provider-specific | Model name for provider calls. |
| `providers[].baseUrl` | URL | provider-specific | OpenAI-compatible endpoint. |
| `providers[].module` | string | omitted | Explicit local/package module for custom provider adapters; CLI loads it through the async config path. |

## Secrets

Put secrets in environment variables, not in `mmi.config.json`.

```bash
export DASHSCOPE_API_KEY="..."
```

The CLI prints provider names and issue codes, but not API keys.

## Agent Inputs

Use `--sources-json` when another tool already has a source manifest:

```json
{
  "sources": [
    {
      "id": "brief",
      "type": "text",
      "text": "Project brief...",
      "privacy": "project_private",
      "rights": "not_reviewed",
      "metadata": { "system": "crm" }
    }
  ]
}
```

```bash
npx @mmi/gateway ingest --sources-json ./sources.json --out ./mmi-run --json
```

The CLI also accepts `--sources ./sources.jsonl`, `--stdin-json`, and
`--stdin-jsonl`. JSONL input uses one `SourceInput` object per line and is the
best fit for agent pipelines that already stream source records.

Print the machine-readable contract with:

```bash
npx @mmi/gateway schema --kind source-manifest
```

See `docs/SOURCE_MANIFEST_RECIPE.md` and `examples/source-manifest/` for object,
array, and JSONL fixtures.

## Custom Provider Module

For CLI-driven projects, a config can load an explicit provider module:

```json
{
  "defaultProvider": "local-provider",
  "providers": [
    { "type": "manual" },
    {
      "type": "module",
      "id": "local-provider",
      "module": "./providers/local-provider.mjs",
      "options": { "id": "local-provider" }
    }
  ]
}
```

The module must export a `ProviderAdapter` object or a factory returning one.
It must set `apiVersion: 1`; mismatched ids or versions fail during `doctor`.

```bash
npx @mmi/gateway doctor --config ./mmi.config.json --json
```
