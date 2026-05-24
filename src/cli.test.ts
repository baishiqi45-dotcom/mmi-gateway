import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mmi-cli-"));
}

async function writeFixtureProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "photos"), { recursive: true });
  await fs.mkdir(path.join(root, "00_PROJECT_FOUNDATION_2026-05-23", "FIELD_VIDEO_INTAKE", "frames", "A"), { recursive: true });
  await fs.mkdir(path.join(root, "video"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "brief.md"), "# Specimen Studio\n\nProject note for local intake.\n", "utf8");
  await fs.writeFile(
    path.join(root, "photos", "specimen-table.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await fs.writeFile(
    path.join(root, "00_PROJECT_FOUNDATION_2026-05-23", "FIELD_VIDEO_INTAKE", "frames", "A", "A_t000000.jpg"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await fs.writeFile(path.join(root, "video", "walkthrough.mp4"), Buffer.from("not a real video"));
  await fs.writeFile(path.join(root, ".git", "ignored.md"), "ignored", "utf8");
}

describe("mmi CLI", () => {
  it("prints doctor output with default providers", async () => {
    const result = await runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("MMI_DOCTOR_OK");
    expect(result.stdout.join("\n")).toContain("manual");
  });

  it("prints a package version that issue reporters can paste", async () => {
    const result = await runCli(["--version", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as { schema: string; name: string; version: string; data: { version: string } };
    expect(parsed).toMatchObject({
      schema: "mmi.gateway.cli_result",
      name: "@mmi/gateway",
    });
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.data.version).toBe(parsed.version);
  });

  it("creates a runnable starter project", async () => {
    const outputDir = await tmpDir();
    const configPath = path.join(outputDir, "starter", "mmi.config.json");
    const init = await runCli(["init", "--starter", "--config", configPath, "--json"]);

    expect(init.exitCode).toBe(0);
    const parsed = JSON.parse(init.stdout.join("\n")) as { starter: { samplePath: string }; nextCommands: string[] };
    expect(parsed.nextCommands[0]).toContain("mmi ingest");
    await expect(fs.stat(configPath)).resolves.toBeDefined();
    await expect(fs.stat(parsed.starter.samplePath)).resolves.toBeDefined();

    const ingest = await runCli(["ingest", "--config", configPath, "--out", path.join(outputDir, "starter", "run"), "--file", parsed.starter.samplePath, "--json"]);
    expect(ingest.exitCode).toBe(0);
    await expect(fs.stat(path.join(outputDir, "starter", "run", "packet.json"))).resolves.toBeDefined();
  });

  it("ingests text into a portable packet", async () => {
    const outputDir = await tmpDir();
    const result = await runCli(["ingest", "--out", outputDir, "--text", "hello intake"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("MMI_INGEST_HELD");
    await expect(fs.stat(path.join(outputDir, "packet.json"))).resolves.toBeDefined();
  });

  it("prints machine-readable ingest results with --json", async () => {
    const outputDir = await tmpDir();
    const result = await runCli(["ingest", "--json", "--out", outputDir, "--text", "hello json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      ok: boolean;
      schema: string;
      data: { ok: boolean };
      nextCommands: string[];
      manifestPath: string;
      agentHandoffPath: string;
    };
    expect(parsed).toMatchObject({
      schema: "mmi.gateway.cli_result",
      ok: true,
      data: { ok: true },
      manifestPath: path.join(outputDir, "gateway_manifest.json"),
      agentHandoffPath: path.join(outputDir, "agent_handoff.md"),
    });
    expect(parsed.nextCommands).toEqual(expect.arrayContaining([`mmi validate ${outputDir} --json`]));
  });

  it("runs a local no-network selftest", async () => {
    const result = await runCli(["selftest", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as { ok: boolean; checks: Array<{ id: string; ok: boolean }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ingest_json", ok: true }),
        expect.objectContaining({ id: "project_folder_intake", ok: true }),
        expect.objectContaining({ id: "secret_fail_closed", ok: true }),
      ]),
    );
  });

  it("publishes small integration recipes for downstream agents", async () => {
    const result = await runCli(["recipes", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      schema: string;
      command: string;
      recipes: Array<{ id: string; commands: string[] }>;
      nextCommands: string[];
    };
    expect(parsed).toMatchObject({
      schema: "mmi.gateway.cli_result",
      command: "recipes",
    });
    expect(parsed.recipes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "manual-first-run" }),
        expect.objectContaining({ id: "agent-jsonl-intake" }),
        expect.objectContaining({ id: "custom-provider-module" }),
      ]),
    );
  });

  it("keeps the documented agent JSON flow stable", async () => {
    const outputDir = await tmpDir();
    const runDir = path.join(outputDir, "agent-run");
    const sourcePath = path.join(outputDir, "sources.jsonl");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({ id: "agent_brief", type: "text", text: "Agent flow source.", privacy: "synthetic" }) + "\n",
      "utf8",
    );

    const commands = [
      await runCli(["doctor", "--json"]),
      await runCli(["selftest", "--json"]),
      await runCli(["ingest", "--sources", sourcePath, "--out", runDir, "--dry-run", "--json"]),
      await runCli(["ingest", "--sources", sourcePath, "--out", runDir, "--json"]),
      await runCli(["validate", runDir, "--json"]),
      await runCli(["handoff", runDir, "--json"]),
    ];

    for (const result of commands) {
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.join("\n")) as {
        schema: string;
        gatewayVersion: string;
        ok: boolean;
        nextCommands: string[];
      };
      expect(parsed.schema).toBe("mmi.gateway.cli_result");
      expect(parsed.gatewayVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.nextCommands)).toBe(true);
    }
    await expect(fs.stat(path.join(runDir, "gateway_manifest.json"))).resolves.toBeDefined();
  });

  it("ingests a source manifest without losing source metadata", async () => {
    const outputDir = await tmpDir();
    const sourceFile = path.join(outputDir, "sources.json");
    await fs.writeFile(
      sourceFile,
      JSON.stringify({
        sources: [
          {
            id: "customer_brief",
            type: "text",
            text: "Manifest source.",
            rights: "restricted",
            privacy: "project_private",
            metadata: { sourceSystem: "crm" },
          },
        ],
      }),
      "utf8",
    );

    const result = await runCli(["ingest", "--out", outputDir, "--sources-json", sourceFile]);

    expect(result.exitCode).toBe(0);
    const packet = JSON.parse(await fs.readFile(path.join(outputDir, "packet.json"), "utf8")) as {
      sources: Array<{ id: string; metadata: Record<string, unknown>; rights: string }>;
    };
    expect(packet.sources[0]).toMatchObject({
      id: "customer_brief",
      rights: "restricted",
      metadata: { sourceSystem: "crm" },
    });
  });

  it("ingests a JSONL source manifest for streaming agents", async () => {
    const outputDir = await tmpDir();
    const sourceFile = path.join(outputDir, "sources.jsonl");
    await fs.writeFile(
      sourceFile,
      [
        JSON.stringify({ id: "first", type: "text", text: "First JSONL source.", privacy: "synthetic" }),
        JSON.stringify({ id: "second", type: "text", text: "Second JSONL source.", rights: "restricted" }),
      ].join("\n"),
      "utf8",
    );

    const result = await runCli(["ingest", "--out", outputDir, "--sources", sourceFile, "--json"]);

    expect(result.exitCode).toBe(0);
    const packet = JSON.parse(await fs.readFile(path.join(outputDir, "packet.json"), "utf8")) as {
      sources: Array<{ id: string; rights: string }>;
    };
    expect(packet.sources.map((source) => source.id)).toEqual(["first", "second"]);
    expect(packet.sources[1]?.rights).toBe("restricted");
  });

  it("keeps PDF files pointer-only instead of reading them as UTF-8 text", async () => {
    const outputDir = await tmpDir();
    const pdfPath = path.join(outputDir, "brief.pdf");
    await fs.writeFile(pdfPath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));

    const result = await runCli(["ingest", "--out", outputDir, "--file", pdfPath]);

    expect(result.exitCode).toBe(0);
    const packet = JSON.parse(await fs.readFile(path.join(outputDir, "packet.json"), "utf8")) as {
      sources: Array<{ type: string; text?: string }>;
    };
    expect(packet.sources[0]).toMatchObject({ type: "document" });
    expect(packet.sources[0]?.text).toBeUndefined();
  });

  it("reports config and preflight issues through stable JSON", async () => {
    const outputDir = await tmpDir();
    const configPath = path.join(outputDir, "mmi.config.json");
    const sourcePath = path.join(outputDir, "brief.txt");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        defaultProvider: "manual",
        policy: { maxSourceBytes: 2 },
        providers: [{ type: "manual" }],
      }),
      "utf8",
    );
    await fs.writeFile(sourcePath, "larger than two bytes", "utf8");

    const result = await runCli(["ingest", "--json", "--config", configPath, "--out", outputDir, "--file", sourcePath]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.join("\n")) as { ok: boolean; issues: Array<{ code: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toEqual([expect.objectContaining({ code: "source_too_large" })]);
  });

  it("validates a written packet", async () => {
    const outputDir = await tmpDir();
    await runCli(["ingest", "--out", outputDir, "--text", "hello intake"]);

    const result = await runCli(["validate", outputDir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MMI_VALIDATE_HELD");
  });

  it("prints the versioned candidate packet schema", async () => {
    const result = await runCli(["schema", "--kind", "candidate-packet"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("mmi.gateway.packet");
    expect(result.stdout.join("\n")).toContain("not_source_truth");
  });

  it("prints the versioned source manifest schema", async () => {
    const result = await runCli(["schema", "--kind", "source-manifest"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("mmi.gateway.source_manifest");
    expect(result.stdout.join("\n")).toContain("sources");
  });

  it("prints the source manifest schema", async () => {
    const result = await runCli(["schema", "source-manifest"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("source-manifest.schema.json");
    expect(result.stdout.join("\n")).toContain("sources");
  });

  it("explains issue recovery without needing a provider", async () => {
    const result = await runCli(["explain", "secret_leak_risk", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as { code: string; recovery: string; severity: string };
    expect(parsed).toMatchObject({
      code: "secret_leak_risk",
      severity: "error",
    });
    expect(parsed.recovery).toContain("Remove secrets");
  });

  it("emits a provider-free dry-run plan", async () => {
    const outputDir = await tmpDir();
    const configPath = path.join(outputDir, "mmi.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        defaultProvider: "openai-compatible",
        providers: [
          {
            type: "openai-compatible",
            id: "openai-compatible",
            apiKeyEnv: "MISSING_COMPAT_KEY",
            model: "demo-model",
            baseUrl: "https://provider.example/v1",
          },
        ],
      }),
      "utf8",
    );

    const result = await runCli(["ingest", "--dry-run", "--json", "--config", configPath, "--out", outputDir, "--text", "plan only"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as { mode: string; wouldCallProviders: boolean; selectedProvider: string };
    expect(parsed).toMatchObject({
      mode: "dry-run-plan",
      wouldCallProviders: false,
      selectedProvider: "openai-compatible",
    });
  });

  it("discovers a mixed project folder without a hand-built source manifest", async () => {
    const projectRoot = await tmpDir();
    await writeFixtureProject(projectRoot);

    const result = await runCli(["ingest-project", projectRoot, "--dry-run", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      command: string;
      mode: string;
      counts: { sources: number; image: number; video: number; document: number };
      sources: Array<{ relativePath: string; type: string; assetRole?: string }>;
      skipped: Array<{ path: string; reason: string }>;
    };
    expect(parsed).toMatchObject({
      command: "ingest-project",
      mode: "dry-run-plan",
      counts: { sources: 4, image: 2, video: 1, document: 1 },
    });
    expect(parsed.sources).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: "brief.md", assetRole: "project_note" })]));
    expect(parsed.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: ".git", reason: "ignored_dir" })]));
  });

  it("fails missing project folders with stable JSON and no output directory", async () => {
    const root = await tmpDir();
    const missing = path.join(root, "missing");
    const outputDir = path.join(root, "out");

    const result = await runCli(["ingest-project", missing, "--out", outputDir, "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([]);
    const parsed = JSON.parse(result.stdout.join("\n")) as { ok: boolean; issues: Array<{ code: string; path: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toEqual([expect.objectContaining({ code: "invalid_source", path: missing })]);
    await expect(fs.stat(outputDir)).rejects.toThrow();
  });

  it("keeps dry-run replay options and marks truncated previews", async () => {
    const projectRoot = await tmpDir();
    await writeFixtureProject(projectRoot);

    const result = await runCli(["ingest-project", projectRoot, "--dry-run", "--exclude", "video", "--max-files", "3", "--preview-sources", "1", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      replayArgs: string[];
      sourcesTruncated: boolean;
      limits: { previewItems: number };
      nextActions: Array<{ command: string }>;
    };
    expect(parsed.replayArgs).toEqual(expect.arrayContaining(["--exclude", "video", "--max-files", "3"]));
    expect(parsed.sourcesTruncated).toBe(true);
    expect(parsed.limits.previewItems).toBe(1);
    expect(parsed.nextActions[0]?.command).toContain("--exclude video");
    expect(parsed.nextActions[0]?.command).toContain("--max-files 3");
  });

  it("writes project intake artifacts that are useful before provider perception", async () => {
    const projectRoot = await tmpDir();
    await writeFixtureProject(projectRoot);
    const outputDir = path.join(projectRoot, ".mmi");

    const result = await runCli(["ingest-project", projectRoot, "--out", outputDir, "--no-keyframes", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      ok: boolean;
      projectManifestPath: string;
      humanReviewSurfacePath: string;
      blockerReportPath: string;
      filesWritten: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.filesWritten).toEqual(
      expect.arrayContaining([
        path.join(outputDir, "project_intake_manifest.json"),
        path.join(outputDir, "START_HERE.md"),
        path.join(outputDir, "START_HERE.json"),
        path.join(outputDir, "visual_asset_library.json"),
        path.join(outputDir, "video_window_review_matrix.json"),
        path.join(outputDir, "top_review_targets.jsonl"),
        path.join(outputDir, "atoms.ndjson"),
        path.join(outputDir, "review_decisions.template.jsonl"),
        path.join(outputDir, "human_review_surface.md"),
        path.join(outputDir, "project_foundation_candidate.json"),
      ]),
    );
    await expect(fs.stat(path.join(outputDir, "keyframes"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "packet.json"))).resolves.toBeDefined();
    const manifest = JSON.parse(await fs.readFile(parsed.projectManifestPath, "utf8")) as {
      status: string;
      boundary: { providerUpload: string; noTruthPromotion: boolean };
      entrypoints: { humanReviewSurface: string; topReviewTargets: string; reviewDecisionTemplate: string };
      counts: { raw_capture: number; derived_frame: number };
    };
    expect(manifest).toMatchObject({
      status: "candidate_review_required",
      boundary: { providerUpload: "blocked_by_default", noTruthPromotion: true },
      entrypoints: { humanReviewSurface: "human_review_surface.md", topReviewTargets: "top_review_targets.jsonl", reviewDecisionTemplate: "review_decisions.template.jsonl" },
    });
    expect(manifest.counts.raw_capture).toBe(1);
    expect(manifest.counts.derived_frame).toBe(1);
    const visualLibrary = JSON.parse(await fs.readFile(path.join(outputDir, "visual_asset_library.json"), "utf8")) as {
      assets: Array<{ relativePath: string; assetRole: string; priorityRank: number }>;
    };
    expect(visualLibrary.assets[0]).toMatchObject({ relativePath: "photos/specimen-table.png", assetRole: "raw_capture", priorityRank: 1 });
    const reviewSurface = await fs.readFile(parsed.humanReviewSurfacePath, "utf8");
    expect(reviewSurface).toContain("First Visual Review");
    expect(reviewSurface).toContain("First Video Window Review");
    expect(reviewSurface.indexOf("photos/specimen-table.png")).toBeLessThan(reviewSurface.indexOf("A_t000000.jpg"));
    const gatewayManifest = JSON.parse(await fs.readFile(path.join(outputDir, "gateway_manifest.json"), "utf8")) as {
      files: { projectStartHere: string; topReviewTargets: string };
    };
    expect(gatewayManifest.files).toMatchObject({ projectStartHere: "START_HERE.md", topReviewTargets: "top_review_targets.jsonl" });
    const blockerReport = await fs.readFile(parsed.blockerReportPath, "utf8");
    expect(blockerReport).toContain("Local private media was not uploaded automatically");
  });

  it("summarizes project review decisions without mutating the candidate packet", async () => {
    const projectRoot = await tmpDir();
    await writeFixtureProject(projectRoot);
    const outputDir = path.join(projectRoot, ".mmi");
    await runCli(["ingest-project", projectRoot, "--out", outputDir, "--json"]);
    const reviewLine = (await fs.readFile(path.join(outputDir, "review_queue.jsonl"), "utf8")).trim().split(/\r?\n/)[0];
    const reviewItem = JSON.parse(reviewLine) as { id: string; targetAtomId: string };
    const decisionsPath = path.join(outputDir, "my_decisions.jsonl");
    await fs.writeFile(
      decisionsPath,
      JSON.stringify({
        reviewItemId: reviewItem.id,
        targetAtomId: reviewItem.targetAtomId,
        decision: "accept",
        reviewerNote: "fixture accept",
      }) + "\n",
      "utf8",
    );

    const result = await runCli(["review", outputDir, "--decisions", decisionsPath, "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as { schema: string; ok: boolean; counts: { accepted: number; unknownTargets: number } };
    expect(parsed.schema).toBe("mmi.gateway.cli_result");
    expect(parsed.ok).toBe(true);
    expect(parsed.counts).toMatchObject({ accepted: 1, unknownTargets: 0 });
    const accepted = await fs.readFile(path.join(outputDir, "accepted_atoms.jsonl"), "utf8");
    expect(accepted).toContain("fixture accept");
    await expect(fs.stat(path.join(outputDir, "packet.json"))).resolves.toBeDefined();
  });

  it("returns a machine-readable handoff summary", async () => {
    const outputDir = await tmpDir();
    await runCli(["ingest", "--out", outputDir, "--text", "handoff source"]);

    const result = await runCli(["handoff", outputDir, "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      command: string;
      counts: { sources: number };
      boundary: { sourceMatrixBound: boolean };
      nextActions: Array<{ id: string }>;
      handoff: string;
    };
    expect(parsed).toMatchObject({
      command: "handoff",
      counts: { sources: 1 },
      boundary: { sourceMatrixBound: false },
    });
    expect(parsed.nextActions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "validate" })]));
    expect(parsed.handoff).toContain("## Snapshot");
    expect(parsed.handoff).toContain("## Suggested Agent Actions");
  });

  it("validates a run_error directory as a blocked result", async () => {
    const outputDir = await tmpDir();
    await runCli([
      "ingest",
      "--out",
      outputDir,
      "--sources-json",
      path.join(outputDir, "missing.json"),
      "--json",
    ]);
    await fs.writeFile(
      path.join(outputDir, "run_error.json"),
      JSON.stringify({
        schema: "mmi.gateway.run_error",
        schemaVersion: "1.0.0",
        status: "blocked_before_packet_write",
        issues: [{ code: "secret_leak_risk", message: "Secret-like value was blocked." }],
      }),
      "utf8",
    );

    const result = await runCli(["validate", outputDir, "--json"]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.join("\n")) as { ok: boolean; status: string; issues: Array<{ code: string }> };
    expect(parsed).toMatchObject({
      ok: false,
      status: "blocked_before_packet_write",
    });
    expect(parsed.issues).toEqual([expect.objectContaining({ code: "secret_leak_risk" })]);
  });
});
