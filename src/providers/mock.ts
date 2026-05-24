import {
  MMI_PROVIDER_API_VERSION,
  type NormalizedSource,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderObservation,
} from "../types.ts";

export function createMockProvider(id = "mock"): ProviderAdapter {
  return {
    apiVersion: MMI_PROVIDER_API_VERSION,
    id,
    displayName: "Deterministic mock provider",
    capabilities: {
      sourceTypes: ["text", "document", "web", "image", "audio", "video"],
      acceptsLocalFiles: false,
      acceptsRemoteUrls: true,
      acceptsDataUrls: true,
    },
    healthCheck() {
      return {
        providerId: id,
        status: "ok",
        message: "Mock provider is deterministic and requires no external credentials.",
      };
    },
    async inspect(source: NormalizedSource, context: ProviderContext): Promise<ProviderObservation> {
      return {
        sourceId: source.id,
        providerId: id,
        model: "mock-model",
        content: `Mock candidate observation for ${source.type} source ${source.id}: ${source.text ?? source.uri}. Prompt: ${context.prompt}`,
        confidence: 0.4,
        confidenceBasis: "Deterministic test provider; useful for integration tests only.",
        warnings: ["mock_provider_not_real_perception"],
      };
    },
  };
}
