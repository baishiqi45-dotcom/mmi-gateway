# Provider Authoring

Providers turn a normalized source into one candidate observation. They do not write files, store secrets, or mark anything validated.

## Interface

```ts
import type { ProviderAdapter } from "mmi-gateway";

export const provider: ProviderAdapter = {
  apiVersion: 1,
  id: "example",
  displayName: "Example Provider",
  capabilities: {
    sourceTypes: ["text", "image"],
    acceptsLocalFiles: false,
    acceptsRemoteUrls: true,
    acceptsDataUrls: false
  },
  healthCheck() {
    return {
      providerId: "example",
      status: "ok",
      message: "Local config is present. No external API was called."
    };
  },
  async inspect(source, context) {
    return {
      sourceId: source.id,
      providerId: "example",
      model: "example-model",
      content: "Candidate description only.",
      confidence: 0.5,
      confidenceBasis: "Provider observation; human review required.",
      usage: { totalTokens: 10 }
    };
  }
};
```

## Rules

- Set `apiVersion: 1`. Breaking provider contracts will use a new interface name instead of silently changing V1.
- Return candidate descriptions only.
- Do not return raw provider responses.
- Do not include API keys, Authorization headers, cookies, signed upload headers, or private file contents in errors.
- If an error still contains credential-like text, MMI redacts it before writing issues, but providers should avoid producing it.
- Throw normal errors for provider failures; the gateway records issue codes.
- Respect `context.signal` for cancellation when possible.
- Declare modality support accurately in `capabilities`.
- Keep local private text/document upload disabled unless policy explicitly allows it.
- Keep local media upload disabled unless a storage adapter has created a reviewed signed URL.

## CLI Module Loading

SDK users can pass providers directly to `createGateway`. CLI users can load a
provider module from `mmi.config.json`:

```json
{
  "providers": [
    {
      "type": "module",
      "id": "example",
      "module": "./providers/example-provider.mjs",
      "options": { "id": "example" }
    }
  ]
}
```

The module export can be either a `ProviderAdapter` or a factory:

```js
export default function createProvider(options) {
  return {
    apiVersion: 1,
    id: options.id,
    displayName: "Example Provider",
    capabilities: {
      sourceTypes: ["text"],
      acceptsLocalFiles: false,
      acceptsRemoteUrls: true,
      acceptsDataUrls: false
    },
    async inspect(source) {
      return {
        sourceId: source.id,
        providerId: options.id,
        content: "Candidate description only.",
        confidence: 0.5,
        confidenceBasis: "Module provider output; review required."
      };
    }
  };
}
```

See `examples/custom-provider-module/` for a runnable config, provider module,
and source manifest.

## Test Matrix

Every provider should have tests for:

- success with one supported source type
- unsupported source type
- empty content
- provider HTTP or SDK error
- secret redaction
- `healthCheck()` result for `mmi doctor --json`
- CLI module loading through `providersFromConfigAsync`
- request serialization for each supported modality
