import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider } from "./openai-compatible.ts";
import type { FetchLike, NormalizedSource } from "../types.ts";

const source: NormalizedSource = {
  id: "src_image_001",
  type: "image",
  uri: "https://example.com/source.png",
  provider: "openai-compatible",
  privacy: "public",
  rights: "not_reviewed",
  metadata: {},
};

describe("OpenAI-compatible provider", () => {
  it("serializes multimodal content through the provider interface", async () => {
    const fetchFn: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: Array<{ type?: string }> }>;
      };
      expect(body.messages?.[0]?.content?.[0]?.type).toBe("image_url");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            model: "test-model",
            choices: [{ message: { content: "Candidate image observation." } }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          }),
      };
    };
    const provider = createOpenAICompatibleProvider({
      id: "openai-compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "test-model",
    });

    const observation = await provider.inspect(source, {
      runId: "run",
      createdAt: "2026-05-24T00:00:00.000Z",
      prompt: "Describe source.",
      fetch: fetchFn,
    });

    expect(observation).toMatchObject({
      sourceId: "src_image_001",
      providerId: "openai-compatible",
      model: "test-model",
      content: "Candidate image observation.",
      usage: { totalTokens: 13 },
    });
  });

  it("normalizes provider errors without leaking keys", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai-compatible",
      apiKey: "secret-key",
      baseUrl: "https://example.com/v1",
      model: "test-model",
    });

    await expect(
      provider.inspect(source, {
        runId: "run",
        createdAt: "2026-05-24T00:00:00.000Z",
        prompt: "Describe source.",
        fetch: async () => ({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: "bad request" } }),
        }),
      }),
    ).rejects.toMatchObject({
      code: "provider_error",
      message: "bad request",
    });
  });
});
