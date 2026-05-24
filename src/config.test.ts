import { describe, expect, it } from "vitest";
import { MmiGatewayError } from "./errors.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig, providersFromConfig, providersFromConfigAsync } from "./config.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mmi-config-"));
}

describe("mmi config", () => {
  it("rejects unknown top-level config fields", () => {
    expect(() => parseConfig({ defaultProvider: "manual", typo: true })).toThrow(MmiGatewayError);
  });

  it("rejects malformed openai-compatible provider config", () => {
    expect(() =>
      parseConfig({
        providers: [{ type: "openai-compatible", id: "llm", apiKeyEnv: "LLM_KEY" }],
      }),
    ).toThrow(MmiGatewayError);
  });

  it("loads an explicit module provider through the async config path", async () => {
    const root = await tmpDir();
    const providerPath = path.join(root, "provider.mjs");
    await fs.writeFile(
      providerPath,
      `
export default function createProvider(options) {
  return {
    apiVersion: 1,
    id: options.id,
    displayName: "Loaded module provider",
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
        content: "Module provider observation.",
        confidence: 0.5,
        confidenceBasis: "Test module provider."
      };
    }
  };
}
`,
      "utf8",
    );

    const providers = await providersFromConfigAsync(
      {
        providers: [{ type: "module", id: "module-test", module: "./provider.mjs", options: { id: "module-test" } }],
      },
      { baseDir: root },
    );

    expect(providers[0]).toMatchObject({
      apiVersion: 1,
      id: "module-test",
      displayName: "Loaded module provider",
    });
  });

  it("keeps sync config loading strict for module providers", () => {
    expect(() =>
      providersFromConfig({
        providers: [{ type: "module", id: "custom", module: "./provider.mjs" }],
      }),
    ).toThrow(MmiGatewayError);
  });

  it("keeps a custom DashScope apiKeyEnv on the provider adapter", async () => {
    const previous = process.env.MY_DASHSCOPE_KEY;
    process.env.MY_DASHSCOPE_KEY = "";
    const provider = providersFromConfig({
      providers: [{ type: "dashscope", apiKeyEnv: "MY_DASHSCOPE_KEY" }],
    }).find((item) => item.id === "dashscope");

    await expect(
      provider?.inspect(
        {
          id: "src_text_001",
          type: "text",
          uri: "manual://src_text_001",
          text: "hello",
          provider: "dashscope",
          privacy: "synthetic",
          rights: "not_reviewed",
          metadata: {},
        },
        {
          runId: "run_test",
          createdAt: "2026-05-24T00:00:00.000Z",
          prompt: "test",
        },
      ),
    ).rejects.toThrow("MY_DASHSCOPE_KEY");
    if (previous === undefined) delete process.env.MY_DASHSCOPE_KEY;
    else process.env.MY_DASHSCOPE_KEY = previous;
  });
});
