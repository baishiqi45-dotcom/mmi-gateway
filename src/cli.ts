#!/usr/bin/env node
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { candidatePacketJsonSchema, createGateway, readPacket, sourceManifestJsonSchema, validateCandidatePacket } from "./index.ts";
import { DEFAULT_CONFIG_FILE, findConfig, gatewayConfigFromFileAsync, readConfig, writeDefaultConfig, type ConfigProfile } from "./config.ts";
import { ERROR_CATALOG, MmiGatewayError, issueWithRecovery, recoveryForIssue, redactSensitiveText, sanitizeIssue } from "./errors.ts";
import { sourceInputSchema, sourceManifestSchema } from "./schema.ts";
import { discoverProjectSources } from "./source-discovery.ts";
import { writeProjectIntakeArtifacts, type ProjectIntakeProfile } from "./project-intake.ts";
import { runAsrTaskFetch, runProjectPerception, type PerceptionProvider, type PerceptionTargetType } from "./perception.ts";
import { applyReviewDecisions, summarizeReviewQueue } from "./review-decisions.ts";
import { MMI_GATEWAY_PACKAGE_VERSION, type GatewayIssue, type PacketProfile, type ProviderHealth, type SourceInput, type SourceType } from "./types.ts";

export type CliResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
};

const MMI_GATEWAY_PACKAGE_NAME = "@mmi/gateway" as const;
const STARTER_SAMPLE_TEXT = [
  "# MMI starter source",
  "",
  "This is a synthetic starter brief for a first intake smoke test.",
  "It should become candidate evidence only, not source truth or project truth.",
  "",
].join("\n");

const RECIPES = [
  {
    id: "manual-first-run",
    description: "No-key local starter path for humans and agents.",
    docs: "README.md#quickstart",
    commands: [
      "mmi init --starter --profile agent --config ./mmi.config.json --json",
      "mmi selftest --json",
      "mmi ingest --config ./mmi.config.json --out ./mmi-runs/run-001 --file ./sources/starter.md --dry-run --json",
    ],
  },
  {
    id: "agent-jsonl-intake",
    description: "Stream one SourceInput JSON object per line into a candidate packet.",
    docs: "docs/RECIPES.md#agent-jsonl-intake",
    commands: ["mmi ingest --stdin-jsonl --out ./mmi-runs/jsonl-run --json", "mmi validate ./mmi-runs/jsonl-run --json"],
  },
  {
    id: "local-project-folder-intake",
    description: "Scan a local project folder and write visual/video/project-foundation review artifacts.",
    docs: "docs/RECIPES.md#local-project-folder-intake",
    commands: [
      "mmi ingest-project ./my-project --profile creative-project --out ./my-project/.mmi --dry-run --json",
      "mmi ingest-project ./my-project --profile creative-project --out ./my-project/.mmi --json",
      "mmi review ./my-project/.mmi --json",
    ],
  },
  {
    id: "agent-review-perception",
    description: "Build an agent-readable perception bundle, optionally submitting ASR or visual fallback provider calls.",
    docs: "docs/RECIPES.md#agent-review-perception",
    commands: [
      "mmi perceive ./my-project/.mmi --no-keyframes --json",
      "mmi perceive ./my-project/.mmi --asr --target-type video_window --url-map ./urls.jsonl --json",
      "mmi asr fetch ./my-project/.mmi --wait --json",
      "mmi perceive ./my-project/.mmi --visual-provider dashscope --target-type image --allow-local-media --limit 3 --json",
    ],
  },
  {
    id: "custom-provider-module",
    description: "Load a local ProviderAdapter module through mmi.config.json.",
    docs: "examples/custom-provider-module/README.md",
    commands: [
      "mmi doctor --config ./examples/custom-provider-module/mmi.config.json --json",
      "mmi ingest --config ./examples/custom-provider-module/mmi.config.json --sources ./examples/custom-provider-module/sources.jsonl --out ./mmi-runs/module-run --json",
    ],
  },
  {
    id: "signed-url-storage-boundary",
    description: "Use signed URLs for provider dispatch without persisting signed URLs in packets.",
    docs: "examples/signed-url-storage.ts",
    commands: ["tsx examples/signed-url-storage.ts"],
  },
] as const;

function valuesAfter(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function valueAfter(argv: string[], name: string): string | undefined {
  return valuesAfter(argv, name)[0];
}

function numberAfter(argv: string[], name: string, fallback: number): number {
  const value = valueAfter(argv, name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new MmiGatewayError(`${name} must be a non-negative number.`, "invalid_cli");
  return parsed;
}

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function jsonLine(value: unknown): string {
  const payload = (typeof value === "object" && value !== null ? value : { value }) as Record<string, unknown>;
  const derivedNextCommands = Array.isArray(payload.nextActions)
    ? payload.nextActions
        .map((action) => (typeof action === "object" && action !== null && "command" in action ? (action as { command?: unknown }).command : undefined))
        .filter((command): command is string => typeof command === "string" && command.length > 0)
    : [];
  return JSON.stringify(
    {
      ...payload,
      schema: "mmi.gateway.cli_result",
      schemaVersion: "1.0.0",
      gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
      data: payload.data ?? payload,
      nextCommands: Array.isArray(payload.nextCommands) ? payload.nextCommands : derivedNextCommands,
    },
    null,
    2,
  );
}

function cliError(
  argv: string[],
  command: string | undefined,
  message: string,
  code: GatewayIssue["code"] = "invalid_cli",
  exitCode = 2,
  extras: Partial<GatewayIssue> = {},
): CliResult {
  if (!wantsJson(argv)) return { exitCode, stdout: [], stderr: [message] };
  const issues = enrichIssues([issue(code, message, extras)]);
  return {
    exitCode,
    stdout: [
      jsonLine({
        ok: false,
        command: command ?? "unknown",
        issues,
        error: {
          code,
          message: redactSensitiveText(message),
          recovery: issues[0]?.recovery ?? "Inspect the command arguments and rerun.",
        },
        nextActions: [
          {
            id: "fix_command",
            description: "Fix the command arguments and rerun.",
            required: true,
          },
        ],
      }),
    ],
    stderr: [],
  };
}

function inferTypeFromUri(uri: string): SourceType {
  let pathname = uri;
  try {
    pathname = new URL(uri).pathname;
  } catch {
    // local path
  }
  const ext = path.extname(pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".aac", ".m4a", ".flac", ".amr"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv"].includes(ext)) return "video";
  if ([".md", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".pdf"].includes(ext)) return "document";
  if (uri.startsWith("http://") || uri.startsWith("https://")) return "web";
  return "other";
}

const TEXT_FILE_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml"]);

function issue(code: GatewayIssue["code"], message: string, extras: Partial<GatewayIssue> = {}): GatewayIssue {
  return sanitizeIssue({ code, message, ...extras });
}

async function sourcesFromArgs(
  argv: string[],
  provider: string | undefined,
  policy: { maxSourceBytes?: number } = {},
): Promise<{ sources: SourceInput[]; issues: GatewayIssue[] }> {
  const sources: SourceInput[] = [];
  const issues: GatewayIssue[] = [];
  let sequence = 1;
  for (const text of valuesAfter(argv, "--text")) {
    const id = `src_text_${String(sequence).padStart(3, "0")}`;
    sources.push({ id, type: "text", uri: `manual://${id}`, text, provider, privacy: "synthetic" });
    sequence += 1;
  }
  for (const file of valuesAfter(argv, "--file")) {
    const resolved = path.resolve(file);
    const type = inferTypeFromUri(resolved);
    const id = `src_${type}_${String(sequence).padStart(3, "0")}`;
    const source: SourceInput = { id, type, uri: resolved, provider, privacy: "project_private" };
    let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      issues.push(
        issue("invalid_source", `Cannot read file '${resolved}': ${error instanceof Error ? error.message : String(error)}`, {
          id,
          path: resolved,
        }),
      );
      sources.push(source);
      sequence += 1;
      continue;
    }
    const exceedsMaxBytes = policy.maxSourceBytes !== undefined && stat.size > policy.maxSourceBytes;
    if (exceedsMaxBytes) {
      issues.push(
        issue("source_too_large", `File '${resolved}' exceeds maxSourceBytes (${stat.size} > ${policy.maxSourceBytes}).`, {
          id,
          path: resolved,
        }),
      );
    }
    if (!exceedsMaxBytes && (type === "text" || (type === "document" && TEXT_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase())))) {
      source.text = await fs.readFile(resolved, "utf8");
    }
    sources.push(source);
    sequence += 1;
  }
  for (const url of valuesAfter(argv, "--url")) {
    const type = inferTypeFromUri(url);
    const id = `src_${type}_${String(sequence).padStart(3, "0")}`;
    sources.push({
      id,
      type,
      uri: url,
      provider,
      privacy: url.includes("sig") || url.includes("token") ? "signed_url" : "public",
    });
    sequence += 1;
  }
  for (const sourceFile of valuesAfter(argv, "--sources-json")) {
    sources.push(...(await sourcesFromJsonFile(sourceFile, provider)));
  }
  for (const sourceFile of valuesAfter(argv, "--sources")) {
    sources.push(...(await sourcesFromJsonFile(sourceFile, provider)));
  }
  if (argv.includes("--stdin-json")) {
    sources.push(...parseSourcesManifest(await readStdinText(), provider, "stdin"));
  }
  if (argv.includes("--stdin-jsonl")) {
    sources.push(...parseSourcesManifest(await readStdinText(), provider, "stdin"));
  }
  return { sources, issues };
}

async function sourcesFromJsonFile(sourceFile: string, provider?: string): Promise<SourceInput[]> {
  return parseSourcesManifest(await fs.readFile(path.resolve(sourceFile), "utf8"), provider, sourceFile);
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSourcesJson(raw: unknown, provider?: string): SourceInput[] {
  const sourceList =
    Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null && "type" in raw ? [raw] : sourceManifestSchema.parse(raw).sources;
  if (!Array.isArray(sourceList)) {
    throw new MmiGatewayError("Source manifest must be an array or an object with a sources array.", "invalid_cli");
  }
  return sourceList.map((source, index) => {
    const parsedResult = sourceInputSchema.safeParse(source);
    if (!parsedResult.success) {
      const detail = parsedResult.error.issues.map((schemaIssue) => `${schemaIssue.path.join(".") || "$"}: ${schemaIssue.message}`).join("; ");
      throw new MmiGatewayError(`source[${index}]: ${detail}`, "invalid_cli");
    }
    const parsed = parsedResult.data;
    return {
      ...parsed,
      provider: parsed.provider ?? provider,
    };
  });
}

function parseSourcesManifest(text: string, provider: string | undefined, label: string): SourceInput[] {
  const trimmed = text.trim();
  if (!trimmed) throw new MmiGatewayError(`${label} is empty.`, "invalid_cli");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parseSourcesJson(parsed, provider);
  } catch (jsonParseError) {
    if (jsonParseError instanceof MmiGatewayError) throw jsonParseError;
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    if (lines.length <= 1) {
      throw new MmiGatewayError(jsonParseError instanceof Error ? jsonParseError.message : String(jsonParseError), "invalid_cli");
    }
    return lines.flatMap((line, index) => {
      try {
        const raw = JSON.parse(line) as unknown;
        if (Array.isArray(raw) || (typeof raw === "object" && raw !== null && "sources" in raw)) {
          return parseSourcesJson(raw, provider);
        }
        return parseSourcesJson([raw], provider);
      } catch (lineError) {
        throw new MmiGatewayError(`${label} line ${index + 1}: ${lineError instanceof Error ? lineError.message : String(lineError)}`, "invalid_cli");
      }
    });
  }
}

function commandPath(value: string): string {
  const absolute = path.resolve(value);
  const relative = path.relative(process.cwd(), absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return absolute;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function replayArgs(argv: string[], specs: Array<{ name: string; takesValue: boolean }>): string[] {
  const result: string[] = [];
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));
  for (let index = 0; index < argv.length; index += 1) {
    const spec = specByName.get(argv[index]);
    if (!spec) continue;
    result.push(argv[index]);
    if (spec.takesValue && argv[index + 1]) {
      result.push(argv[index + 1]);
      index += 1;
    }
  }
  return result;
}

function shellCommand(parts: string[]): string {
  return parts.map(shellArg).join(" ");
}

async function writeStarter(configPath: string): Promise<{ samplePath: string; ingestCommand: string; validateCommand: string }> {
  const configDir = path.dirname(path.resolve(configPath));
  const samplePath = path.join(configDir, "sources", "starter.md");
  const runDir = path.join(configDir, "mmi-runs", "starter-run");
  await fs.mkdir(path.dirname(samplePath), { recursive: true });
  await fs.writeFile(samplePath, STARTER_SAMPLE_TEXT, "utf8");
  const relativeConfig = commandPath(configPath);
  const relativeSample = commandPath(samplePath);
  const relativeRunDir = commandPath(runDir);
  return {
    samplePath,
    ingestCommand: `mmi ingest --config ${shellArg(relativeConfig)} --out ${shellArg(relativeRunDir)} --file ${shellArg(relativeSample)} --json`,
    validateCommand: `mmi validate ${shellArg(relativeRunDir)} --json`,
  };
}

function help(): string {
  return [
    "mmi - multimodal intake gateway",
    "",
    "Commands:",
    "  mmi init [--config mmi.config.json] [--profile generic|agent|dashscope|openai-compatible] [--starter] [--json]",
    "  mmi ingest [--config mmi.config.json] [--provider manual|mock|dashscope] [--out dir] [--project-id id] [--prompt value] [--text value] [--file path] [--url url] [--sources file.json|file.jsonl] [--stdin-json|--stdin-jsonl] [--json]",
    "  mmi ingest-project <folder> [--profile creative-project|field-video-project-base|visual-asset-library-only] [--out dir] [--dry-run] [--extract-keyframes] [--json]",
    "  mmi perceive <project-intake-dir> [--asr] [--url-map urls.jsonl] [--visual-provider mock|dashscope] [--target-type image|video_window|audio|text_excerpt] [--allow-local-media] [--max-local-image-bytes n] [--no-keyframes] [--json]",
    "  mmi asr fetch|poll <project-intake-dir> [--task-id id] [--wait] [--max-attempts n] [--interval-ms n] [--max-transcript-bytes n] [--json]",
    "  mmi review <project-intake-dir> [--decisions review_decisions.jsonl] [--json]",
    "  mmi validate <packet-dir-or-packet.json>",
    "  mmi handoff <packet-dir-or-packet.json> [--json]",
    "  mmi explain <issue-code> [--json]",
    "  mmi recipes [--json]",
    "  mmi schema [--kind candidate-packet|source-manifest]",
    "  mmi providers [--config mmi.config.json]",
    "  mmi doctor [--config mmi.config.json] [--json]",
    "  mmi selftest [--json]",
    "  mmi --version [--json]",
  ].join("\n");
}

function doctorIssues(config: Awaited<ReturnType<typeof readConfig>>, providerIds: string[]): GatewayIssue[] {
  const issues: GatewayIssue[] = [];
  const defaultProvider = config.defaultProvider ?? "manual";
  if (!providerIds.includes(defaultProvider)) {
    issues.push(issue("provider_missing", `Default provider '${defaultProvider}' is not registered.`, { providerId: defaultProvider }));
  }
  return issues;
}

async function providerHealthChecks(providers: ReturnType<typeof createGateway>["providers"]): Promise<ProviderHealth[]> {
  const createdAt = new Date().toISOString();
  const health: ProviderHealth[] = [];
  for (const provider of providers) {
    if (!provider.healthCheck) {
      health.push({
        providerId: provider.id,
        status: "ok",
        message: "No provider healthCheck was declared; static contract shape was loaded.",
      });
      continue;
    }
    try {
      health.push(
        await provider.healthCheck({
          runId: "mmi_doctor",
          createdAt,
          prompt: "Local configuration health check only. Do not call external APIs.",
        }),
      );
    } catch (error) {
      health.push({
        providerId: provider.id,
        status: "error",
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        issues: [
          issue("provider_error", error instanceof Error ? error.message : String(error), {
            providerId: provider.id,
          }),
        ],
      });
    }
  }
  return health;
}

function appendIssueLines(stdout: string[], issues: GatewayIssue[]): void {
  for (const item of issues) {
    const issue = issueWithRecovery(item);
    stdout.push(`- ${issue.code}: ${issue.message} Recovery: ${issue.recovery}`);
  }
}

function isConfigProfile(value: string): value is ConfigProfile {
  return ["generic", "agent", "dashscope", "openai-compatible"].includes(value);
}

function isProjectIntakeProfile(value: string): value is ProjectIntakeProfile {
  return ["creative-project", "creative_project_foundation", "field-video-project-base", "visual-asset-library-only"].includes(value);
}

function isPerceptionProvider(value: string): value is PerceptionProvider {
  return value === "dashscope" || value === "mock";
}

function parsePerceptionProvider(value: string | undefined): PerceptionProvider | undefined {
  if (!value) return undefined;
  if (!isPerceptionProvider(value)) throw new MmiGatewayError(`unsupported visual provider: ${value}`, "invalid_cli");
  return value;
}

function isPerceptionTargetType(value: string): value is PerceptionTargetType {
  return value === "image" || value === "video_window" || value === "audio" || value === "text_excerpt" || value === "blocker";
}

function parsePerceptionTargetTypes(argv: string[]): PerceptionTargetType[] | undefined {
  const values = valuesAfter(argv, "--target-type")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  const unsupported = values.find((value) => !isPerceptionTargetType(value));
  if (unsupported) throw new MmiGatewayError(`unsupported target type: ${unsupported}`, "invalid_cli");
  return values as PerceptionTargetType[];
}

function packetProfileForProject(profile: ProjectIntakeProfile): PacketProfile {
  if (profile === "field-video-project-base") return "field_video_project_base";
  if (profile === "visual-asset-library-only") return "visual_asset_library_only";
  return "creative_project_foundation";
}

function enrichIssues(issues: GatewayIssue[]): Array<GatewayIssue & ReturnType<typeof recoveryForIssue>> {
  return issues.map(issueWithRecovery);
}

function nextActionsForIngest(outputDir: string, issues: GatewayIssue[], wrotePacket: boolean): Array<{ id: string; command?: string; description: string; required: boolean }> {
  if (!wrotePacket) {
    return [
      {
        id: "resolve_blocker",
        command: issues[0] ? `mmi explain ${issues[0].code}` : "mmi explain invalid_cli",
        description: "Resolve the blocking issue before packet output can be written.",
        required: true,
      },
    ];
  }
  return [
    {
      id: "validate",
      command: `mmi validate ${shellArg(outputDir)} --json`,
      description: "Validate the candidate packet before any downstream use.",
      required: true,
    },
    {
      id: "handoff",
      command: `mmi handoff ${shellArg(outputDir)} --json`,
      description: "Load the next-agent handoff summary.",
      required: false,
    },
  ];
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readRunError(target: string): Promise<{ path: string; value: Record<string, unknown> } | null> {
  const stat = await fs.stat(target);
  const root = stat.isDirectory() ? target : path.dirname(target);
  const runErrorPath = path.join(root, "run_error.json");
  try {
    return { path: runErrorPath, value: await readJson<Record<string, unknown>>(runErrorPath) };
  } catch {
    return null;
  }
}

async function handoffSummary(target: string): Promise<Record<string, unknown>> {
  const stat = await fs.stat(target);
  const root = stat.isDirectory() ? target : path.dirname(target);
  const manifestPath = path.join(root, "gateway_manifest.json");
  const handoffPath = path.join(root, "agent_handoff.md");
  const packet = await readPacket(root);
  let manifest: Record<string, unknown> | null = null;
  let handoff = "";
  try {
    manifest = await readJson<Record<string, unknown>>(manifestPath);
  } catch {
    // Older packet directories may not have a manifest.
  }
  try {
    handoff = await fs.readFile(handoffPath, "utf8");
  } catch {
    handoff = "No agent_handoff.md was found. Read packet.json and run mmi validate before downstream use.";
  }
  return {
    target: root,
    manifestPath,
    packetPath: path.join(root, "packet.json"),
    agentHandoffPath: handoffPath,
    status: packet.status,
    run: packet.run,
    counts: {
      sources: packet.sources.length,
      evidenceAtoms: packet.evidenceAtoms.length,
      claims: packet.claims.length,
      reviewItems: packet.reviewItems.length,
    },
    boundary: {
      reviewRequired: packet.review.required,
      reviewVerdict: packet.review.verdict,
      sourceMatrixBound: packet.sourceMatrix.bound,
      nonClaims: packet.nonClaims,
    },
    nextActions: manifest?.nextActions ?? [
      {
        id: "validate",
        command: `mmi validate ${root} --json`,
        description: "Validate this candidate packet before downstream use.",
        required: true,
      },
    ],
    handoff,
  };
}

async function runSelftest(): Promise<{
  ok: boolean;
  command: "selftest";
  root: string;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
}> {
  const summarize = (result: CliResult): string => {
    try {
      const parsed = JSON.parse(result.stdout.join("\n")) as {
        ok?: boolean;
        command?: string;
        counts?: { sources?: number; issues?: number };
        issues?: Array<{ code?: string }>;
      };
      const issueCodes = parsed.issues?.map((item) => item.code).filter(Boolean).join(",") || "none";
      const counts = parsed.counts ? ` sources=${parsed.counts.sources ?? 0} issues=${parsed.counts.issues ?? 0}` : "";
      return `exit=${result.exitCode} ok=${String(parsed.ok)} command=${parsed.command ?? "unknown"}${counts} issueCodes=${issueCodes}`;
    } catch {
      return `exit=${result.exitCode} stdout=${result.stdout.join(" ").slice(0, 240)}`;
    }
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mmi-selftest-"));
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const ingestDir = path.join(root, "ingest");
  const ingest = await runCli(["ingest", "--out", ingestDir, "--text", "Selftest candidate-only intake.", "--json"]);
  checks.push({ id: "ingest_json", ok: ingest.exitCode === 0, detail: summarize(ingest) });
  const validate = await runCli(["validate", ingestDir, "--json"]);
  checks.push({ id: "validate_json", ok: validate.exitCode === 0, detail: summarize(validate) });

  const manifestPath = path.join(root, "sources.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ schema: "mmi.gateway.source_manifest", schemaVersion: "1.0.0", sources: [{ id: "manifest", type: "text", text: "Manifest source." }] }),
    "utf8",
  );
  const manifestRunDir = path.join(root, "manifest");
  const manifest = await runCli(["ingest", "--out", manifestRunDir, "--sources", manifestPath, "--json"]);
  checks.push({ id: "source_manifest", ok: manifest.exitCode === 0, detail: summarize(manifest) });

  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, "photos"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "video"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "brief.md"), "# Selftest project\n\nLocal project intake smoke.", "utf8");
  await fs.writeFile(
    path.join(projectRoot, "photos", "photo.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  );
  await fs.writeFile(path.join(projectRoot, "video", "clip.mp4"), Buffer.from("not a real video"));
  const projectRunDir = path.join(projectRoot, ".mmi");
  const project = await runCli(["ingest-project", projectRoot, "--out", projectRunDir, "--no-keyframes", "--json"]);
  const projectReviewExists = await fs
    .stat(path.join(projectRunDir, "human_review_surface.md"))
    .then(() => true)
    .catch(() => false);
  checks.push({ id: "project_folder_intake", ok: project.exitCode === 0 && projectReviewExists, detail: summarize(project) });
  const perceive = await runCli(["perceive", projectRunDir, "--limit", "2", "--no-keyframes", "--json"]);
  const perceiveManifestExists = await fs
    .stat(path.join(projectRunDir, "perception", "perception_manifest.json"))
    .then(() => true)
    .catch(() => false);
  checks.push({ id: "agent_review_perception", ok: perceive.exitCode === 0 && perceiveManifestExists, detail: summarize(perceive) });

  const secretPath = path.join(root, "secret-sources.json");
  await fs.writeFile(
    secretPath,
    JSON.stringify({ sources: [{ type: "text", text: "Secret failure test.", metadata: { apiKey: "selftest_secret_value_123456789" } }] }),
    "utf8",
  );
  const secretDir = path.join(root, "secret");
  const secret = await runCli(["ingest", "--out", secretDir, "--sources", secretPath, "--json"]);
  const secretPacketExists = await fs
    .stat(path.join(secretDir, "packet.json"))
    .then(() => true)
    .catch(() => false);
  const runErrorExists = await fs
    .stat(path.join(secretDir, "run_error.json"))
    .then(() => true)
    .catch(() => false);
  checks.push({
    id: "secret_fail_closed",
    ok: secret.exitCode === 1 && !secretPacketExists && runErrorExists && !secret.stdout.join("\n").includes("selftest_secret_value"),
    detail: summarize(secret),
  });

  return {
    ok: checks.every((check) => check.ok),
    command: "selftest",
    root,
    checks,
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") return { exitCode: 0, stdout: [help()], stderr };
  if (command === "--version" || command === "-v" || command === "-V" || command === "version") {
    if (wantsJson(argv)) {
      stdout.push(jsonLine({ ok: true, command: "version", name: MMI_GATEWAY_PACKAGE_NAME, version: MMI_GATEWAY_PACKAGE_VERSION }));
      return { exitCode: 0, stdout, stderr };
    }
    return { exitCode: 0, stdout: [`${MMI_GATEWAY_PACKAGE_NAME} v${MMI_GATEWAY_PACKAGE_VERSION}`], stderr };
  }

  try {
    if (command === "init") {
      const configPath = valueAfter(argv, "--config") ?? DEFAULT_CONFIG_FILE;
      const profile = valueAfter(argv, "--profile") ?? "generic";
      if (!isConfigProfile(profile)) return cliError(argv, command, `unsupported config profile: ${profile}`);
      await writeDefaultConfig(configPath, profile);
      const starter = argv.includes("--starter") ? await writeStarter(configPath) : undefined;
      if (wantsJson(argv)) {
        stdout.push(
          jsonLine({
            ok: true,
            command: "init",
            configPath,
            profile,
            starter,
            nextCommands: starter
              ? [starter.ingestCommand, starter.validateCommand]
              : [`mmi doctor --config ${configPath} --json`, `mmi ingest --config ${configPath} --text "Starter brief" --out ./mmi-run --json`],
          }),
        );
        return { exitCode: 0, stdout, stderr };
      }
      stdout.push(starter ? `MMI_STARTER_CREATED ${configPath}` : `MMI_CONFIG_CREATED ${configPath}`);
      stdout.push(`profile: ${profile}`);
      if (starter) {
        stdout.push(`sample: ${starter.samplePath}`);
        stdout.push(`next: ${starter.ingestCommand}`);
        stdout.push(`then: ${starter.validateCommand}`);
      }
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "schema") {
      const target = valueAfter(argv, "--kind") ?? argv[1] ?? "candidate-packet";
      if (target !== "candidate-packet" && target !== "source-manifest") {
        return cliError(argv, command, `unsupported schema target: ${target}`);
      }
      stdout.push(JSON.stringify(target === "source-manifest" ? sourceManifestJsonSchema() : candidatePacketJsonSchema(), null, 2));
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "selftest") {
      const result = await runSelftest();
      if (wantsJson(argv)) {
        stdout.push(jsonLine(result));
        return { exitCode: result.ok ? 0 : 1, stdout, stderr };
      }
      stdout.push(result.ok ? "MMI_SELFTEST_HELD" : "MMI_SELFTEST_ISSUES");
      stdout.push(`root: ${result.root}`);
      for (const check of result.checks) stdout.push(`- ${check.id}: ${check.ok ? "ok" : "failed"}`);
      return { exitCode: result.ok ? 0 : 1, stdout, stderr };
    }

    if (command === "explain") {
      const code = argv[1] as keyof typeof ERROR_CATALOG | undefined;
      if (!code || !(code in ERROR_CATALOG)) {
        return cliError(argv, command, `unknown issue code: ${code ?? "<missing>"}`);
      }
      const entry = ERROR_CATALOG[code];
      if (wantsJson(argv)) {
        stdout.push(jsonLine({ ok: true, command: "explain", code, ...entry, suggestedFix: entry.recovery }));
        return { exitCode: 0, stdout, stderr };
      }
      stdout.push(`${code}: ${entry.message}`);
      stdout.push(`severity: ${entry.severity}`);
      stdout.push(`recovery: ${entry.recovery}`);
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "recipes") {
      if (wantsJson(argv)) {
        stdout.push(jsonLine({ ok: true, command: "recipes", recipes: RECIPES }));
        return { exitCode: 0, stdout, stderr };
      }
      stdout.push("MMI_RECIPES");
      for (const recipe of RECIPES) {
        stdout.push(`- ${recipe.id}: ${recipe.description}`);
        stdout.push(`  docs: ${recipe.docs}`);
        stdout.push(`  first: ${recipe.commands[0]}`);
      }
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "handoff") {
      const target = argv[1];
      if (!target) return cliError(argv, command, "missing target");
      const summary = await handoffSummary(target);
      if (wantsJson(argv)) {
        stdout.push(jsonLine({ ok: true, command: "handoff", ...summary }));
        return { exitCode: 0, stdout, stderr };
      }
      stdout.push(String(summary.handoff));
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "review") {
      const target = argv[1];
      if (!target) return cliError(argv, command, "missing project intake directory");
      const decisionsPath = valueAfter(argv, "--decisions");
      const summary = decisionsPath ? await applyReviewDecisions(target, decisionsPath) : await summarizeReviewQueue(target);
      if (wantsJson(argv)) {
        stdout.push(jsonLine({ ok: true, command: "review", ...summary }));
        return { exitCode: 0, stdout, stderr };
      }
      stdout.push(decisionsPath ? "MMI_REVIEW_DECISIONS_SUMMARIZED" : "MMI_REVIEW_QUEUE_READY");
      stdout.push(`run_dir: ${path.resolve(target)}`);
      if (decisionsPath) stdout.push(`summary: ${path.join(path.resolve(target), "review_decision_summary.json")}`);
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "perceive") {
      const target = argv[1] ?? valueAfter(argv, "--project-intake-dir") ?? valueAfter(argv, "--run-dir");
      if (!target) return cliError(argv, command, "missing project intake directory");
      const visualProvider = parsePerceptionProvider(valueAfter(argv, "--visual-provider") ?? (argv.includes("--qwen-visual") ? "dashscope" : undefined) ?? valueAfter(argv, "--provider"));
      const result = await runProjectPerception(target, {
        visualProvider,
        outputDir: valueAfter(argv, "--out") ?? valueAfter(argv, "--output-dir"),
        urlMapPath: valueAfter(argv, "--url-map"),
        targetIds: valuesAfter(argv, "--target-id"),
        targetTypes: parsePerceptionTargetTypes(argv),
        limit: numberAfter(argv, "--limit", 8),
        dryRun: argv.includes("--dry-run"),
        allowLocalMedia: argv.includes("--allow-local-media"),
        extractKeyframes: !argv.includes("--no-keyframes"),
        maxLocalImageBytes: numberAfter(argv, "--max-local-image-bytes", 10 * 1024 * 1024),
        maxVideoFrames: numberAfter(argv, "--max-video-frames", 3),
        fps: numberAfter(argv, "--fps", 1),
        prompt: valueAfter(argv, "--prompt"),
        asr: argv.includes("--asr"),
        asrModel: valueAfter(argv, "--asr-model"),
        model: valueAfter(argv, "--model"),
        baseUrl: valueAfter(argv, "--base-url"),
        apiKeyEnv: valueAfter(argv, "--api-key-env"),
      });
      const status = typeof result.status === "string" ? result.status : "unknown";
      const ok = status !== "perception_needs_attention";
      const outputDir = typeof result.outputDir === "string" ? result.outputDir : path.join(path.resolve(target), "perception");
      const resultCounts = typeof result.counts === "object" && result.counts !== null ? (result.counts as { asrTasks?: unknown }) : {};
      const asrTaskCount = typeof resultCounts.asrTasks === "number" ? resultCounts.asrTasks : 0;
      const nextActions = [
        {
          id: "agent_review",
          description: "Open agent_review_targets.jsonl and inspect local media/transcripts with the receiving agent.",
          required: true,
        },
        ...(asrTaskCount > 0
          ? [
              {
                id: "fetch_asr",
                command: `mmi asr fetch ${shellArg(path.resolve(target))} --wait --json`,
                description: "Fetch completed Paraformer transcripts into review-required sidecars.",
                required: true,
              },
            ]
          : []),
        {
          id: "asr_remote_url",
          command: `mmi perceive ${shellArg(path.resolve(target))} --asr --url-map ./urls.jsonl --json`,
          description: "Use this when local audio/video needs Paraformer and you have reviewed HTTP(S) or OSS URLs.",
          required: false,
        },
        {
          id: "visual_fallback",
          command: `mmi perceive ${shellArg(path.resolve(target))} --visual-provider dashscope --target-type image --limit 3 --json`,
          description: "Use only when the receiving agent cannot inspect the media itself or you explicitly want provider perception.",
          required: false,
        },
      ];
      if (wantsJson(argv)) {
        stdout.push(jsonLine({ ok, command: "perceive", ...result, nextActions }));
        return { exitCode: ok ? 0 : 1, stdout, stderr };
      }
      stdout.push(ok ? "MMI_PERCEPTION_READY" : "MMI_PERCEPTION_NEEDS_ATTENTION");
      stdout.push(`output_dir: ${outputDir}`);
      stdout.push(`status: ${status}`);
      stdout.push(`agent_review_targets: ${path.join(outputDir, "agent_review_targets.jsonl")}`);
      stdout.push(`blockers: ${path.join(outputDir, "perception_blockers.json")}`);
      return { exitCode: ok ? 0 : 1, stdout, stderr };
    }

    if (command === "asr") {
      const action = argv[1] === "poll" || argv[1] === "fetch" || !argv[1] ? (argv[1] ?? "fetch") : "fetch";
      if (action !== "fetch" && action !== "poll") return cliError(argv, command, `unsupported asr action: ${action}`);
      const targetIndex = action === argv[1] ? 2 : 1;
      const positionalTarget = argv[targetIndex] && !argv[targetIndex].startsWith("-") ? argv[targetIndex] : undefined;
      const target = valueAfter(argv, "--project-intake-dir") ?? valueAfter(argv, "--run-dir") ?? positionalTarget;
      if (!target) return cliError(argv, command, "missing project intake directory");
      const result = await runAsrTaskFetch(target, {
        outputDir: valueAfter(argv, "--out") ?? valueAfter(argv, "--output-dir"),
        taskIds: valuesAfter(argv, "--task-id"),
        wait: action === "poll" || argv.includes("--wait"),
        intervalMs: numberAfter(argv, "--interval-ms", 2000),
        maxAttempts: numberAfter(argv, "--max-attempts", action === "poll" || argv.includes("--wait") ? 60 : 1),
        maxTranscriptBytes: numberAfter(argv, "--max-transcript-bytes", 20 * 1024 * 1024),
        apiKeyEnv: valueAfter(argv, "--api-key-env"),
      });
      const status = typeof result.status === "string" ? result.status : "unknown";
      const ok = status !== "asr_fetch_needs_attention";
      const outputDir = typeof result.outputDir === "string" ? result.outputDir : path.join(path.resolve(target), "perception");
      const nextActions = [
        {
          id: "review_transcripts",
          description: "Open transcripts/ and asr_results.jsonl; accept, edit, or discard the transcript sidecars during review.",
          required: true,
        },
        {
          id: "inspect_blockers",
          command: `cat ${shellArg(path.join(outputDir, "asr_fetch_blockers.json"))}`,
          description: "Inspect ASR fetch blockers when a task is pending, failed, missing, or cannot be downloaded.",
          required: status !== "asr_results_review_required",
        },
      ];
      if (wantsJson(argv)) {
        stdout.push(jsonLine({ ok, command: "asr", action, ...result, nextActions }));
        return { exitCode: ok ? 0 : 1, stdout, stderr };
      }
      stdout.push(ok ? "MMI_ASR_FETCH_READY" : "MMI_ASR_FETCH_NEEDS_ATTENTION");
      stdout.push(`output_dir: ${outputDir}`);
      stdout.push(`status: ${status}`);
      stdout.push(`asr_results: ${path.join(outputDir, "asr_results.jsonl")}`);
      stdout.push(`transcripts: ${path.join(outputDir, "transcripts")}`);
      stdout.push(`blockers: ${path.join(outputDir, "asr_fetch_blockers.json")}`);
      return { exitCode: ok ? 0 : 1, stdout, stderr };
    }

    const configPath = valueAfter(argv, "--config");
    const resolvedConfigPath = configPath ? path.resolve(configPath) : await findConfig();
    const config = await readConfig(configPath);
    const gateway = createGateway(await gatewayConfigFromFileAsync(config, { baseDir: resolvedConfigPath ? path.dirname(resolvedConfigPath) : process.cwd() }));

    if (command === "ingest-project" || command === "ingest-folder") {
      const projectDir = argv[1] ?? valueAfter(argv, "--project-dir") ?? valueAfter(argv, "--folder");
      if (!projectDir) return cliError(argv, command, "missing project folder");
      const projectRoot = path.resolve(projectDir);
      const projectStat = await fs
        .stat(projectRoot)
        .catch(() => null);
      if (!projectStat || !projectStat.isDirectory()) {
        return cliError(argv, command, `project folder does not exist or is not a directory: ${projectRoot}`, "invalid_source", 1, { path: projectRoot });
      }
      const rawProfile = valueAfter(argv, "--profile") ?? "creative-project";
      if (!isProjectIntakeProfile(rawProfile)) return cliError(argv, command, `unsupported project intake profile: ${rawProfile}`);
      const provider = valueAfter(argv, "--provider") ?? "manual";
      const outputDir = valueAfter(argv, "--out") ?? valueAfter(argv, "--output-dir") ?? path.join(projectRoot, ".mmi");
      const include = valuesAfter(argv, "--include");
      const exclude = valuesAfter(argv, "--exclude");
      const maxFiles = numberAfter(argv, "--max-files", 2000);
      const maxFileBytes = numberAfter(argv, "--max-file-bytes", Number.MAX_SAFE_INTEGER);
      const maxTextBytes = numberAfter(argv, "--max-text-bytes", 1024 * 1024);
      const discovery = await discoverProjectSources(projectRoot, {
        include,
        exclude,
        maxFiles,
        maxFileBytes,
        maxTextBytes,
        hashFiles: argv.includes("--hash-files"),
        followSymlinks: argv.includes("--follow-symlinks"),
        provider: "manual",
      });
      const okDiscovery = discovery.sources.length > 0;
      const previewLimit = numberAfter(argv, "--preview-sources", 200);
      const replay = replayArgs(argv, [
        { name: "--include", takesValue: true },
        { name: "--exclude", takesValue: true },
        { name: "--max-files", takesValue: true },
        { name: "--max-file-bytes", takesValue: true },
        { name: "--max-text-bytes", takesValue: true },
        { name: "--hash-files", takesValue: false },
        { name: "--follow-symlinks", takesValue: false },
        { name: "--extract-audio", takesValue: false },
        { name: "--extract-keyframes", takesValue: false },
        { name: "--no-keyframes", takesValue: false },
        { name: "--max-video-windows", takesValue: true },
        { name: "--max-keyframes", takesValue: true },
        { name: "--max-audio-seconds", takesValue: true },
      ]);
      if (argv.includes("--dry-run")) {
        const runCommand = shellCommand(["mmi", "ingest-project", projectRoot, "--profile", rawProfile, "--out", outputDir, ...replay, "--json"]);
        const plan = {
          ok: okDiscovery,
          command: "ingest-project",
          mode: "dry-run-plan",
          projectRoot,
          outputDir,
          profile: rawProfile,
          selectedProvider: provider,
          providerMode: "manual_local_first",
          effectiveProvider: "manual",
          wouldCallProviders: false,
          wouldWritePacket: false,
          wouldWriteProjectIntake: false,
          effectiveOptions: {
            include,
            exclude,
            maxFiles,
            maxFileBytes,
            maxTextBytes,
            hashFiles: argv.includes("--hash-files"),
            followSymlinks: argv.includes("--follow-symlinks"),
            extractKeyframes: argv.includes("--extract-keyframes") && !argv.includes("--no-keyframes"),
            extractAudio: argv.includes("--extract-audio"),
          },
          replayArgs: replay,
          limits: { previewItems: previewLimit },
          sourcesTruncated: discovery.sources.length > previewLimit,
          skippedTruncated: discovery.skipped.length > previewLimit,
          counts: {
            sources: discovery.sources.length,
            skipped: discovery.skipped.length,
            ...discovery.counts,
          },
          sources: discovery.sources.slice(0, previewLimit).map((source) => ({
            id: source.id,
            type: source.type,
            relativePath: source.metadata.relativePath,
            originKind: source.metadata.originKind,
            assetRole: source.metadata.assetRole,
            sizeBytes: source.metadata.sizeBytes,
            hasInlineText: Boolean(source.text),
          })),
          skipped: discovery.skipped.slice(0, previewLimit),
          nextActions: [
            {
              id: "run_project_intake",
              command: runCommand,
              description: "Run the local-first project intake when the discovery plan looks correct.",
              required: okDiscovery,
            },
          ],
        };
        if (wantsJson(argv)) stdout.push(jsonLine(plan));
        else {
          stdout.push(okDiscovery ? "MMI_PROJECT_DRY_RUN_PLAN_HELD" : "MMI_PROJECT_DRY_RUN_PLAN_ISSUES");
          stdout.push(`project_root: ${projectRoot}`);
          stdout.push(`sources: ${discovery.sources.length}`);
          stdout.push(`images: ${discovery.counts.image}`);
          stdout.push(`videos: ${discovery.counts.video}`);
          stdout.push(`audio: ${discovery.counts.audio}`);
          stdout.push(`documents: ${discovery.counts.document}`);
        }
        return { exitCode: okDiscovery ? 0 : 1, stdout, stderr };
      }
      const packetProfile = packetProfileForProject(rawProfile);
      const result = await gateway.run({
        sources: discovery.sources,
        preflightIssues: okDiscovery ? [] : [issue("missing_source", "No supported project files were discovered.")],
        provider,
        outputDir,
        projectId: valueAfter(argv, "--project-id") ?? path.basename(projectRoot),
        prompt: valueAfter(argv, "--prompt"),
        profile: packetProfile,
        write: true,
      });
      const projectFiles = await writeProjectIntakeArtifacts(discovery, {
        profile: rawProfile,
        outputDir,
        extractKeyframes: argv.includes("--extract-keyframes") && !argv.includes("--no-keyframes"),
        extractAudio: argv.includes("--extract-audio"),
        maxVideoWindows: numberAfter(argv, "--max-video-windows", 12),
        maxKeyframes: numberAfter(argv, "--max-keyframes", 8),
        maxAudioSeconds: numberAfter(argv, "--max-audio-seconds", 600),
        noTruthPromotion: true,
      });
      const wrotePacket = result.filesWritten?.some((filePath) => path.basename(filePath) === "packet.json") ?? false;
      const ok = okDiscovery && result.issues.length === 0 && wrotePacket;
      if (wantsJson(argv)) {
        stdout.push(
          jsonLine({
            ok,
            command: "ingest-project",
            projectRoot,
            outputDir,
            profile: rawProfile,
            providerMode: "manual_local_first",
            effectiveProvider: "manual",
            counts: {
              sources: discovery.sources.length,
              skipped: discovery.skipped.length,
              evidenceAtoms: result.packet.evidenceAtoms.length,
              claims: result.packet.claims.length,
              reviewItems: result.packet.reviewItems.length,
              issues: result.issues.length,
              ...discovery.counts,
            },
            issues: enrichIssues(result.issues),
            skipped: discovery.skipped.slice(0, 200),
            packetPath: wrotePacket ? path.join(outputDir, "packet.json") : undefined,
            projectManifestPath: path.join(outputDir, "project_intake_manifest.json"),
            startHerePath: path.join(outputDir, "START_HERE.md"),
            topReviewTargetsPath: path.join(outputDir, "top_review_targets.jsonl"),
            reviewDecisionTemplatePath: path.join(outputDir, "review_decisions.template.jsonl"),
            humanReviewSurfacePath: path.join(outputDir, "human_review_surface.md"),
            blockerReportPath: path.join(outputDir, "gap_and_blocker_report.md"),
            nextActions: [
              { id: "review_surface", description: "Open human_review_surface.md and accept/edit/discard project atoms.", required: true },
              { id: "review_queue", command: `mmi review ${shellArg(outputDir)} --json`, description: "Inspect the review queue and decision template path before filling decisions.", required: true },
              { id: "validate", command: `mmi validate ${shellArg(outputDir)} --json`, description: "Validate the canonical candidate packet.", required: true },
              { id: "handoff", command: `mmi handoff ${shellArg(outputDir)} --json`, description: "Load next-agent handoff.", required: false },
            ],
            packetFilesWritten: result.filesWritten ?? [],
            projectFilesWritten: projectFiles,
            filesWritten: [...(result.filesWritten ?? []), ...projectFiles],
          }),
        );
        return { exitCode: ok ? 0 : 1, stdout, stderr };
      }
      stdout.push(ok ? "MMI_PROJECT_INGEST_HELD" : "MMI_PROJECT_INGEST_ISSUES");
      stdout.push(`output_dir: ${outputDir}`);
      stdout.push(`profile: ${rawProfile}`);
      stdout.push(`sources: ${discovery.sources.length}`);
      stdout.push(`images: ${discovery.counts.image}`);
      stdout.push(`videos: ${discovery.counts.video}`);
      stdout.push(`audio: ${discovery.counts.audio}`);
      stdout.push(`documents: ${discovery.counts.document}`);
      stdout.push(`review_surface: ${path.join(outputDir, "human_review_surface.md")}`);
      appendIssueLines(stdout, result.issues);
      return { exitCode: ok ? 0 : 1, stdout, stderr };
    }

    if (command === "providers") {
      if (wantsJson(argv)) {
        stdout.push(
          jsonLine({
            ok: true,
            command: "providers",
            providers: gateway.providers.map((provider) => ({
              apiVersion: provider.apiVersion,
              id: provider.id,
              displayName: provider.displayName,
              capabilities: provider.capabilities,
            })),
          }),
        );
        return { exitCode: 0, stdout, stderr };
      }
      stdout.push("MMI_PROVIDERS");
      for (const provider of gateway.providers) stdout.push(`- ${provider.id}: ${provider.displayName}`);
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "doctor") {
      const health = await providerHealthChecks(gateway.providers);
      const healthIssues = health.flatMap((item) => item.issues ?? []);
      const issues = [
        ...doctorIssues(
        config,
        gateway.providers.map((provider) => provider.id),
        ),
        ...healthIssues,
      ];
      if (wantsJson(argv)) {
        stdout.push(
          jsonLine({
            ok: issues.length === 0,
            command: "doctor",
            providers: gateway.providers.map((provider) => provider.id),
            health,
            defaultProvider: config.defaultProvider ?? gateway.providers[0]?.id ?? "manual",
            policy: {
              allowLocalMediaUpload: config.policy?.allowLocalMediaUpload ?? false,
              allowLocalTextUpload: config.policy?.allowLocalTextUpload ?? false,
              allowDataUrls: config.policy?.allowDataUrls ?? false,
              requireReview: config.policy?.requireReview ?? true,
            },
            issues: enrichIssues(issues),
          }),
        );
        return { exitCode: issues.length === 0 ? 0 : 1, stdout, stderr };
      }
      stdout.push(issues.length === 0 ? "MMI_DOCTOR_OK" : "MMI_DOCTOR_ISSUES");
      stdout.push(`providers: ${gateway.providers.map((provider) => provider.id).join(", ")}`);
      stdout.push(`default_provider: ${config.defaultProvider ?? gateway.providers[0]?.id ?? "manual"}`);
      stdout.push("local_media_upload: blocked_by_default");
      stdout.push("local_text_upload: blocked_by_default");
      appendIssueLines(stdout, issues);
      return { exitCode: issues.length === 0 ? 0 : 1, stdout, stderr };
    }

    if (command === "validate") {
      const target = argv[1];
      if (!target) return cliError(argv, command, "missing target");
      const runError = await readRunError(target);
      if (runError) {
        const issues = Array.isArray(runError.value.issues) ? (runError.value.issues as GatewayIssue[]) : [];
        if (wantsJson(argv)) {
          stdout.push(
            jsonLine({
              ok: false,
              command: "validate",
              target,
              status: runError.value.status ?? "blocked_before_packet_write",
              runErrorPath: runError.path,
              issues: enrichIssues(issues),
            }),
          );
          return { exitCode: 1, stdout, stderr };
        }
        stdout.push("MMI_VALIDATE_BLOCKED");
        stdout.push(`run_error: ${runError.path}`);
        appendIssueLines(stdout, issues);
        return { exitCode: 1, stdout, stderr };
      }
      const packet = await readPacket(target);
      const issues = validateCandidatePacket(packet);
      if (wantsJson(argv)) {
        stdout.push(jsonLine({ ok: issues.length === 0, command: "validate", target, issues: enrichIssues(issues) }));
        return { exitCode: issues.length === 0 ? 0 : 1, stdout, stderr };
      }
      stdout.push(issues.length === 0 ? "MMI_VALIDATE_HELD" : "MMI_VALIDATE_ISSUES");
      appendIssueLines(stdout, issues);
      return { exitCode: issues.length === 0 ? 0 : 1, stdout, stderr };
    }

    if (command === "ingest" || command === "run") {
      const provider = valueAfter(argv, "--provider");
      const profile = valueAfter(argv, "--profile") ?? "generic";
      if (profile !== "generic") {
        return cliError(argv, command, `unsupported profile: ${profile}`);
      }
      const outputDir = valueAfter(argv, "--out") ?? valueAfter(argv, "--output-dir") ?? path.join(process.cwd(), "mmi-run");
      const inputSources = await sourcesFromArgs(argv, provider, { maxSourceBytes: config.policy?.maxSourceBytes });
      const selectedProvider = provider ?? config.defaultProvider ?? "manual";
      if (argv.includes("--dry-run")) {
        const issues = [...inputSources.issues];
        if (inputSources.sources.length === 0) issues.push(issue("missing_source", "At least one source is required."));
        const ok = issues.length === 0;
        const plan = {
          ok,
          command: "ingest",
          mode: "dry-run-plan",
          outputDir,
          profile,
          selectedProvider,
          wouldCallProviders: false,
          wouldWritePacket: false,
          counts: {
            sources: inputSources.sources.length,
            issues: issues.length,
          },
          sources: inputSources.sources.map((source, index) => ({
            id: source.id ?? `src_${source.type}_${String(index + 1).padStart(3, "0")}`,
            type: source.type,
            provider: source.provider ?? selectedProvider,
            privacy: source.privacy ?? "inferred",
            rights: source.rights ?? "not_reviewed",
            hasInlineText: Boolean(source.text),
            uri: source.uri,
          })),
          issues: enrichIssues(issues),
          nextActions: [
            {
              id: "run_ingest",
              command: `mmi ingest --out ${shellArg(outputDir)}`,
              description: "Run without --dry-run when the plan looks correct.",
              required: ok,
            },
          ],
        };
        if (wantsJson(argv)) {
          stdout.push(jsonLine(plan));
        } else {
          stdout.push(ok ? "MMI_DRY_RUN_PLAN_HELD" : "MMI_DRY_RUN_PLAN_ISSUES");
          stdout.push(`selected_provider: ${selectedProvider}`);
          stdout.push(`sources: ${inputSources.sources.length}`);
          appendIssueLines(stdout, issues);
        }
        return { exitCode: ok ? 0 : 1, stdout, stderr };
      }
      const result = await gateway.run({
        sources: inputSources.sources,
        preflightIssues: inputSources.issues,
        provider,
        outputDir,
        projectId: valueAfter(argv, "--project-id"),
        prompt: valueAfter(argv, "--prompt"),
        profile,
        write: !argv.includes("--dry-run"),
      });
      const wrotePacket = result.filesWritten?.some((filePath) => path.basename(filePath) === "packet.json") ?? false;
      stdout.push(result.issues.length === 0 ? "MMI_INGEST_HELD" : "MMI_INGEST_ISSUES");
      stdout.push(`output_dir: ${outputDir}`);
      stdout.push(`profile: ${profile}`);
      stdout.push(`sources: ${result.packet.sources.length}`);
      stdout.push(`evidence_atoms: ${result.packet.evidenceAtoms.length}`);
      appendIssueLines(stdout, result.issues);
      if (wantsJson(argv)) {
        stdout.length = 0;
        stdout.push(
          jsonLine({
            ok: result.issues.length === 0,
            command: "ingest",
            outputDir,
            profile,
            counts: {
              sources: result.packet.sources.length,
              evidenceAtoms: result.packet.evidenceAtoms.length,
              claims: result.packet.claims.length,
              reviewItems: result.packet.reviewItems.length,
              issues: result.issues.length,
            },
            issues: enrichIssues(result.issues),
            nextActions: nextActionsForIngest(outputDir, result.issues, wrotePacket),
            packetPath: wrotePacket ? path.join(outputDir, "packet.json") : undefined,
            manifestPath: wrotePacket ? path.join(outputDir, "gateway_manifest.json") : undefined,
            agentHandoffPath: wrotePacket ? path.join(outputDir, "agent_handoff.md") : undefined,
            runErrorPath: !wrotePacket && !argv.includes("--dry-run") ? path.join(outputDir, "run_error.json") : undefined,
            filesWritten: result.filesWritten ?? [],
          }),
        );
      }
      return { exitCode: result.issues.length === 0 ? 0 : 1, stdout, stderr };
    }

    return cliError(argv, command, `unknown command: ${command}`);
  } catch (error) {
    if (wantsJson(argv)) {
      stdout.push(
        jsonLine({
          ok: false,
          command,
          error: {
            message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
            recovery:
              typeof error === "object" && error !== null && "code" in error
                ? recoveryForIssue(String(error.code) as GatewayIssue["code"]).recovery
                : "Inspect the command, config, and source manifest.",
          },
        }),
      );
      return { exitCode: 1, stdout, stderr };
    }
    stderr.push(redactSensitiveText(error instanceof Error ? error.message : String(error)));
    return { exitCode: 1, stdout, stderr };
  }
}

function isCliEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  let resolved = path.resolve(invoked);
  try {
    resolved = realpathSync(invoked);
  } catch {
    // Some launchers provide virtual argv paths; fall back to the resolved path.
  }
  return import.meta.url === pathToFileURL(resolved).href;
}

if (isCliEntrypoint()) {
  runCli().then((result) => {
    for (const line of result.stdout) console.log(line);
    for (const line of result.stderr) console.error(line);
    process.exitCode = result.exitCode;
  });
}
