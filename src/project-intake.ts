import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MMI_GATEWAY_PACKAGE_VERSION, REQUIRED_NON_CLAIMS, type SourceInput, type SourceType } from "./types.ts";
import type { DiscoveredSource, DiscoverySkippedItem, ProjectDiscoveryResult, ProjectSourceAssetRole, ProjectSourceOriginKind } from "./source-discovery.ts";

export type ProjectIntakeProfile = "creative-project" | "creative_project_foundation" | "field-video-project-base" | "visual-asset-library-only";

export type ProjectIntakeOptions = {
  profile?: ProjectIntakeProfile;
  outputDir: string;
  extractKeyframes?: boolean;
  extractAudio?: boolean;
  maxVideoWindows?: number;
  maxKeyframes?: number;
  maxAudioSeconds?: number;
  noTruthPromotion?: boolean;
};

type ToolResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number | null;
  error?: string;
};

type LocalBlocker = {
  id: string;
  severity: "info" | "warning" | "error";
  sourceId?: string;
  sourcePath?: string;
  message: string;
  recovery: string;
};

type VisualAsset = {
  id: string;
  sourceId: string;
  relativePath: string;
  uri: string;
  previewUri: string;
  sizeBytes: number;
  extension: string;
  originKind: ProjectSourceOriginKind;
  assetRole: ProjectSourceAssetRole;
  priorityReason: string;
  width?: number;
  height?: number;
  groupId: string;
  priorityRank: number;
  reviewStatus: "pending_review";
};

type VideoWindow = {
  id: string;
  sourceId: string;
  relativePath: string;
  startMs?: number;
  endMs?: number;
  timecode: string;
  keyframePath?: string;
  keyframeUri?: string;
  audioStatus: "not_applicable" | "scaffold_only" | "extracted" | "blocked";
  asrStatus: "not_configured" | "blocked_provider_perception_route";
  reviewQuestion: string;
  reviewStatus: "pending_review";
};

type VideoMatrixItem = {
  sourceId: string;
  relativePath: string;
  uri: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  codec?: string;
  probeStatus: "ok" | "blocked";
  windows: VideoWindow[];
};

type ProjectAtom = {
  id: string;
  type: "text_excerpt" | "visual_asset_candidate" | "video_window_candidate" | "audio_candidate" | "term_candidate" | "blocker";
  content: string;
  sourceRef: {
    sourceId?: string;
    relativePath?: string;
    uri?: string;
    timecode?: string;
    startMs?: number;
    endMs?: number;
    lineStart?: number;
    lineEnd?: number;
    frameId?: string;
  };
  confidence: "low" | "medium" | "high";
  status: "pending_review" | "blocked";
  links: string[];
  reviewQuestion: string;
};

type TopReviewTarget = {
  id: string;
  rank: number;
  targetType: "image" | "video_window" | "text_excerpt" | "blocker";
  priorityReason: string;
  sourceType?: SourceType;
  sourceId?: string;
  relativePath?: string;
  openUri?: string;
  targetAtomId?: string;
  reviewQuestion: string;
  sourceRef?: ProjectAtom["sourceRef"];
};

function writeJson(filePath: string, value: unknown): Promise<void> {
  return fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  return fs.writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
}

function runTool(command: string, args: string[], timeoutMs = 20000): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const withCode = error as NodeJS.ErrnoException & { code?: string | number | null };
        resolve({
          ok: false,
          stdout,
          stderr,
          code: typeof withCode.code === "number" ? withCode.code : undefined,
          error: withCode.code === "ENOENT" ? `${command} not found` : error.message,
        });
        return;
      }
      resolve({ ok: true, stdout, stderr, code: 0 });
    });
  });
}

function formatTimecode(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((item) => String(item).padStart(2, "0")).join(":");
}

function fileUrl(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

function parseImageSize(buffer: Buffer): { width?: number; height?: number } {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return {};
}

async function imageDimensions(filePath: string): Promise<{ width?: number; height?: number }> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseImageSize(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function sourceRelativePath(source: DiscoveredSource): string {
  return typeof source.metadata.relativePath === "string" ? source.metadata.relativePath : path.basename(source.uri);
}

function sourceOriginKind(source: DiscoveredSource): ProjectSourceOriginKind {
  const value = source.metadata.originKind;
  return value === "raw" || value === "derived" || value === "generated" || value === "project_note" || value === "unknown" ? value : "unknown";
}

function sourceAssetRole(source: DiscoveredSource): ProjectSourceAssetRole {
  const value = source.metadata.assetRole;
  return value === "raw_capture" || value === "original_media" || value === "derived_frame" || value === "derived_sidecar" || value === "generated_artifact" || value === "project_note" || value === "unknown"
    ? value
    : "unknown";
}

function sourceAssetRoleReason(source: DiscoveredSource): string {
  return typeof source.metadata.assetRoleReason === "string" ? source.metadata.assetRoleReason : "unclassified_project_source";
}

function sourceClassificationCounts(sources: DiscoveredSource[]): Record<string, number> {
  return sources.reduce<Record<string, number>>((counts, source) => {
    const role = sourceAssetRole(source);
    counts[role] = (counts[role] ?? 0) + 1;
    return counts;
  }, {});
}

function transcriptSidecars(sources: DiscoveredSource[]): DiscoveredSource[] {
  return sources.filter((source) => sourceAssetRole(source) === "derived_sidecar");
}

function visualRoleScore(asset: Pick<VisualAsset, "originKind" | "assetRole" | "sizeBytes" | "relativePath">): number {
  if (asset.assetRole === "raw_capture") return 0;
  if (asset.originKind === "raw") return 1;
  if (asset.assetRole === "unknown") return 2;
  if (asset.assetRole === "derived_frame") return 3;
  if (asset.originKind === "derived") return 4;
  if (asset.originKind === "generated") return 5;
  return 6;
}

function compareVisualAssets(a: VisualAsset, b: VisualAsset): number {
  const roleDelta = visualRoleScore(a) - visualRoleScore(b);
  if (roleDelta !== 0) return roleDelta;
  const sizeDelta = b.sizeBytes - a.sizeBytes;
  if (sizeDelta !== 0) return sizeDelta;
  return a.relativePath.localeCompare(b.relativePath);
}

async function buildVisualAssets(sources: DiscoveredSource[]): Promise<VisualAsset[]> {
  const images = sources.filter((source) => source.type === "image");
  const assets: VisualAsset[] = [];
  for (const [index, source] of images.entries()) {
    const dimensions = await imageDimensions(source.uri).catch(() => ({}));
    const relativePath = sourceRelativePath(source);
    const groupBase = path.dirname(relativePath) === "." ? "root" : path.dirname(relativePath).replace(/[^a-zA-Z0-9]+/g, "_");
    const groupId = `visual_group_${groupBase || "root"}`;
    assets.push({
      id: `photo_${String(index + 1).padStart(4, "0")}`,
      sourceId: source.id,
      relativePath,
      uri: source.uri,
      previewUri: fileUrl(source.uri),
      sizeBytes: Number(source.metadata.sizeBytes ?? 0),
      extension: String(source.metadata.extension ?? path.extname(source.uri).toLowerCase()),
      originKind: sourceOriginKind(source),
      assetRole: sourceAssetRole(source),
      priorityReason: sourceAssetRoleReason(source),
      ...dimensions,
      groupId,
      priorityRank: index + 1,
      reviewStatus: "pending_review",
    });
  }
  return assets.sort(compareVisualAssets).map((asset, index) => ({
    ...asset,
    id: `photo_${String(index + 1).padStart(4, "0")}`,
    priorityRank: index + 1,
  }));
}

function videoStreamFromProbe(value: unknown): Record<string, unknown> | undefined {
  const streams = typeof value === "object" && value !== null && Array.isArray((value as { streams?: unknown[] }).streams) ? (value as { streams: unknown[] }).streams : [];
  return streams.find((stream): stream is Record<string, unknown> => typeof stream === "object" && stream !== null && (stream as { codec_type?: unknown }).codec_type === "video");
}

function durationFromProbe(value: unknown): number | undefined {
  const format = typeof value === "object" && value !== null ? (value as { format?: { duration?: unknown } }).format : undefined;
  const duration = Number(format?.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const stream = videoStreamFromProbe(value);
  const streamDuration = Number(stream?.duration);
  return Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : undefined;
}

function buildWindows(source: DiscoveredSource, durationSeconds: number | undefined, maxWindows: number): VideoWindow[] {
  const relativePath = sourceRelativePath(source);
  if (!durationSeconds || durationSeconds <= 0) {
    return [
      {
        id: `${source.id}_window_001`,
        sourceId: source.id,
        relativePath,
        timecode: "whole_source",
        audioStatus: "scaffold_only",
        asrStatus: "not_configured",
        reviewQuestion: "Review this local video manually; duration metadata was unavailable.",
        reviewStatus: "pending_review",
      },
    ];
  }
  const windowCount = Math.max(1, Math.min(maxWindows, Math.ceil(durationSeconds / 60)));
  const step = durationSeconds / windowCount;
  return Array.from({ length: windowCount }, (_, index) => {
    const startMs = Math.floor(index * step * 1000);
    const endMs = Math.floor(Math.min(durationSeconds, (index + 1) * step) * 1000);
    return {
      id: `${source.id}_window_${String(index + 1).padStart(3, "0")}`,
      sourceId: source.id,
      relativePath,
      startMs,
      endMs,
      timecode: `${formatTimecode(startMs)}-${formatTimecode(endMs)}`,
      audioStatus: "scaffold_only",
      asrStatus: "not_configured",
      reviewQuestion: "Does this window contain project-relevant objects, speech, movement, or context?",
      reviewStatus: "pending_review",
    };
  });
}

async function probeVideo(source: DiscoveredSource, blockers: LocalBlocker[]): Promise<{ raw?: unknown; durationSeconds?: number; width?: number; height?: number; codec?: string; status: "ok" | "blocked" }> {
  const result = await runTool("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", source.uri]);
  if (!result.ok) {
    blockers.push({
      id: `blocker_ffprobe_${source.id}`,
      severity: "warning",
      sourceId: source.id,
      sourcePath: sourceRelativePath(source),
      message: result.error ?? "ffprobe failed while reading video metadata.",
      recovery: "Install FFmpeg/ffprobe or review the video manually; MMI still writes a review window scaffold.",
    });
    return { status: "blocked" };
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  const stream = videoStreamFromProbe(parsed);
  return {
    raw: parsed,
    durationSeconds: durationFromProbe(parsed),
    width: typeof stream?.width === "number" ? stream.width : undefined,
    height: typeof stream?.height === "number" ? stream.height : undefined,
    codec: typeof stream?.codec_name === "string" ? stream.codec_name : undefined,
    status: "ok",
  };
}

async function extractKeyframes(source: DiscoveredSource, windows: VideoWindow[], outputDir: string, maxKeyframes: number, blockers: LocalBlocker[]): Promise<void> {
  const keyframeDir = path.join(outputDir, "keyframes");
  await fs.mkdir(keyframeDir, { recursive: true });
  for (const window of windows.slice(0, maxKeyframes)) {
    const startSeconds = window.startMs !== undefined ? Math.max(0, window.startMs / 1000) : 0;
    const framePath = path.join(keyframeDir, `${window.id}.jpg`);
    const result = await runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(startSeconds), "-i", source.uri, "-frames:v", "1", "-q:v", "3", framePath], 30000);
    if (!result.ok) {
      blockers.push({
        id: `blocker_ffmpeg_keyframe_${window.id}`,
        severity: "warning",
        sourceId: source.id,
        sourcePath: sourceRelativePath(source),
        message: result.error ?? "ffmpeg failed while extracting a keyframe.",
        recovery: "Install FFmpeg or rerun without keyframe extraction; review the source video manually.",
      });
      return;
    }
    window.keyframePath = path.relative(outputDir, framePath);
    window.keyframeUri = fileUrl(framePath);
  }
}

async function extractAudioPreview(source: DiscoveredSource, outputDir: string, maxAudioSeconds: number, blockers: LocalBlocker[]): Promise<string | undefined> {
  const audioDir = path.join(outputDir, "audio");
  await fs.mkdir(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, `${source.id}.wav`);
  const result = await runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source.uri, "-vn", "-ac", "1", "-ar", "16000", "-t", String(maxAudioSeconds), audioPath], 60000);
  if (!result.ok) {
    blockers.push({
      id: `blocker_ffmpeg_audio_${source.id}`,
      severity: "warning",
      sourceId: source.id,
      sourcePath: sourceRelativePath(source),
      message: result.error ?? "ffmpeg failed while extracting audio.",
      recovery: "Install FFmpeg or provide a transcript/audio sidecar manually.",
    });
    return undefined;
  }
  return path.relative(outputDir, audioPath);
}

async function buildVideoMatrix(sources: DiscoveredSource[], outputDir: string, options: ProjectIntakeOptions, blockers: LocalBlocker[]): Promise<VideoMatrixItem[]> {
  const videos = sources.filter((source) => source.type === "video");
  const matrix: VideoMatrixItem[] = [];
  for (const source of videos) {
    const probe = await probeVideo(source, blockers);
    const windows = buildWindows(source, probe.durationSeconds, options.maxVideoWindows ?? 12);
    if (options.extractKeyframes !== false) await extractKeyframes(source, windows, outputDir, options.maxKeyframes ?? 8, blockers);
    if (options.extractAudio) {
      const audioPath = await extractAudioPreview(source, outputDir, options.maxAudioSeconds ?? 600, blockers);
      for (const window of windows) window.audioStatus = audioPath ? "extracted" : "blocked";
    }
    matrix.push({
      sourceId: source.id,
      relativePath: sourceRelativePath(source),
      uri: source.uri,
      durationSeconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      codec: probe.codec,
      probeStatus: probe.status,
      windows,
    });
  }
  return matrix;
}

function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(/[\p{Script=Han}]{2,12}/gu)) terms.add(match[0]);
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) terms.add(match[0].toLowerCase());
  return [...terms].slice(0, 80);
}

function termsFromSource(source: DiscoveredSource): string[] {
  const relative = sourceRelativePath(source);
  const nameText = path.basename(relative, path.extname(relative)).replace(/[_-]+/g, " ");
  return extractTerms(`${nameText}\n${source.text ?? ""}`);
}

function textAtomsFromSource(source: DiscoveredSource, startIndex: number): ProjectAtom[] {
  if (!source.text?.trim()) return [];
  const lines = source.text.split(/\r?\n/);
  const atoms: ProjectAtom[] = [];
  let paragraph: string[] = [];
  let paragraphStart = 1;
  const flush = (lineEnd: number) => {
    const content = paragraph.join("\n").trim();
    if (!content) return;
    atoms.push({
      id: `atom_${String(startIndex + atoms.length).padStart(5, "0")}`,
      type: "text_excerpt",
      content: content.slice(0, 1200),
      sourceRef: { sourceId: source.id, relativePath: sourceRelativePath(source), uri: source.uri, lineStart: paragraphStart, lineEnd },
      confidence: "medium",
      status: "pending_review",
      links: [],
      reviewQuestion: "Can this text excerpt support the project foundation candidate after review?",
    });
  };
  lines.forEach((line, index) => {
    if (!line.trim()) {
      flush(index);
      paragraph = [];
      paragraphStart = index + 2;
      return;
    }
    if (paragraph.length === 0) paragraphStart = index + 1;
    paragraph.push(line);
  });
  flush(lines.length);
  return atoms.slice(0, 12);
}

function buildProjectAtoms(sources: DiscoveredSource[], visualAssets: VisualAsset[], videoMatrix: VideoMatrixItem[], blockers: LocalBlocker[]): ProjectAtom[] {
  const atoms: ProjectAtom[] = [];
  for (const source of sources) {
    if (source.text?.trim()) atoms.push(...textAtomsFromSource(source, atoms.length + 1));
  }
  for (const asset of visualAssets) {
    atoms.push({
      id: `atom_${String(atoms.length + 1).padStart(5, "0")}`,
      type: "visual_asset_candidate",
      content: `Image asset pending visual review: ${asset.relativePath}`,
      sourceRef: { sourceId: asset.sourceId, relativePath: asset.relativePath, uri: asset.uri, frameId: asset.id },
      confidence: "low",
      status: "pending_review",
      links: [asset.id, asset.groupId],
      reviewQuestion: "What visible objects, spatial context, permissions, and crop/no-use constraints should be recorded for this image?",
    });
  }
  for (const video of videoMatrix) {
    for (const window of video.windows) {
      atoms.push({
        id: `atom_${String(atoms.length + 1).padStart(5, "0")}`,
        type: "video_window_candidate",
        content: `Video window pending review: ${video.relativePath} ${window.timecode}`,
        sourceRef: {
          sourceId: video.sourceId,
          relativePath: video.relativePath,
          uri: video.uri,
          timecode: window.timecode,
          startMs: window.startMs,
          endMs: window.endMs,
          frameId: window.keyframePath,
        },
        confidence: window.keyframePath ? "medium" : "low",
        status: "pending_review",
        links: window.keyframePath ? [window.keyframePath] : [],
        reviewQuestion: window.reviewQuestion,
      });
    }
  }
  for (const blocker of blockers) {
    atoms.push({
      id: `atom_${String(atoms.length + 1).padStart(5, "0")}`,
      type: "blocker",
      content: blocker.message,
      sourceRef: { sourceId: blocker.sourceId, relativePath: blocker.sourcePath },
      confidence: "high",
      status: "blocked",
      links: [],
      reviewQuestion: blocker.recovery,
    });
  }
  return atoms;
}

function buildObjectLedger(sources: DiscoveredSource[], visualAssets: VisualAsset[], videoMatrix: VideoMatrixItem[]): Array<Record<string, unknown>> {
  const byTerm = new Map<string, { refs: Array<Record<string, unknown>>; evidenceWeights: string[] }>();
  for (const source of sources) {
    for (const term of termsFromSource(source)) {
      const item = byTerm.get(term) ?? { refs: [], evidenceWeights: [] };
      item.refs.push({ sourceId: source.id, relativePath: sourceRelativePath(source), sourceType: source.type });
      item.evidenceWeights.push(source.type === "image" ? "photo_first" : source.type === "video" ? "video_supporting" : "text_supporting");
      byTerm.set(term, item);
    }
  }
  for (const asset of visualAssets) {
    const item = byTerm.get(asset.groupId) ?? { refs: [], evidenceWeights: [] };
    item.refs.push({ sourceId: asset.sourceId, photoId: asset.id, relativePath: asset.relativePath });
    item.evidenceWeights.push("photo_first");
    byTerm.set(asset.groupId, item);
  }
  for (const video of videoMatrix) {
    for (const window of video.windows.slice(0, 4)) {
      const key = path.basename(video.relativePath, path.extname(video.relativePath)).toLowerCase() || "video_window";
      const item = byTerm.get(key) ?? { refs: [], evidenceWeights: [] };
      item.refs.push({ sourceId: video.sourceId, timecode: window.timecode, keyframePath: window.keyframePath });
      item.evidenceWeights.push("video_supporting");
      byTerm.set(key, item);
    }
  }
  return [...byTerm.entries()].slice(0, 200).map(([term, item], index) => ({
    id: `object_candidate_${String(index + 1).padStart(4, "0")}`,
    label: term,
    status: "pending_review",
    refs: item.refs,
    evidenceWeights: [...new Set(item.evidenceWeights)],
    reviewQuestion: "Is this a real project-relevant object, term, person/place label, or just a filename artifact?",
  }));
}

function buildTermQueue(sources: DiscoveredSource[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const term of termsFromSource(source)) {
      if (seen.has(term)) continue;
      seen.add(term);
      rows.push({
        id: `term_${String(rows.length + 1).padStart(4, "0")}`,
        candidateTerm: term,
        sourceRefs: [{ sourceId: source.id, relativePath: sourceRelativePath(source) }],
        correctedTerm: null,
        status: "pending_review",
        note: source.type === "audio" || source.type === "video" ? "ASR/visual confirmation recommended." : "Confirm spelling and project meaning.",
      });
    }
  }
  return rows.slice(0, 120);
}

function reviewQueueFromAtoms(atoms: ProjectAtom[]): Array<Record<string, unknown>> {
  return atoms.map((atom, index) => ({
    id: `review_project_${String(index + 1).padStart(5, "0")}`,
    targetAtomId: atom.id,
    status: atom.status === "blocked" ? "blocked" : "pending",
    action: atom.status === "blocked" ? "resolve_or_accept_blocker" : "accept_edit_or_discard",
    decision: null,
    decisionSchema: "accept|edit|discard|defer",
    editedContent: null,
    reviewerNote: null,
    correctedLabel: null,
    rightsStatus: "not_reviewed",
    nextAction: atom.status === "blocked" ? "resolve_blocker_or_defer" : "accept_edit_discard_or_defer",
    question: atom.reviewQuestion,
    sourceRef: atom.sourceRef,
  }));
}

function reviewDecisionTemplate(reviewQueue: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return reviewQueue.map((item) => ({
    reviewItemId: item.id,
    targetAtomId: item.targetAtomId,
    decision: null,
    editedContent: null,
    reviewerNote: null,
    correctedLabel: null,
    rightsStatus: "not_reviewed",
    nextAction: null,
  }));
}

function buildTopReviewTargets(visualAssets: VisualAsset[], videoMatrix: VideoMatrixItem[], atoms: ProjectAtom[], blockers: LocalBlocker[]): TopReviewTarget[] {
  const targets: TopReviewTarget[] = [];
  for (const asset of visualAssets.slice(0, 18)) {
    targets.push({
      id: `target_${String(targets.length + 1).padStart(4, "0")}`,
      rank: targets.length + 1,
      targetType: "image",
      sourceType: "image",
      sourceId: asset.sourceId,
      relativePath: asset.relativePath,
      openUri: asset.previewUri,
      priorityReason: `visual_priority:${asset.assetRole}:${asset.priorityReason}`,
      reviewQuestion: "Record visible objects, spatial context, rights/no-use constraints, and whether this raw visual asset should anchor the project foundation.",
      sourceRef: { sourceId: asset.sourceId, relativePath: asset.relativePath, uri: asset.uri, frameId: asset.id },
    });
  }
  const videoWindows = videoMatrix.flatMap((video) =>
    video.windows.slice(0, 6).map((window) => ({
      video,
      window,
    })),
  );
  for (const { video, window } of videoWindows.slice(0, 12)) {
    targets.push({
      id: `target_${String(targets.length + 1).padStart(4, "0")}`,
      rank: targets.length + 1,
      targetType: "video_window",
      sourceType: "video",
      sourceId: video.sourceId,
      relativePath: video.relativePath,
      openUri: video.uri,
      priorityReason: window.keyframePath ? "video_window_with_local_keyframe" : "original_video_window_scaffold",
      reviewQuestion: window.reviewQuestion,
      sourceRef: { sourceId: video.sourceId, relativePath: video.relativePath, uri: video.uri, timecode: window.timecode, startMs: window.startMs, endMs: window.endMs, frameId: window.keyframePath },
    });
  }
  for (const atom of atoms.filter((item) => item.type === "text_excerpt").slice(0, 12)) {
    targets.push({
      id: `target_${String(targets.length + 1).padStart(4, "0")}`,
      rank: targets.length + 1,
      targetType: "text_excerpt",
      sourceType: "document",
      sourceId: atom.sourceRef.sourceId,
      relativePath: atom.sourceRef.relativePath,
      openUri: atom.sourceRef.uri,
      targetAtomId: atom.id,
      priorityReason: "first_project_text_excerpt",
      reviewQuestion: atom.reviewQuestion,
      sourceRef: atom.sourceRef,
    });
  }
  for (const blocker of blockers) {
    targets.push({
      id: `target_${String(targets.length + 1).padStart(4, "0")}`,
      rank: targets.length + 1,
      targetType: "blocker",
      sourceId: blocker.sourceId,
      relativePath: blocker.sourcePath,
      priorityReason: `blocker:${blocker.severity}`,
      reviewQuestion: blocker.recovery,
      sourceRef: { sourceId: blocker.sourceId, relativePath: blocker.sourcePath },
    });
  }
  return targets.slice(0, 50).map((target, index) => ({ ...target, rank: index + 1 }));
}

function providerWindowManifest(videoMatrix: VideoMatrixItem[]): Record<string, unknown> {
  const windows = videoMatrix.flatMap((video) =>
    video.windows.slice(0, 8).map((window) => ({
      sourceId: video.sourceId,
      relativePath: video.relativePath,
      timecode: window.timecode,
      keyframePath: window.keyframePath,
      providerStatus: "blocked_provider_perception_route",
      reason: "Local private media is not uploaded automatically. Provide a public or signed URL and select only reviewed windows.",
    })),
  );
  return {
    schema: "mmi.gateway.provider_window_manifest",
    schemaVersion: "1.0.0",
    status: "blocked_provider_perception_route",
    windows,
  };
}

function projectFoundationCandidate(discovery: ProjectDiscoveryResult, visualAssets: VisualAsset[], videoMatrix: VideoMatrixItem[], atoms: ProjectAtom[], blockers: LocalBlocker[]): Record<string, unknown> {
  const projectName = path.basename(discovery.root);
  return {
    schema: "mmi.gateway.project_foundation_candidate",
    schemaVersion: "1.0.0",
    gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
    status: "candidate_review_required",
    projectIdentityCandidates: [{ label: projectName, source: "folder_name", confidence: "low", reviewStatus: "pending_review" }],
    materialTypes: discovery.counts,
    sourceInventory: discovery.sources.map((source) => ({
      sourceId: source.id,
      type: source.type,
      relativePath: sourceRelativePath(source),
      privacy: source.privacy,
      rights: source.rights,
    })),
    firstReviewTargets: {
      images: visualAssets.slice(0, 12).map((asset) => ({
        photoId: asset.id,
        sourceId: asset.sourceId,
        relativePath: asset.relativePath,
        assetRole: asset.assetRole,
        priorityReason: asset.priorityReason,
      })),
      videoWindows: videoMatrix.flatMap((video) => video.windows.slice(0, 4).map((window) => ({ sourceId: video.sourceId, relativePath: video.relativePath, timecode: window.timecode, keyframePath: window.keyframePath }))).slice(0, 12),
      atoms: atoms.slice(0, 20).map((atom) => atom.id),
    },
    openQuestions: [
      "Which assets are cleared for downstream use?",
      "Which visible objects or terms are project-critical?",
      "Which local video windows deserve provider or human review next?",
      "Which candidate atoms should be accepted, edited, or discarded?",
    ],
    blockers: blockers.map((blocker) => ({ id: blocker.id, severity: blocker.severity, message: blocker.message, recovery: blocker.recovery, sourceId: blocker.sourceId })),
    nonClaims: [...REQUIRED_NON_CLAIMS],
  };
}

function visualContactSheet(visualAssets: VisualAsset[]): string {
  const cards = visualAssets
    .slice(0, 240)
    .map(
      (asset) => `<figure>
  <a href="${asset.previewUri}"><img src="${asset.previewUri}" alt="${asset.relativePath}"></a>
  <figcaption><strong>${asset.id}</strong> <span>${asset.assetRole}</span><br>${asset.relativePath}<br>${asset.width ?? "?"} x ${asset.height ?? "?"}<br>${asset.priorityReason}</figcaption>
</figure>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>MMI Visual Contact Sheet</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #1f2937; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
    figure { margin: 0; border: 1px solid #d1d5db; padding: 8px; border-radius: 6px; background: #fff; }
    img { width: 100%; height: 140px; object-fit: contain; background: #f3f4f6; }
    span { display: inline-block; padding: 1px 5px; border-radius: 4px; background: #eef2ff; color: #3730a3; font-size: 11px; }
    figcaption { margin-top: 8px; font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <h1>MMI Visual Contact Sheet</h1>
  <p>Candidate-only visual review surface. These previews are local file references, not usage permission.</p>
  <div class="grid">
${cards}
  </div>
</body>
</html>
`;
}

function blockerReport(blockers: LocalBlocker[], skipped: DiscoverySkippedItem[]): string {
  const blockerLines =
    blockers.length === 0
      ? "- No local perception blockers were reported."
      : blockers.map((blocker) => `- ${blocker.severity}: ${blocker.message}${blocker.sourcePath ? ` (${blocker.sourcePath})` : ""}\n  Recovery: ${blocker.recovery}`).join("\n");
  const skippedLines =
    skipped.length === 0
      ? "- No files were skipped."
      : skipped
          .filter((item) => item.reason !== "ignored_dir")
          .slice(0, 120)
          .map((item) => `- ${item.reason}: ${item.path}${item.detail ? ` (${item.detail})` : ""}`)
          .join("\n") || "- Only ignored maintenance directories were skipped.";
  return `# MMI Gap And Blocker Report

Status: candidate-only, review required.

## Local Perception Blockers

${blockerLines}

## Skipped Files

${skippedLines}

## Provider Boundary

- Local private media was not uploaded automatically.
- Provider perception remains blocked until a reviewed public or signed URL route exists.
- This report is not source truth, project truth, validation, or production permission.
`;
}

function startHereJson(manifest: Record<string, unknown>, topTargets: TopReviewTarget[]): Record<string, unknown> {
  return {
    schema: "mmi.gateway.project_start_here",
    schemaVersion: "1.0.0",
    gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
    status: "candidate_review_required",
    readOrder: [
      "START_HERE.md",
      "project_intake_manifest.json",
      "top_review_targets.jsonl",
      "human_review_surface.md",
      "visual_contact_sheet.html",
      "review_queue.jsonl",
      "review_decisions.template.jsonl",
      "gap_and_blocker_report.md",
      "packet.json",
    ],
    firstAction: "Review top_review_targets.jsonl and fill review_decisions.template.jsonl before promoting any candidate atom.",
    commandHints: {
      validate: "mmi validate <this-output-dir> --json",
      review: "mmi review <this-output-dir> --decisions review_decisions.template.jsonl --json",
      handoff: "mmi handoff <this-output-dir> --json",
    },
    projectManifest: manifest,
    topTargetsPreview: topTargets.slice(0, 12),
    nonClaims: [...REQUIRED_NON_CLAIMS],
  };
}

function startHereMarkdown(discovery: ProjectDiscoveryResult, manifest: Record<string, unknown>, topTargets: TopReviewTarget[]): string {
  const counts = manifest.counts as Record<string, number>;
  const targetLines =
    topTargets
      .slice(0, 12)
      .map((target) => `- ${target.id}: ${target.targetType} ${target.relativePath ?? target.sourceId ?? "blocker"} (${target.priorityReason})`)
      .join("\n") || "- No top review targets were generated.";
  return `# MMI Start Here

Project folder: \`${discovery.root}\`

Status: \`candidate_review_required\`

## Read Order

1. \`project_intake_manifest.json\`
2. \`top_review_targets.jsonl\`
3. \`human_review_surface.md\`
4. \`visual_contact_sheet.html\`
5. \`review_queue.jsonl\`
6. \`review_decisions.template.jsonl\`
7. \`gap_and_blocker_report.md\`
8. \`packet.json\`

## Counts

- Sources: ${counts.sources ?? 0}
- Images: ${counts.image ?? 0}
- Videos: ${counts.video ?? 0}
- Audio: ${counts.audio ?? 0}
- Documents: ${counts.document ?? 0}
- Raw captures: ${counts.raw_capture ?? 0}
- Derived frames: ${counts.derived_frame ?? 0}
- Review items: ${counts.reviewItems ?? 0}

## Top Targets

${targetLines}

## Decision Loop

Fill \`review_decisions.template.jsonl\` with \`accept\`, \`edit\`, \`discard\`, or \`defer\`, then run:

\`\`\`bash
mmi review <this-output-dir> --decisions review_decisions.template.jsonl --json
\`\`\`

This output is candidate-only. It is not source truth, project truth, training-data permission, production execution permission, a review verdict, or a bound source matrix.
`;
}

function humanReviewSurface(
  discovery: ProjectDiscoveryResult,
  visualAssets: VisualAsset[],
  videoMatrix: VideoMatrixItem[],
  termQueue: Array<Record<string, unknown>>,
  topTargets: TopReviewTarget[],
  blockers: LocalBlocker[],
): string {
  const roleCounts = sourceClassificationCounts(discovery.sources);
  const sidecars = transcriptSidecars(discovery.sources);
  const imageLines = visualAssets
    .slice(0, 12)
    .map((asset) => `- [ ] ${asset.id}: ${asset.relativePath}${asset.width && asset.height ? ` (${asset.width}x${asset.height})` : ""} [${asset.assetRole}; ${asset.priorityReason}]`)
    .join("\n") || "- No image assets discovered.";
  const targetLines =
    topTargets
      .slice(0, 20)
      .map((target) => `- [ ] ${target.id}: ${target.targetType} ${target.relativePath ?? target.sourceId ?? "blocker"} (${target.priorityReason})`)
      .join("\n") || "- No top review targets were generated.";
  const videoLines =
    videoMatrix
      .flatMap((video) => video.windows.slice(0, 4).map((window) => `- [ ] ${video.relativePath} ${window.timecode}${window.keyframePath ? ` keyframe=${window.keyframePath}` : ""}`))
      .slice(0, 12)
      .join("\n") || "- No video windows discovered.";
  const termLines =
    termQueue
      .slice(0, 12)
      .map((term) => `- [ ] ${String(term.candidateTerm)} -> corrected term: ____`)
      .join("\n") || "- No candidate terms discovered.";
  const blockerLines = blockers.map((blocker) => `- [ ] ${blocker.message}`).join("\n") || "- No blockers reported.";
  return `# MMI Human Review Surface

Project folder: \`${discovery.root}\`

Status: \`candidate_review_required\`

## Quick Counts

- Sources: ${discovery.sources.length}
- Images: ${discovery.counts.image}
- Videos: ${discovery.counts.video}
- Audio: ${discovery.counts.audio}
- Documents: ${discovery.counts.document}
- Raw captures: ${roleCounts.raw_capture ?? 0}
- Original audio/video: ${roleCounts.original_media ?? 0}
- Derived frames: ${roleCounts.derived_frame ?? 0}
- Transcript/ASR sidecars: ${roleCounts.derived_sidecar ?? 0}

## Start Here

- Open \`START_HERE.md\` for the shortest human path.
- Read \`top_review_targets.jsonl\` before the full queue.
- Fill \`review_decisions.template.jsonl\`, then run \`mmi review <this-output-dir> --decisions review_decisions.template.jsonl --json\`.

## First Visual Review

${imageLines}

## Top Review Targets

${targetLines}

## First Video Window Review

${videoLines}

## Term Correction Queue

${termLines}

## Permission / No-Use Checks

- [ ] Rights reviewed for first-pass visual assets.
- [ ] Crop/no-use constraints recorded.
- [ ] Sensitive/private material marked before provider use.
- [ ] No source was promoted to project truth.

## Blockers To Resolve

${blockerLines}

## Transcript / ASR Sidecars

${sidecars.length > 0 ? sidecars.slice(0, 12).map((source) => `- ${source.id}: ${sourceRelativePath(source)}`).join("\n") : "- No transcript or ASR sidecars were discovered."}

## Next Demo Decision

- [ ] Accept selected atoms.
- [ ] Edit uncertain atoms.
- [ ] Discard non-useful atoms.
- [ ] Decide whether any selected video window deserves provider perception through a signed/public URL route.
`;
}

async function patchGatewayManifest(outputDir: string, projectManifest: Record<string, unknown>): Promise<void> {
  const manifestPath = path.join(outputDir, "gateway_manifest.json");
  try {
    const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const entrypoints = projectManifest.entrypoints as Record<string, unknown>;
    existing.projectIntake = {
      manifest: "project_intake_manifest.json",
      startHere: "START_HERE.md",
      startHereJson: "START_HERE.json",
      entrypoints,
      counts: projectManifest.counts,
      boundary: projectManifest.boundary,
    };
    existing.files = {
      packet: "packet.json",
      agentHandoff: "agent_handoff.md",
      projectStartHere: "START_HERE.md",
      projectManifest: "project_intake_manifest.json",
      topReviewTargets: "top_review_targets.jsonl",
      reviewDecisionTemplate: "review_decisions.template.jsonl",
      humanReviewSurface: "human_review_surface.md",
      visualContactSheet: "visual_contact_sheet.html",
      blockerReport: "gap_and_blocker_report.md",
      ...entrypoints,
    };
    await writeJson(manifestPath, existing);
  } catch {
    // Plain packet runs do not have project intake entrypoints to merge.
  }
}

export async function writeProjectIntakeArtifacts(discovery: ProjectDiscoveryResult, options: ProjectIntakeOptions): Promise<string[]> {
  const outputDir = path.resolve(options.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const sidecars = transcriptSidecars(discovery.sources);
  const blockers: LocalBlocker[] = [
    {
      id: "blocker_local_asr_not_configured",
      severity: discovery.counts.audio > 0 || discovery.counts.video > 0 ? "warning" : "info",
      message:
        sidecars.length > 0
          ? `Local ASR did not run in this intake; ${sidecars.length} transcript/ASR sidecar file(s) were discovered and need review.`
          : "Local ASR is not configured in this v0 intake layer.",
      recovery:
        sidecars.length > 0
          ? "Review discovered transcript/ASR sidecars and link useful passages to selected video windows before downstream use."
          : "Add a transcript sidecar or review selected audio/video windows manually before downstream use.",
    },
  ];
  const visualAssets = await buildVisualAssets(discovery.sources);
  const videoMatrix = await buildVideoMatrix(discovery.sources, outputDir, options, blockers);
  const atoms = buildProjectAtoms(discovery.sources, visualAssets, videoMatrix, blockers);
  const objectLedger = buildObjectLedger(discovery.sources, visualAssets, videoMatrix);
  const termQueue = buildTermQueue(discovery.sources);
  const reviewQueue = reviewQueueFromAtoms(atoms);
  const decisionTemplate = reviewDecisionTemplate(reviewQueue);
  const topTargets = buildTopReviewTargets(visualAssets, videoMatrix, atoms, blockers);
  const foundation = projectFoundationCandidate(discovery, visualAssets, videoMatrix, atoms, blockers);
  const roleCounts = sourceClassificationCounts(discovery.sources);
  const manifest = {
    schema: "mmi.gateway.project_intake_manifest",
    schemaVersion: "1.0.0",
    gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
    createdAt,
    profile: options.profile ?? "creative-project",
    root: discovery.root,
    status: "candidate_review_required",
    entrypoints: {
      sourceManifest: "source_manifest.json",
      startHere: "START_HERE.md",
      startHereJson: "START_HERE.json",
      visualAssets: "visual_asset_library.json",
      visualContactSheet: "visual_contact_sheet.html",
      videoMatrix: "video_window_review_matrix.json",
      topReviewTargets: "top_review_targets.jsonl",
      atoms: "atoms.ndjson",
      reviewQueue: "review_queue.jsonl",
      reviewDecisionTemplate: "review_decisions.template.jsonl",
      objectLedger: "object_evidence_ledger.json",
      termQueue: "term_correction_queue.jsonl",
      providerWindows: "provider_window_manifest.json",
      projectFoundationCandidate: "project_foundation_candidate.json",
      humanReviewSurface: "human_review_surface.md",
      blockerReport: "gap_and_blocker_report.md",
    },
    counts: {
      sources: discovery.sources.length,
      skipped: discovery.skipped.length,
      atoms: atoms.length,
      reviewItems: reviewQueue.length,
      blockers: blockers.length,
      topReviewTargets: topTargets.length,
      ...roleCounts,
      ...discovery.counts,
    },
    boundary: {
      localFirst: true,
      noTruthPromotion: options.noTruthPromotion !== false,
      providerUpload: "blocked_by_default",
      nonClaims: [...REQUIRED_NON_CLAIMS],
    },
  };
  const sourceManifest = {
    schema: "mmi.gateway.source_manifest",
    schemaVersion: "1.0.0",
    sources: discovery.sources as SourceInput[],
  };
  const files: Array<[string, unknown | string, "json" | "jsonl" | "text"]> = [
    ["project_intake_manifest.json", manifest, "json"],
    ["START_HERE.md", startHereMarkdown(discovery, manifest, topTargets), "text"],
    ["START_HERE.json", startHereJson(manifest, topTargets), "json"],
    ["source_manifest.json", sourceManifest, "json"],
    [
      "visual_asset_library.json",
      {
        schema: "mmi.gateway.visual_asset_library",
        schemaVersion: "1.0.0",
        gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
        createdAt,
        projectRoot: discovery.root,
        status: "candidate_review_required",
        counts: { assets: visualAssets.length, ...roleCounts },
        boundary: manifest.boundary,
        assets: visualAssets,
      },
      "json",
    ],
    ["visual_contact_sheet.html", visualContactSheet(visualAssets), "text"],
    [
      "video_window_review_matrix.json",
      { schema: "mmi.gateway.video_window_review_matrix", schemaVersion: "1.0.0", gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION, createdAt, projectRoot: discovery.root, status: "candidate_review_required", counts: { videos: videoMatrix.length }, boundary: manifest.boundary, videos: videoMatrix },
      "json",
    ],
    ["top_review_targets.jsonl", topTargets, "jsonl"],
    ["atoms.ndjson", atoms, "jsonl"],
    ["review_queue.jsonl", reviewQueue, "jsonl"],
    ["review_decisions.template.jsonl", decisionTemplate, "jsonl"],
    [
      "object_evidence_ledger.json",
      { schema: "mmi.gateway.object_evidence_ledger", schemaVersion: "1.0.0", gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION, createdAt, projectRoot: discovery.root, status: "candidate_review_required", counts: { items: objectLedger.length }, boundary: manifest.boundary, items: objectLedger },
      "json",
    ],
    ["term_correction_queue.jsonl", termQueue, "jsonl"],
    ["provider_window_manifest.json", providerWindowManifest(videoMatrix), "json"],
    ["project_foundation_candidate.json", foundation, "json"],
    ["human_review_surface.md", humanReviewSurface(discovery, visualAssets, videoMatrix, termQueue, topTargets, blockers), "text"],
    ["gap_and_blocker_report.md", blockerReport(blockers, discovery.skipped), "text"],
  ];
  const written: string[] = [];
  for (const [filename, value, kind] of files) {
    const filePath = path.join(outputDir, filename);
    if (kind === "json") await writeJson(filePath, value);
    else if (kind === "jsonl") await writeJsonl(filePath, value as unknown[]);
    else await fs.writeFile(filePath, String(value), "utf8");
    written.push(filePath);
  }
  await patchGatewayManifest(outputDir, manifest);
  return written;
}
