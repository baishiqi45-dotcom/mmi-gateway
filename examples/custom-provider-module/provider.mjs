export default function createProvider(options = {}) {
  const id = options.id ?? "example-module";
  return {
    apiVersion: 1,
    id,
    displayName: "Example Module Provider",
    capabilities: {
      sourceTypes: ["text"],
      acceptsLocalFiles: false,
      acceptsRemoteUrls: true,
      acceptsDataUrls: false
    },
    healthCheck() {
      return {
        providerId: id,
        status: "ok",
        message: "Module loaded. No external API was called."
      };
    },
    async inspect(source) {
      return {
        sourceId: source.id,
        providerId: id,
        content: `Candidate observation for ${source.id}. Human review required.`,
        confidence: 0.5,
        confidenceBasis: "Example module provider. Not validation."
      };
    }
  };
}
