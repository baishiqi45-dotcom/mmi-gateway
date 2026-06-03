import { createGateway, createManualProvider } from "mmi-gateway";

const gateway = createGateway({
  defaultProvider: "manual",
  providers: [createManualProvider()],
  projectId: "sdk-basic",
});

async function main(): Promise<void> {
  const result = await gateway.run({
    outputDir: "tmp/sdk-basic-run",
    sources: [
      {
        type: "text",
        text: "Example brief: create a source inventory before making downstream decisions.",
        privacy: "synthetic",
      },
    ],
  });

  console.log(result.packet.status);
}

void main();
