import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "./errors.ts";
import type { SourceInput, SourceType } from "./types.ts";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  ".mmi",
  "mmi-runs",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".m4a", ".flac", ".amr", ".ogg", ".opus"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".flv", ".wmv", ".webm"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf"]);

export type DiscoveredSource = SourceInput & {
  id: string;
  uri: string;
  metadata: Record<string, unknown> & {
    relativePath: string;
    sizeBytes: number;
    mtimeIso: string;
    extension: string;
    discovery: "project_dir";
  };
};

export type DiscoverySkippedItem = {
  path: string;
  reason: "ignored_dir" | "excluded" | "max_files_reached" | "file_too_large" | "unsupported" | "read_failed" | "symlink_skipped";
  detail?: string;
};

export type ProjectDiscoveryOptions = {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTextBytes?: number;
  followSymlinks?: boolean;
  hashFiles?: boolean;
  provider?: string;
};

export type ProjectDiscoveryResult = {
  root: string;
  sources: DiscoveredSource[];
  skipped: DiscoverySkippedItem[];
  counts: Record<SourceType, number>;
};

export function inferSourceTypeFromPath(filePath: string): SourceType {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "other";
}

export function isTextReadableProjectFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function sourcePrefix(type: SourceType): string {
  if (type === "document") return "doc";
  return type;
}

function idFor(type: SourceType, sequence: number): string {
  return `src_${sourcePrefix(type)}_${String(sequence).padStart(4, "0")}`;
}

function globishToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relativePath: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = relativePath.split(path.sep).join("/");
  return patterns.some((pattern) => {
    const clean = pattern.split(path.sep).join("/");
    if (clean.includes("*") || clean.includes("?")) return globishToRegExp(clean).test(normalized);
    return normalized === clean || normalized.includes(clean);
  });
}

function isIgnoredDirName(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(name) || /^MMI_GATEWAY_INTAKE/i.test(name);
}

async function maybeHashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function maybeReadText(filePath: string, sizeBytes: number, maxTextBytes: number): Promise<string | undefined> {
  if (!isTextReadableProjectFile(filePath) || sizeBytes > maxTextBytes) return undefined;
  return fs.readFile(filePath, "utf8");
}

export async function discoverProjectSources(rootPath: string, options: ProjectDiscoveryOptions = {}): Promise<ProjectDiscoveryResult> {
  const root = path.resolve(rootPath);
  const maxFiles = options.maxFiles ?? 2000;
  const maxFileBytes = options.maxFileBytes ?? Number.MAX_SAFE_INTEGER;
  const maxTextBytes = options.maxTextBytes ?? 1024 * 1024;
  const skipped: DiscoverySkippedItem[] = [];
  const sources: DiscoveredSource[] = [];
  const counts: Record<SourceType, number> = {
    text: 0,
    document: 0,
    web: 0,
    image: 0,
    audio: 0,
    video: 0,
    folder: 0,
    other: 0,
  };

  async function walk(current: string): Promise<void> {
    if (sources.length >= maxFiles) {
      skipped.push({ path: path.relative(root, current) || ".", reason: "max_files_reached", detail: `maxFiles=${maxFiles}` });
      return;
    }
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: path.relative(root, current) || ".", reason: "read_failed", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (sources.length >= maxFiles) {
        skipped.push({ path: path.relative(root, path.join(current, entry.name)), reason: "max_files_reached", detail: `maxFiles=${maxFiles}` });
        return;
      }
      const absolute = path.join(current, entry.name);
      const relativePath = path.relative(root, absolute);
      if (entry.isSymbolicLink() && !options.followSymlinks) {
        skipped.push({ path: relativePath, reason: "symlink_skipped" });
        continue;
      }
      if (entry.isDirectory()) {
        if (isIgnoredDirName(entry.name)) {
          skipped.push({ path: relativePath, reason: "ignored_dir" });
          continue;
        }
        if (matchesAny(relativePath, options.exclude)) {
          skipped.push({ path: relativePath, reason: "excluded" });
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchesAny(relativePath, options.exclude)) {
        skipped.push({ path: relativePath, reason: "excluded" });
        continue;
      }
      if (options.include && options.include.length > 0 && !matchesAny(relativePath, options.include)) {
        skipped.push({ path: relativePath, reason: "excluded", detail: "did_not_match_include" });
        continue;
      }
      const type = inferSourceTypeFromPath(absolute);
      if (type === "other") {
        skipped.push({ path: relativePath, reason: "unsupported", detail: path.extname(absolute).toLowerCase() || "no_extension" });
        continue;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolute);
      } catch (error) {
        skipped.push({ path: relativePath, reason: "read_failed", detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (stat.size > maxFileBytes) {
        skipped.push({ path: relativePath, reason: "file_too_large", detail: `${stat.size} > ${maxFileBytes}` });
        continue;
      }
      const sequence = sources.length + 1;
      const metadata: DiscoveredSource["metadata"] = {
        relativePath,
        sizeBytes: stat.size,
        mtimeIso: stat.mtime.toISOString(),
        extension: path.extname(absolute).toLowerCase(),
        discovery: "project_dir",
      };
      if (options.hashFiles) metadata.sha256 = await maybeHashFile(absolute);
      const rawText = await maybeReadText(absolute, stat.size, maxTextBytes);
      const text = rawText === undefined ? undefined : redactSensitiveText(rawText);
      if (rawText !== undefined && text !== rawText) metadata.inlineTextRedacted = true;
      const source: DiscoveredSource = {
        id: idFor(type, sequence),
        type,
        uri: absolute,
        text,
        provider: options.provider,
        privacy: "project_private",
        rights: "not_reviewed",
        metadata,
      };
      counts[type] += 1;
      sources.push(source);
    }
  }

  await walk(root);
  return { root, sources, skipped, counts };
}
