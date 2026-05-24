import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DASHSCOPE_DEFAULT_BASE_URL, DASHSCOPE_DEFAULT_MODEL } from "./providers/dashscope.ts";
import { MMI_GATEWAY_PACKAGE_VERSION, REQUIRED_NON_CLAIMS, type SourceInput, type SourceType } from "./types.ts";

export type PerceptionProvider = "dashscope" | "mock";
export type PerceptionTargetType = "image" | "video_window" | "text_excerpt" | "audio" | "blocker";

export type ProjectPerceptionOptions = {
  provider?: PerceptionProvider;
  visualProvider?: PerceptionProvider;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  outputDir?: string;
  urlMapPath?: string;
  targetIds?: string[];
  targetTypes?: PerceptionTargetType[];
  limit?: number;
  dryRun?: boolean;
  allowLocalMedia?: boolean;
  maxLocalImageBytes?: number;
  maxVideoFrames?: number;
  extractKeyframes?: boolean;
  fps?: number;
  prompt?: string;
  asr?: boolean;
  asrModel?: string;
  languageHints?: string[];
  fetch?: typeof fetch;
};

type TopReviewTarget = {
  id: string;
  rank: number;
  targetType: PerceptionTargetType;
  sourceType?: SourceType;
  sourceId?: string;
  relativePath?: string;
  openUri?: string;
  targetAtomId?: string;
  priorityReason?: string;
  reviewQuestion?: string;
  sourceRef?: {
    sourceId?: string;
    relativePath?: string;
    uri?: string;
    timecode?: string;
    startMs?: number;
    endMs?: number;
    frameId?: string;
  };
};

type SourceManifest = {
  sources: Array<SourceInput & { id: string; metadata?: Record<string, unknown> }>;
};

type UrlMapEntry = {
  sourceId?: string;
  targetId?: string;
  uri?: string;
  url?: string;
  remoteUrl?: string;
  signedUrl?: string;
  fileUrl?: string;
};

type TranscriptSidecarRow = {
  id: string;
  sourceId: string;
  relativePath: string;
  uri?: string;
  sourceType?: SourceType;
  status: "review_required";
};

type AgentReviewTargetRow = {
  id: string;
  targetId: string;
  targetType: PerceptionTargetType;
  sourceId?: string;
  relativePath?: string;
  mediaUri?: string;
  openUri?: string;
  timecode?: string;
  startMs?: number;
  endMs?: number;
  priorityReason?: string;
  reviewQuestion?: string;
  keyframePaths: string[];
  transcriptSidecarRefs: TranscriptSidecarRow[];
  suggestedReview: string;
  status: "agent_review_required";
};

type PreparedTarget = {
  target: TopReviewTarget;
  source?: SourceManifest["sources"][number];
  content: Array<Record<string, unknown>>;
  mediaMode: "remote_url" | "local_image_data_uri" | "local_video_keyframes" | "text_only" | "mock";
  framePaths: string[];
};

type PerceptionBlocker = {
  id: string;
  targetId?: string;
  sourceId?: string;
  severity: "info" | "warning" | "error";
  message: string;
  recovery: string;
};

type ProviderObservationRow = {
  id: string;
  targetId: string;
  sourceId?: string;
  providerId: string;
  model?: string;
  content: string;
  confidence: number;
  confidenceBasis: string;
  usage?: Record<string, unknown>;
  sourceRef?: TopReviewTarget["sourceRef"];
  mediaMode: PreparedTarget["mediaMode"];
  framePaths?: string[];
  createdAt: string;
  status: "candidate_review_required";
};

type ToolResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
};

function writeJson(filePath: string, value: unknown): Promise<void> {
  return fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  return fs.writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
}

function parseJsonl<T>(raw: string, label: string): T[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${label} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function isHttpUrl(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function isOssUrl(uri: string): boolean {
  return /^oss:\/\//i.test(uri);
}

function isDataUri(uri: string): boolean {
  return /^data:/i.test(uri);
}

function sourceRelativePath(source: SourceManifest["sources"][number] | undefined, fallback: string): string {
  return typeof source?.metadata?.relativePath === "string" ? source.metadata.relativePath : source?.uri ? path.basename(source.uri) : fallback;
}

function mediaMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function dataUriForImage(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) throw new Error(`local image exceeds maxLocalImageBytes (${stat.size} > ${maxBytes})`);
  const buffer = await fs.readFile(filePath);
  return `data:${mediaMime(filePath)};base64,${buffer.toString("base64")}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function runTool(command: string, args: string[], timeoutMs = 60000): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const withCode = error as NodeJS.ErrnoException & { code?: string | number | null };
        resolve({
          ok: false,
          stdout,
          stderr,
          error: withCode.code === "ENOENT" ? `${command} not found` : error.message,
        });
        return;
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}

function secondsFromMs(value: number | undefined): number {
  return Math.max(0, (value ?? 0) / 1000);
}

function frameTimesForTarget(target: TopReviewTarget, maxFrames: number): number[] {
  const start = secondsFromMs(target.sourceRef?.startMs);
  const end = secondsFromMs(target.sourceRef?.endMs);
  if (!end || end <= start || maxFrames <= 1) return [start];
  const mid = start + (end - start) / 2;
  const last = Math.max(start, end - 1);
  return [start, mid, last].slice(0, Math.max(1, maxFrames));
}

async function extractVideoFrames(sourceUri: string, target: TopReviewTarget, outputDir: string, maxFrames: number, blockers: PerceptionBlocker[]): Promise<string[]> {
  const frameDir = path.join(outputDir, "agent_review_keyframes");
  await fs.mkdir(frameDir, { recursive: true });
  const framePaths: string[] = [];
  for (const [index, seconds] of frameTimesForTarget(target, maxFrames).entries()) {
    const framePath = path.join(frameDir, `${target.id}_${String(index + 1).padStart(2, "0")}.jpg`);
    const result = await runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", sourceUri, "-frames:v", "1", "-q:v", "3", framePath], 60000);
    if (!result.ok) {
      blockers.push({
        id: `blocker_ffmpeg_${target.id}`,
        targetId: target.id,
        sourceId: target.sourceId,
        severity: "warning",
        message: result.error ?? "ffmpeg failed while extracting an agent-review keyframe.",
        recovery: "Install FFmpeg, provide existing frame sidecars, or rerun with --no-keyframes.",
      });
      break;
    }
    framePaths.push(framePath);
  }
  return framePaths;
}

function defaultPrompt(target: TopReviewTarget): string {
  return [
    "You are an intake perception pass for a local project. Extract only source-linked candidate observations.",
    "Return concise Chinese bullet points when the project material is Chinese.",
    "Focus on visible objects, spatial layout, actions, signage/text, teaching/demo content, and uncertainty.",
    "Do not claim source truth, permissions, or production readiness.",
    `Target: ${target.id} ${target.targetType} ${target.relativePath ?? ""} ${target.sourceRef?.timecode ?? ""}`,
    target.reviewQuestion ? `Review question: ${target.reviewQuestion}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function dashScopeApiKey(options: ProjectPerceptionOptions): string {
  const envName = options.apiKeyEnv ?? "DASHSCOPE_API_KEY";
  const key = process.env[envName] ?? "";
  if (!key.trim()) throw new Error(`DashScope API key is missing. Set ${envName}.`);
  return key.trim();
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function callDashScope(prepared: PreparedTarget, options: ProjectPerceptionOptions): Promise<{ content: string; model: string; usage?: Record<string, unknown>; requestId?: string }> {
  const model = options.model ?? DASHSCOPE_DEFAULT_MODEL;
  const fetchFn = options.fetch ?? fetch;
  const response = await fetchFn(`${normalizeBaseUrl(options.baseUrl ?? DASHSCOPE_DEFAULT_BASE_URL)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${dashScopeApiKey(options)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: prepared.content,
        },
      ],
      temperature: 0,
      max_tokens: 900,
      modalities: ["text"],
    }),
  });
  const raw = await response.text();
  const parsed = JSON.parse(raw) as {
    model?: string;
    request_id?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: Record<string, unknown>;
    error?: { code?: unknown; message?: unknown };
    code?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    const code = String(parsed.error?.code ?? parsed.code ?? "dashscope_http_error");
    const message = String(parsed.error?.message ?? parsed.message ?? `DashScope HTTP ${response.status}`);
    throw new Error(`DashScope request failed (${code}): ${message}`);
  }
  const content = normalizeContent(parsed.choices?.[0]?.message?.content);
  if (!content.trim()) throw new Error("DashScope returned empty content.");
  return {
    content,
    model: String(parsed.model ?? model),
    usage: parsed.usage,
    requestId: parsed.request_id,
  };
}

async function submitParaformerTask(fileUrls: string[], options: ProjectPerceptionOptions): Promise<Record<string, unknown>> {
  const fetchFn = options.fetch ?? fetch;
  const response = await fetchFn("https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${dashScopeApiKey(options)}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model: options.asrModel ?? "paraformer-v2",
      input: { file_urls: fileUrls },
      parameters: {
        language_hints: options.languageHints ?? ["zh", "en"],
        timestamp_alignment_enabled: true,
      },
    }),
  });
  const parsed = JSON.parse(await response.text()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Paraformer task submission failed: ${String(parsed.message ?? response.status)}`);
  return parsed;
}

function observationToAtom(row: ProviderObservationRow, index: number): Record<string, unknown> {
  return {
    id: `perceived_atom_${String(index + 1).padStart(5, "0")}`,
    type: "provider_perception",
    providerObservationId: row.id,
    targetId: row.targetId,
    sourceRef: row.sourceRef,
    content: row.content,
    confidence: row.confidence,
    status: "pending_review",
    links: row.framePaths ?? [],
    reviewQuestion: "Can this provider perception be accepted, edited, or discarded for downstream project planning without overclaiming truth?",
  };
}

async function loadTargets(runDir: string): Promise<{ targets: TopReviewTarget[]; sources: SourceManifest["sources"] }> {
  const targets = parseJsonl<TopReviewTarget>(await fs.readFile(path.join(runDir, "top_review_targets.jsonl"), "utf8"), "top_review_targets.jsonl");
  const sourceManifest = JSON.parse(await fs.readFile(path.join(runDir, "source_manifest.json"), "utf8")) as SourceManifest;
  return { targets, sources: sourceManifest.sources };
}

async function loadUrlMap(urlMapPath: string | undefined): Promise<UrlMapEntry[]> {
  if (!urlMapPath) return [];
  const raw = await fs.readFile(path.resolve(urlMapPath), "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as UrlMapEntry[];
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { urls?: unknown }).urls)) {
      return (parsed as { urls: UrlMapEntry[] }).urls;
    }
    return [parsed as UrlMapEntry];
  } catch {
    return parseJsonl<UrlMapEntry>(trimmed, urlMapPath);
  }
}

function mappedUrl(entry: UrlMapEntry | undefined): string | undefined {
  return entry?.signedUrl ?? entry?.remoteUrl ?? entry?.fileUrl ?? entry?.url ?? entry?.uri;
}

function effectiveUri(target: TopReviewTarget, source: SourceManifest["sources"][number] | undefined, urlMap: UrlMapEntry[]): string {
  const mappedByTarget = mappedUrl(urlMap.find((entry) => entry.targetId === target.id));
  if (mappedByTarget) return mappedByTarget;
  const mappedBySource = mappedUrl(urlMap.find((entry) => target.sourceId && entry.sourceId === target.sourceId));
  if (mappedBySource) return mappedBySource;
  return source?.uri ?? target.sourceRef?.uri ?? target.openUri ?? "";
}

function selectTargets(targets: TopReviewTarget[], options: ProjectPerceptionOptions): TopReviewTarget[] {
  const ids = new Set(options.targetIds ?? []);
  const types = new Set(options.targetTypes ?? ["image", "video_window", "audio", "text_excerpt"]);
  return targets
    .filter((target) => (ids.size > 0 ? ids.has(target.id) : true))
    .filter((target) => types.has(target.targetType))
    .slice(0, options.limit ?? 8);
}

function discoverTranscriptSidecars(sources: SourceManifest["sources"]): TranscriptSidecarRow[] {
  const rows: TranscriptSidecarRow[] = [];
  for (const source of sources) {
    const relativePath = sourceRelativePath(source, source.id);
    const lower = relativePath.toLowerCase();
    const assetRole = source.metadata?.assetRole;
    const looksLikeTranscript =
      assetRole === "derived_sidecar" ||
      /(^|[/._-])(asr|transcript|transcription|subtitle|caption|srt|vtt|字幕|转写|逐字稿)([/._-]|$)/i.test(lower);
    if (!looksLikeTranscript) continue;
    rows.push({
      id: `transcript_sidecar_${String(rows.length + 1).padStart(4, "0")}`,
      sourceId: source.id,
      relativePath,
      uri: source.uri,
      sourceType: source.type,
      status: "review_required",
    });
  }
  return rows;
}

async function buildAgentReviewTargets(
  selectedTargets: TopReviewTarget[],
  sourceById: Map<string, SourceManifest["sources"][number]>,
  urlMap: UrlMapEntry[],
  outputDir: string,
  transcriptSidecars: TranscriptSidecarRow[],
  options: ProjectPerceptionOptions,
  blockers: PerceptionBlocker[],
): Promise<AgentReviewTargetRow[]> {
  const rows: AgentReviewTargetRow[] = [];
  for (const target of selectedTargets) {
    const source = sourceById.get(target.sourceId ?? "");
    const mediaUri = effectiveUri(target, source, urlMap);
    let keyframePaths: string[] = [];
    if (!options.dryRun && options.extractKeyframes !== false && target.targetType === "video_window" && mediaUri && !isHttpUrl(mediaUri) && !isOssUrl(mediaUri) && !isDataUri(mediaUri)) {
      const framePaths = await extractVideoFrames(mediaUri, target, outputDir, options.maxVideoFrames ?? 3, blockers);
      keyframePaths = framePaths.map((framePath) => path.relative(outputDir, framePath));
    }
    rows.push({
      id: `agent_review_target_${String(rows.length + 1).padStart(5, "0")}`,
      targetId: target.id,
      targetType: target.targetType,
      sourceId: target.sourceId,
      relativePath: target.relativePath ?? target.sourceRef?.relativePath ?? sourceRelativePath(source, target.id),
      mediaUri,
      openUri: target.openUri,
      timecode: target.sourceRef?.timecode,
      startMs: target.sourceRef?.startMs,
      endMs: target.sourceRef?.endMs,
      priorityReason: target.priorityReason,
      reviewQuestion: target.reviewQuestion,
      keyframePaths,
      transcriptSidecarRefs: transcriptSidecars.slice(0, 20),
      suggestedReview:
        target.targetType === "video_window"
          ? "Open the source video or extracted keyframes, compare against transcript/ASR sidecars, and keep any observation source-linked."
          : "Open the source locally, compare against transcript/text sidecars if relevant, and keep any observation source-linked.",
      status: "agent_review_required",
    });
  }
  return rows;
}

async function prepareTarget(
  target: TopReviewTarget,
  source: SourceManifest["sources"][number] | undefined,
  urlMap: UrlMapEntry[],
  outputDir: string,
  options: ProjectPerceptionOptions,
  provider: PerceptionProvider,
  blockers: PerceptionBlocker[],
): Promise<PreparedTarget | null> {
  if (provider === "mock") {
    return {
      target,
      source,
      content: [{ type: "text", text: `Mock perception for ${target.id}` }],
      mediaMode: "mock",
      framePaths: [],
    };
  }
  const sourceUri = effectiveUri(target, source, urlMap);
  const prompt = options.prompt ?? defaultPrompt(target);
  if (target.targetType === "image") {
    if (isHttpUrl(sourceUri) || isDataUri(sourceUri)) {
      return {
        target,
        source,
        content: [{ type: "image_url", image_url: { url: sourceUri } }, { type: "text", text: prompt }],
        mediaMode: "remote_url",
        framePaths: [],
      };
    }
    if (!options.allowLocalMedia) {
      blockers.push({
        id: `blocker_local_image_${target.id}`,
        targetId: target.id,
        sourceId: target.sourceId,
        severity: "warning",
        message: "Local image provider perception is blocked until --allow-local-media is passed.",
        recovery: "Let the receiving agent inspect the local image from agent_review_targets.jsonl, or rerun with --allow-local-media for selected files.",
      });
      return null;
    }
    const dataUri = await dataUriForImage(sourceUri, options.maxLocalImageBytes ?? 10 * 1024 * 1024);
    return {
      target,
      source,
      content: [{ type: "image_url", image_url: { url: dataUri } }, { type: "text", text: prompt }],
      mediaMode: "local_image_data_uri",
      framePaths: [],
    };
  }
  if (target.targetType === "video_window") {
    if (isHttpUrl(sourceUri)) {
      return {
        target,
        source,
        content: [{ type: "video_url", video_url: { url: sourceUri }, fps: options.fps ?? 1 }, { type: "text", text: prompt }],
        mediaMode: "remote_url",
        framePaths: [],
      };
    }
    if (!options.allowLocalMedia) {
      blockers.push({
        id: `blocker_local_video_${target.id}`,
        targetId: target.id,
        sourceId: target.sourceId,
        severity: "warning",
        message: "Local video provider perception is blocked until --allow-local-media is passed.",
        recovery: "Prefer agent_review_targets.jsonl for Codex-like multimodal agents, or provide --url-map with reviewed remote URLs for agents/providers that cannot inspect local media.",
      });
      return null;
    }
    const framePaths = await extractVideoFrames(sourceUri, target, outputDir, options.maxVideoFrames ?? 3, blockers);
    if (framePaths.length === 0) return null;
    const frameParts = await Promise.all(
      framePaths.map(async (framePath) => ({
        type: "image_url",
        image_url: { url: await dataUriForImage(framePath, options.maxLocalImageBytes ?? 10 * 1024 * 1024) },
      })),
    );
    return {
      target,
      source,
      content: [...frameParts, { type: "text", text: `${prompt}\nThese images are ordered keyframes from the selected video window, not the full audio track.` }],
      mediaMode: "local_video_keyframes",
      framePaths: framePaths.map((framePath) => path.relative(outputDir, framePath)),
    };
  }
  if (target.targetType === "text_excerpt") {
    return {
      target,
      source,
      content: [{ type: "text", text: `${prompt}\n\nSource pointer: ${sourceRelativePath(source, target.sourceId ?? "source")}` }],
      mediaMode: "text_only",
      framePaths: [],
    };
  }
  blockers.push({
    id: `blocker_unsupported_target_${target.id}`,
    targetId: target.id,
    sourceId: target.sourceId,
    severity: "info",
    message: `Target type '${target.targetType}' is not supported by provider perception.`,
    recovery: "Use image, video_window, or text_excerpt targets.",
  });
  return null;
}

async function maybeSubmitAsr(
  sources: SourceManifest["sources"],
  selectedTargets: TopReviewTarget[],
  urlMap: UrlMapEntry[],
  options: ProjectPerceptionOptions,
  blockers: PerceptionBlocker[],
): Promise<Record<string, unknown>[]> {
  if (!options.asr) return [];
  const bySourceId = new Map(sources.map((source) => [source.id, source]));
  const candidateUrls = selectedTargets
    .filter((target) => target.targetType === "video_window" || target.targetType === "audio")
    .map((target) => effectiveUri(target, bySourceId.get(target.sourceId ?? ""), urlMap))
    .filter((uri, index, list) => uri && list.indexOf(uri) === index);
  const remoteUrls = candidateUrls.filter((uri) => isHttpUrl(uri) || isOssUrl(uri));
  for (const uri of candidateUrls.filter((uri) => !isHttpUrl(uri) && !isOssUrl(uri))) {
    blockers.push({
      id: `blocker_paraformer_local_${hashText(uri)}`,
      severity: "warning",
      message: "Paraformer ASR REST submission needs an HTTP(S) or OSS URL; it cannot consume this local file path directly.",
      recovery: "Use existing transcript sidecars, upload the audio/video to reviewed OSS/HTTPS storage, then rerun with --url-map urls.jsonl.",
    });
  }
  if (remoteUrls.length === 0) return [];
  const response = await submitParaformerTask(remoteUrls, options);
  return [
    {
      schema: "mmi.gateway.asr_task",
      schemaVersion: "1.0.0",
      gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
      providerId: "dashscope",
      model: options.asrModel ?? "paraformer-v2",
      fileUrls: remoteUrls,
      response,
      status: "submitted",
    },
  ];
}

function perceptionStatus(options: ProjectPerceptionOptions, blockers: PerceptionBlocker[], observations: ProviderObservationRow[], asrTasks: Record<string, unknown>[]): string {
  if (options.dryRun) return "dry_run_plan";
  if (blockers.some((blocker) => blocker.severity === "error")) return "perception_needs_attention";
  if (observations.length > 0 || asrTasks.length > 0) return blockers.length > 0 ? "provider_assisted_with_blockers" : "provider_assisted_review_required";
  return blockers.length > 0 ? "agent_review_bundle_ready_with_blockers" : "agent_review_bundle_ready";
}

export async function runProjectPerception(runDir: string, options: ProjectPerceptionOptions = {}): Promise<Record<string, unknown>> {
  const root = path.resolve(runDir);
  const outputDir = path.resolve(options.outputDir ?? path.join(root, "perception"));
  await fs.mkdir(outputDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const visualProvider = options.visualProvider ?? options.provider;
  const { targets, sources } = await loadTargets(root);
  const selectedTargets = selectTargets(targets, options);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const urlMap = await loadUrlMap(options.urlMapPath);
  const blockers: PerceptionBlocker[] = [];
  const transcriptSidecars = discoverTranscriptSidecars(sources);
  const agentReviewTargets = await buildAgentReviewTargets(selectedTargets, sourceById, urlMap, outputDir, transcriptSidecars, options, blockers);
  const preparedTargets: PreparedTarget[] = [];
  if (visualProvider) {
    for (const target of selectedTargets) {
      try {
        const prepared = await prepareTarget(target, sourceById.get(target.sourceId ?? ""), urlMap, outputDir, options, visualProvider, blockers);
        if (prepared) preparedTargets.push(prepared);
      } catch (error) {
        blockers.push({
          id: `blocker_prepare_${target.id}`,
          targetId: target.id,
          sourceId: target.sourceId,
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
          recovery: "Use the agent-review bundle, choose a smaller target, provide a reviewed remote URL, or raise the explicit local media byte limit.",
        });
      }
    }
  }
  const asrTasks = options.dryRun ? [] : await maybeSubmitAsr(sources, selectedTargets, urlMap, options, blockers);
  const observations: ProviderObservationRow[] = [];
  if (visualProvider && !options.dryRun) {
    for (const [index, prepared] of preparedTargets.entries()) {
      try {
        const result =
          visualProvider === "mock"
            ? { content: `Mock provider perception for ${prepared.target.id}: ${prepared.target.relativePath ?? prepared.target.sourceId ?? "source"}`, model: "mock-perception", usage: {} }
            : await callDashScope(prepared, options);
        observations.push({
          id: `provider_observation_${String(index + 1).padStart(5, "0")}`,
          targetId: prepared.target.id,
          sourceId: prepared.target.sourceId,
          providerId: visualProvider,
          model: result.model,
          content: result.content,
          confidence: 0.5,
          confidenceBasis: "Provider perception over selected MMI intake targets; human review required.",
          usage: result.usage,
          sourceRef: prepared.target.sourceRef,
          mediaMode: prepared.mediaMode,
          framePaths: prepared.framePaths,
          createdAt,
          status: "candidate_review_required",
        });
      } catch (error) {
        blockers.push({
          id: `blocker_provider_${prepared.target.id}`,
          targetId: prepared.target.id,
          sourceId: prepared.target.sourceId,
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          recovery: "Check provider credentials, model availability, media URL accessibility, and target size; then rerun with a smaller selected target set.",
        });
      }
    }
  }
  const atoms = observations.map(observationToAtom);
  const reviewQueue = atoms.map((atom, index) => ({
    id: `perception_review_${String(index + 1).padStart(5, "0")}`,
    targetAtomId: atom.id,
    targetId: atom.targetId,
    status: "pending",
    action: "accept_edit_or_discard",
    decision: null,
    reviewerNote: null,
    question: atom.reviewQuestion,
    sourceRef: atom.sourceRef,
  }));
  const manifest = {
    schema: "mmi.gateway.perception_manifest",
    schemaVersion: "1.0.0",
    gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
    createdAt,
    runDir: root,
    outputDir,
    status: perceptionStatus(options, blockers, observations, asrTasks),
    mode: visualProvider ? "provider_assisted_optional_visual" : "agent_review_first",
    visualProvider: visualProvider ?? null,
    model: visualProvider === "dashscope" ? options.model ?? DASHSCOPE_DEFAULT_MODEL : visualProvider === "mock" ? "mock-perception" : null,
    options: {
      allowLocalMedia: options.allowLocalMedia === true,
      limit: options.limit ?? 8,
      targetTypes: options.targetTypes ?? ["image", "video_window", "audio", "text_excerpt"],
      maxVideoFrames: options.maxVideoFrames ?? 3,
      extractKeyframes: options.extractKeyframes !== false,
      asr: options.asr === true,
      dryRun: options.dryRun === true,
      urlMapProvided: Boolean(options.urlMapPath),
    },
    entrypoints: {
      agentReviewTargets: "agent_review_targets.jsonl",
      transcriptSidecars: "transcript_sidecars.jsonl",
      providerObservations: "provider_observations.jsonl",
      perceivedAtoms: "perceived_atoms.ndjson",
      perceptionReviewQueue: "perception_review_queue.jsonl",
      blockers: "perception_blockers.json",
      asrTasks: "asr_tasks.jsonl",
    },
    counts: {
      selectedTargets: selectedTargets.length,
      agentReviewTargets: agentReviewTargets.length,
      transcriptSidecars: transcriptSidecars.length,
      preparedProviderTargets: preparedTargets.length,
      observations: observations.length,
      perceivedAtoms: atoms.length,
      blockers: blockers.length,
      asrTasks: asrTasks.length,
    },
    boundary: {
      candidateOnly: true,
      reviewRequired: true,
      canonicalPacketMutated: false,
      defaultVisualApiUpload: false,
      localMediaSentOnlyWhenAllowed: options.allowLocalMedia === true && Boolean(visualProvider),
      providerVisualIsOptionalFallback: true,
      nonClaims: [...REQUIRED_NON_CLAIMS],
    },
  };
  const files = [
    path.join(outputDir, "perception_manifest.json"),
    path.join(outputDir, "agent_review_targets.jsonl"),
    path.join(outputDir, "transcript_sidecars.jsonl"),
    path.join(outputDir, "provider_observations.jsonl"),
    path.join(outputDir, "perceived_atoms.ndjson"),
    path.join(outputDir, "perception_review_queue.jsonl"),
    path.join(outputDir, "perception_blockers.json"),
    path.join(outputDir, "asr_tasks.jsonl"),
  ];
  await writeJson(files[0], manifest);
  await writeJsonl(files[1], agentReviewTargets);
  await writeJsonl(files[2], transcriptSidecars);
  await writeJsonl(files[3], observations);
  await writeJsonl(files[4], atoms);
  await writeJsonl(files[5], reviewQueue);
  await writeJson(files[6], { schema: "mmi.gateway.perception_blockers", schemaVersion: "1.0.0", gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION, blockers });
  await writeJsonl(files[7], asrTasks);
  return {
    ...manifest,
    selectedTargets: selectedTargets.map((target) => ({
      id: target.id,
      targetType: target.targetType,
      sourceId: target.sourceId,
      relativePath: target.relativePath,
      timecode: target.sourceRef?.timecode,
    })),
    filesWritten: files,
  };
}
