import { MMI_PROVIDER_API_VERSION, type NormalizedSource, type ProviderAdapter, type ProviderObservation } from "../types.ts";

function pointerDescription(source: NormalizedSource): string {
  if (source.text?.trim()) return source.text.trim();
  return `Source '${source.id}' was registered as ${source.type}. No external provider perception was run.`;
}

export function createManualProvider(id = "manual"): ProviderAdapter {
  return {
    apiVersion: MMI_PROVIDER_API_VERSION,
    id,
    displayName: "Manual / pointer-only",
    capabilities: {
      sourceTypes: ["text", "document", "web", "image", "audio", "video", "folder", "other"],
      acceptsLocalFiles: true,
      acceptsRemoteUrls: true,
      acceptsDataUrls: false,
      streaming: false,
    },
    healthCheck() {
      return {
        providerId: id,
        status: "ok",
        message: "Manual provider is local and requires no external credentials.",
      };
    },
    async inspect(source: NormalizedSource): Promise<ProviderObservation> {
      return {
        sourceId: source.id,
        providerId: id,
        content: pointerDescription(source).slice(0, 8000),
        confidence: source.text?.trim() ? 0.65 : 0.2,
        confidenceBasis: source.text?.trim()
          ? "Manual text input was captured locally; source truth still requires review."
          : "Pointer-only registration; no provider perception was run.",
        warnings: ["candidate_only", "review_required"],
      };
    },
  };
}

export const manualProvider = createManualProvider();
