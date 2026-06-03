import { createGateway, createMockProvider, createSignedUrlStorageBoundaryPlugins } from "mmi-gateway";

const gateway = createGateway({
  defaultProvider: "mock",
  providers: [createMockProvider()],
  plugins: createSignedUrlStorageBoundaryPlugins({
    id: "example-storage",
    createSignedUrl(source) {
      return {
        signedUrl: `https://storage.example.test/${source.id}.mp4?sig=reviewed-transient-token`,
        expiresAt: "2026-05-25T00:00:00.000Z",
      };
    },
  }),
});

async function main(): Promise<void> {
  const result = await gateway.run({
    write: false,
    sources: [{ type: "video", uri: "/private/project/raw.mov", provider: "mock" }],
  });

  console.log(result.packet.sources[0]?.uri);
  console.log(result.packet.evidenceAtoms[0]?.providerId);
}

void main();
