import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGateway } from "./core.ts";
import { createManualProvider, createMockProvider } from "./providers/index.ts";
import { createSignedUrlStorageBoundaryPlugins, createSignedUrlStoragePlugin } from "./storage.ts";
import { readPacket } from "./writer.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mmi-oss-"));
}

describe("mmi-gateway core", () => {
  it("creates a review-blocked candidate packet with manual provider", async () => {
    const gateway = createGateway({
      defaultProvider: "manual",
      providers: [createManualProvider()],
    });

    const result = await gateway.run({
      runId: "run_test_manual",
      createdAt: "2026-05-24T00:00:00.000Z",
      sources: [{ type: "text", text: "Project brief needs source matrix before creative work." }],
      write: false,
    });

    expect(result.issues).toEqual([]);
    expect(result.packet.status).toBe("candidate_review_required");
    expect(result.packet.review).toEqual({ required: true, verdict: null });
    expect(result.packet.sourceMatrix.bound).toBe(false);
    expect(result.packet.evidenceAtoms[0]).toMatchObject({
      providerId: "manual",
      reviewStatus: "needs_review",
    });
  });

  it("uses provider interface without project-specific coupling", async () => {
    const gateway = createGateway({
      defaultProvider: "mock",
      providers: [createManualProvider(), createMockProvider()],
    });

    const result = await gateway.run({
      sources: [{ type: "image", uri: "https://example.com/source.png", provider: "mock" }],
      write: false,
    });

    expect(result.issues).toEqual([]);
    expect(result.packet.evidenceAtoms[0]?.providerId).toBe("mock");
    expect(JSON.stringify(result.packet)).not.toContain("project-specific");
  });

  it("blocks local media upload by default", async () => {
    const gateway = createGateway({
      defaultProvider: "mock",
      providers: [createMockProvider()],
    });

    const result = await gateway.run({
      sources: [{ type: "video", uri: "/private/project/raw.mov", provider: "mock" }],
      write: false,
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "local_media_upload_blocked",
      }),
    ]);
    expect(result.packet.evidenceAtoms).toHaveLength(1);
    expect(result.packet.evidenceAtoms[0]).toMatchObject({
      providerId: "manual",
      reviewStatus: "needs_review",
    });
  });

  it("blocks local private text upload to external providers by default", async () => {
    const gateway = createGateway({
      defaultProvider: "mock",
      providers: [createManualProvider(), createMockProvider()],
    });

    const result = await gateway.run({
      sources: [
        {
          type: "document",
          uri: "/private/project/brief.txt",
          text: "Private file content.",
          provider: "mock",
          privacy: "project_private",
        },
      ],
      write: false,
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "local_text_upload_blocked",
      }),
    ]);
    expect(result.packet.evidenceAtoms[0]).toMatchObject({
      providerId: "manual",
      reviewStatus: "needs_review",
    });
  });

  it("turns plugin exceptions into sanitized gateway issues", async () => {
    const gateway = createGateway({
      defaultProvider: "manual",
      providers: [createManualProvider()],
      plugins: [
        {
          id: "boom",
          stage: "pre_ingest",
          run() {
            throw new Error("Authorization: plugin_secret_value_123456789");
          },
        },
      ],
    });

    const result = await gateway.run({
      sources: [{ type: "text", text: "Plugin error smoke." }],
      write: false,
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "plugin_error",
        pluginId: "boom",
        message: expect.stringContaining("<redacted>"),
      }),
    ]);
    expect(JSON.stringify(result.issues)).not.toContain("plugin_secret_value");
  });

  it("redacts provider error details before returning issues", async () => {
    const gateway = createGateway({
      defaultProvider: "leaky",
      providers: [
        createManualProvider(),
        {
          apiVersion: 1,
          id: "leaky",
          displayName: "Leaky provider",
          capabilities: {
            sourceTypes: ["text"],
            acceptsLocalFiles: false,
            acceptsRemoteUrls: true,
            acceptsDataUrls: false,
          },
          async inspect() {
            throw new Error("apiKey=provider_secret_value_123456789 failed");
          },
        },
      ],
    });

    const result = await gateway.run({
      sources: [{ type: "text", text: "Provider error smoke.", provider: "leaky" }],
      write: false,
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "provider_error",
        message: "apiKey=<redacted> failed",
      }),
    ]);
    expect(JSON.stringify(result.issues)).not.toContain("provider_secret_value");
  });

  it("rejects provider observations that do not match the dispatched source and provider", async () => {
    const gateway = createGateway({
      defaultProvider: "wrong-provider",
      providers: [
        createManualProvider(),
        {
          apiVersion: 1,
          id: "wrong-provider",
          displayName: "Wrong provider",
          capabilities: {
            sourceTypes: ["text"],
            acceptsLocalFiles: false,
            acceptsRemoteUrls: true,
            acceptsDataUrls: false,
          },
          async inspect() {
            return {
              sourceId: "other-source",
              providerId: "other-provider",
              content: "Wrong identity observation.",
              confidence: 0.5,
              confidenceBasis: "Intentional mismatch for contract test.",
            };
          },
        },
      ],
    });

    const result = await gateway.run({
      sources: [{ id: "real-source", type: "text", text: "Identity mismatch smoke.", provider: "wrong-provider" }],
      write: false,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "provider_contract_invalid",
          id: "real-source",
        }),
        expect.objectContaining({
          code: "provider_contract_invalid",
          providerId: "wrong-provider",
        }),
      ]),
    );
    expect(result.packet.evidenceAtoms).toHaveLength(0);
  });

  it("links source matrix rows by source id instead of array position", async () => {
    const gateway = createGateway({
      defaultProvider: "wrong-provider",
      providers: [
        createManualProvider(),
        {
          apiVersion: 1,
          id: "wrong-provider",
          displayName: "Wrong provider",
          capabilities: {
            sourceTypes: ["text"],
            acceptsLocalFiles: false,
            acceptsRemoteUrls: true,
            acceptsDataUrls: false,
          },
          async inspect() {
            return {
              sourceId: "not-the-source",
              providerId: "wrong-provider",
              content: "Wrong identity observation.",
              confidence: 0.5,
              confidenceBasis: "Intentional mismatch for matrix test.",
            };
          },
        },
      ],
    });

    const result = await gateway.run({
      sources: [
        { id: "bad-first", type: "text", text: "This provider response will be rejected.", provider: "wrong-provider" },
        { id: "good-second", type: "text", text: "Manual fallback source.", provider: "manual" },
      ],
      write: false,
    });

    expect(result.packet.evidenceAtoms).toHaveLength(1);
    expect(result.packet.evidenceAtoms[0]).toMatchObject({ sourceId: "good-second" });
    expect(result.packet.sourceMatrix.items[0]).toMatchObject({ sourceId: "bad-first", evidenceAtomIds: [], linkedClaimIds: [] });
    expect(result.packet.sourceMatrix.items[1]?.evidenceAtomIds).toEqual([result.packet.evidenceAtoms[0]?.id]);
  });

  it("writes a portable packet directory", async () => {
    const outputDir = await tmpDir();
    const gateway = createGateway({
      defaultProvider: "manual",
      providers: [createManualProvider()],
    });

    const result = await gateway.run({
      outputDir,
      sources: [{ type: "text", text: "Portable packet smoke." }],
    });

    expect(result.issues).toEqual([]);
    await expect(fs.stat(path.join(outputDir, "packet.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(outputDir, "gateway_manifest.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(outputDir, "agent_handoff.md"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(outputDir, "issues.json"))).resolves.toBeDefined();
    await expect(readPacket(outputDir)).resolves.toMatchObject({
      schema: "mmi.gateway.packet",
      status: "candidate_review_required",
    });
  });

  it("does not write packet output when unsafe secret-like fields are detected", async () => {
    const outputDir = await tmpDir();
    const gateway = createGateway({
      defaultProvider: "manual",
      providers: [createManualProvider()],
    });

    const result = await gateway.run({
      outputDir,
      sources: [
        {
          type: "text",
          text: "Secret metadata should block packet writes.",
          metadata: { apiKey: "test_secret_value_123456" },
        },
      ],
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "secret_leak_risk" }),
        expect.objectContaining({ code: "write_failed" }),
      ]),
    );
    await expect(fs.stat(path.join(outputDir, "packet.json"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "run_error.json"))).resolves.toBeDefined();
  });

  it("does not treat ordinary words containing sk- as API keys", async () => {
    const gateway = createGateway({
      defaultProvider: "manual",
      providers: [createManualProvider()],
    });

    const result = await gateway.run({
      sources: [{ type: "text", text: "Reference URL slug: ask-a-scientist-3" }],
      write: false,
    });

    expect(result.issues).toEqual([]);
    expect(result.packet.evidenceAtoms[0]?.content).toContain("ask-a-scientist-3");
  });

  it("lets a storage plugin convert local private media into a signed URL before provider dispatch", async () => {
    const gateway = createGateway({
      defaultProvider: "mock",
      providers: [createMockProvider()],
      plugins: [
        createSignedUrlStoragePlugin({
          id: "test-storage",
          createSignedUrl(source) {
            return {
              signedUrl: `https://storage.example.test/${source.id}.mp4?sig=test`,
              expiresAt: "2026-05-25T00:00:00.000Z",
            };
          },
        }),
      ],
    });

    const result = await gateway.run({
      sources: [{ type: "video", uri: "/private/project/raw.mov", provider: "mock" }],
      write: false,
    });

    expect(result.issues).toEqual([]);
    expect(result.packet.sources[0]).toMatchObject({
      uri: "https://storage.example.test/src_video_001.mp4?sig=test",
      privacy: "signed_url",
    });
    expect(result.packet.evidenceAtoms[0]?.providerId).toBe("mock");
  });

  it("can use signed URLs for provider dispatch without persisting them in the packet", async () => {
    const gateway = createGateway({
      defaultProvider: "mock",
      providers: [createMockProvider()],
      plugins: createSignedUrlStorageBoundaryPlugins({
        id: "safe-storage",
        createSignedUrl(source) {
          return {
            signedUrl: `https://storage.example.test/${source.id}.mp4?sig=secret-signature-value`,
            expiresAt: "2026-05-25T00:00:00.000Z",
          };
        },
      }),
    });

    const result = await gateway.run({
      sources: [{ type: "video", uri: "/private/project/raw.mov", provider: "mock" }],
      write: false,
    });

    expect(result.issues).toEqual([]);
    expect(result.packet.sources[0]).toMatchObject({
      uri: "signed-url://safe-storage/src_video_001",
      privacy: "signed_url",
      metadata: {
        storageAdapterId: "safe-storage",
        signedUrlRedactedFromPacket: true,
      },
    });
    expect(result.packet.evidenceAtoms[0]).toMatchObject({
      providerId: "mock",
      locator: { uri: "signed-url://safe-storage/src_video_001" },
    });
    expect(JSON.stringify(result.packet)).not.toContain("secret-signature-value");
  });
});
