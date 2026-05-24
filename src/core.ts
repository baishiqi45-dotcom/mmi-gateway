import path from "node:path";
import fs from "node:fs/promises";
import { issueWithRecovery, MmiGatewayError, sanitizeIssue, sanitizeIssues } from "./errors.ts";
import { validateProviderObservation, validateSafetyInvariants } from "./invariants.ts";
import { writeCandidatePacket } from "./packet-io.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import { validateCandidatePacketSchema } from "./schema.ts";
import {
  MMI_GATEWAY_PACKET_SCHEMA,
  MMI_GATEWAY_PACKET_SCHEMA_VERSION,
  MMI_GATEWAY_PACKAGE_VERSION,
  REQUIRED_NON_CLAIMS,
  type CandidatePacket,
  type ClaimCandidate,
  type EvidenceAtom,
  type ExecutionMode,
  type GatewayConfig,
  type GatewayIssue,
  type GatewayRunInput,
  type GatewayRunResult,
  type NormalizedSource,
  type ProviderAdapter,
  type ProviderObservation,
  type ReviewItem,
  type SourceInput,
  type SourceMatrixItem,
  type SourceType,
} from "./types.ts";

const DEFAULT_PROMPT =
  "Create a concise candidate evidence description for intake review. Keep uncertainty explicit.";

const TEXT_LIKE_TYPES = new Set<SourceType>(["text", "document", "web"]);
const MEDIA_TYPES = new Set<SourceType>(["image", "audio", "video", "folder"]);

function issue(code: GatewayIssue["code"], message: string, extras: Partial<GatewayIssue> = {}): GatewayIssue {
  return sanitizeIssue({ code, message, ...extras });
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "source";
}

function runId(): string {
  return `mmi_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
}

function isRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function isDataUri(uri: string): boolean {
  return /^data:/i.test(uri);
}

function isManualUri(uri: string): boolean {
  return /^manual:\/\//i.test(uri) || /^synthetic:\/\//i.test(uri);
}

function isLocalPrivateUri(uri: string): boolean {
  return !isRemoteUri(uri) && !isDataUri(uri) && !isManualUri(uri);
}

function hasUnsafeOutputIssue(issues: GatewayIssue[]): boolean {
  return issues.some((item) => item.code === "secret_leak_risk" || item.code === "packet_schema_invalid");
}

function privacyForUri(uri: string): NonNullable<SourceInput["privacy"]> {
  if (isManualUri(uri)) return "synthetic";
  if (isRemoteUri(uri)) return "public";
  if (isDataUri(uri)) return "public";
  return "project_private";
}

function normalizeSource(input: SourceInput, index: number, provider: string): NormalizedSource {
  const id = input.id?.trim() || `src_${input.type}_${String(index + 1).padStart(3, "0")}`;
  const uri = input.uri?.trim() || (input.text ? `manual://${id}` : "");
  if (!uri) throw new MmiGatewayError(`Source '${id}' needs uri or text.`, "invalid_source");
  return {
    id,
    type: input.type,
    uri,
    text: input.text,
    prompt: input.prompt,
    provider: input.provider ?? provider,
    privacy: input.privacy ?? privacyForUri(uri),
    rights: input.rights ?? "not_reviewed",
    metadata: input.metadata ?? {},
  };
}

function checkSourceBoundary(source: NormalizedSource, provider: ProviderAdapter, config: GatewayConfig): GatewayIssue[] {
  const issues: GatewayIssue[] = [];
  const allowDataUrls = config.policy?.allowDataUrls === true;
  const allowLocalMediaUpload = config.policy?.allowLocalMediaUpload === true;
  const allowLocalTextUpload = config.policy?.allowLocalTextUpload === true;
  const maxSourceBytes = config.policy?.maxSourceBytes ?? provider.capabilities.maxSourceBytes;

  if (!provider.capabilities.sourceTypes.includes(source.type)) {
    issues.push(
      issue("unsupported_source_type", `Provider '${provider.id}' does not support source type '${source.type}'.`, {
        id: source.id,
        providerId: provider.id,
      }),
    );
  }
  if (isDataUri(source.uri) && (!provider.capabilities.acceptsDataUrls || !allowDataUrls)) {
    issues.push(issue("data_url_blocked", "Data URLs are blocked by policy unless explicitly allowed.", { id: source.id }));
  }
  const sourceBytes = source.text ? Buffer.byteLength(source.text, "utf8") : undefined;
  if (maxSourceBytes !== undefined && sourceBytes !== undefined && sourceBytes > maxSourceBytes) {
    issues.push(
      issue("source_too_large", `Source '${source.id}' exceeds maxSourceBytes (${sourceBytes} > ${maxSourceBytes}).`, {
        id: source.id,
        providerId: provider.id,
      }),
    );
  }
  if (
    provider.id !== "manual" &&
    TEXT_LIKE_TYPES.has(source.type) &&
    source.privacy === "project_private" &&
    isLocalPrivateUri(source.uri) &&
    !allowLocalTextUpload
  ) {
    issues.push(
      issue("local_text_upload_blocked", "Local private text/document content cannot be sent to providers without an explicit policy.", {
        id: source.id,
        providerId: provider.id,
      }),
    );
  }
  if (
    provider.id !== "manual" &&
    MEDIA_TYPES.has(source.type) &&
    !isRemoteUri(source.uri) &&
    !isDataUri(source.uri) &&
    (!provider.capabilities.acceptsLocalFiles || !allowLocalMediaUpload)
  ) {
    issues.push(
      issue("local_media_upload_blocked", "Local private media cannot be sent to providers without an explicit upload/storage policy.", {
        id: source.id,
        providerId: provider.id,
      }),
    );
  }
  return issues;
}

function observationToAtom(source: NormalizedSource, observation: ProviderObservation, createdAt: string): EvidenceAtom {
  return {
    id: `ev_${slug(observation.providerId)}_${slug(source.id)}`,
    sourceId: source.id,
    sourceType: source.type,
    locator: {
      uri: source.uri,
      range: TEXT_LIKE_TYPES.has(source.type) ? "text_or_pointer:whole_source" : "media_pointer:whole_source",
    },
    content: observation.content.slice(0, 16000),
    extractionMethod: observation.providerId === "manual" ? "manual_or_pointer_intake" : "provider_candidate_probe",
    providerId: observation.providerId,
    model: observation.model,
    confidence: observation.confidence,
    confidenceBasis: observation.confidenceBasis,
    reviewStatus: "needs_review",
    provenance: [source.id],
    privacyFlags:
      source.privacy === "project_private"
        ? ["project_private_pointer_only"]
        : observation.providerId === "manual"
          ? ["manual_no_provider_upload"]
          : ["provider_url_probe_review_required"],
    rightsFlags: [source.rights === "cleared" ? "rights_claimed_cleared_review_recommended" : "rights_not_reviewed"],
    usage: observation.usage,
    createdAt,
  };
}

function buildClaims(atoms: EvidenceAtom[]): ClaimCandidate[] {
  return atoms.map((atom, index) => ({
    id: `claim_${String(index + 1).padStart(3, "0")}`,
    text: `Source '${atom.sourceId}' may contain intake material that can support later workflow planning after review.`,
    evidenceAtomIds: [atom.id],
    confidence: Math.min(atom.confidence, 0.65),
    reviewStatus: "needs_review",
    allowedUse: "candidate intake planning after review",
    deniedUse: "not source truth, project truth, validation, or execution permission",
  }));
}

function buildReviewItems(claims: ClaimCandidate[]): ReviewItem[] {
  return claims.map((claim, index) => ({
    id: `review_${String(index + 1).padStart(3, "0")}`,
    targetType: "claim_candidate",
    targetId: claim.id,
    evidenceAtomIds: claim.evidenceAtomIds,
    status: "pending",
    question: "Can this candidate be used in a downstream workflow without overclaiming source truth?",
  }));
}

function buildSourceMatrixItems(sources: NormalizedSource[], atoms: EvidenceAtom[], claims: ClaimCandidate[]): SourceMatrixItem[] {
  return sources.map((source, index) => ({
    id: `matrix_${String(index + 1).padStart(3, "0")}`,
    sourceId: source.id,
    sourceType: source.type,
    evidenceAtomIds: atoms[index] ? [atoms[index].id] : [],
    linkedClaimIds: claims[index] ? [claims[index].id] : [],
    allowedUse: "candidate source inventory row after review",
    deniedUse: "not source-matrix binding",
  }));
}

function executionMode(providerIds: string[]): ExecutionMode {
  const unique = new Set(providerIds);
  if (unique.size === 1 && unique.has("manual")) return "local_manual";
  if (unique.has("manual")) return "mixed";
  return "provider_probe";
}

async function runStagePlugins(stage: "pre_ingest" | "post_ingest" | "validate" | "output", config: GatewayConfig, context: Parameters<NonNullable<GatewayConfig["plugins"]>[number]["run"]>[0]): Promise<void> {
  for (const plugin of config.plugins ?? []) {
    if (plugin.stage !== stage) continue;
    try {
      await plugin.run(context);
    } catch (error) {
      context.issues.push(
        issue("plugin_error", error instanceof Error ? error.message : String(error), {
          pluginId: plugin.id,
          stage,
        }),
      );
    }
  }
}

function providerOptionsFor(providerId: string, config: GatewayConfig): unknown {
  const options = config.providerOptions;
  if (!options) return undefined;
  const providerScoped = options[providerId];
  if (providerScoped !== undefined) return providerScoped;
  return options;
}

export function defineConfig(config: GatewayConfig): GatewayConfig {
  return config;
}

export function createGateway(config: GatewayConfig = {}) {
  return {
    async run(input: GatewayRunInput): Promise<GatewayRunResult> {
      return runGateway(input, config);
    },
    providers: createProviderRegistry(config.providers).list(),
  };
}

export async function runGateway(input: GatewayRunInput, config: GatewayConfig = {}): Promise<GatewayRunResult> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const activeRunId = input.runId ?? runId();
  const selectedProvider = input.provider ?? config.defaultProvider ?? "manual";
  const issues: GatewayIssue[] = [...(input.preflightIssues ?? [])];
  const filesWritten: string[] = [];

  if (input.sources.length === 0) {
    issues.push(issue("missing_source", "At least one source is required."));
  }

  const registry = createProviderRegistry(config.providers);
  const normalizedSources: NormalizedSource[] = [];
  const seenSourceIds = new Set<string>();
  for (const [index, source] of input.sources.entries()) {
    try {
      const normalized = normalizeSource(source, index, selectedProvider);
      if (seenSourceIds.has(normalized.id)) {
        issues.push(issue("duplicate_source_id", `Duplicate source id '${normalized.id}'.`, { id: normalized.id }));
      }
      seenSourceIds.add(normalized.id);
      normalizedSources.push(normalized);
    } catch (error) {
      issues.push(
        issue("invalid_source", error instanceof Error ? error.message : String(error), {
          id: source.id,
        }),
      );
    }
  }

  await runStagePlugins("pre_ingest", config, { sources: normalizedSources, issues });

  const atoms: EvidenceAtom[] = [];
  for (const source of normalizedSources) {
    const provider = registry.get(source.provider);
    if (!provider) {
      issues.push(issue("provider_missing", `Unknown provider '${source.provider}'. Falling back to manual pointer capture.`, { id: source.id, providerId: source.provider }));
    }
    const effectiveProvider = provider ?? registry.require("manual");
    const boundaryIssues = checkSourceBoundary(source, effectiveProvider, config);
    issues.push(...boundaryIssues);
    const shouldUseManual = boundaryIssues.length > 0 || !provider;
    const finalProvider = shouldUseManual ? registry.require("manual") : effectiveProvider;
    try {
      const observation = await finalProvider.inspect(source, {
        runId: activeRunId,
        createdAt,
        projectId: input.projectId ?? config.projectId,
        prompt: input.prompt ?? config.prompt ?? DEFAULT_PROMPT,
        fetch: input.fetch,
        signal: input.signal,
        providerOptions: providerOptionsFor(finalProvider.id, config),
      });
      const observationIssues = validateProviderObservation(observation, {
        sourceId: source.id,
        providerId: finalProvider.id,
      });
      issues.push(...observationIssues);
      if (observationIssues.length === 0) atoms.push(observationToAtom(source, observation, createdAt));
    } catch (error) {
      issues.push(
        issue("provider_error", error instanceof Error ? error.message : String(error), {
          id: source.id,
          providerId: finalProvider.id,
        }),
      );
      if (config.policy?.failOnProviderError) continue;
      const manualObservation = await registry.require("manual").inspect(source, {
        runId: activeRunId,
        createdAt,
        projectId: input.projectId ?? config.projectId,
        prompt: input.prompt ?? config.prompt ?? DEFAULT_PROMPT,
        fetch: input.fetch,
        signal: input.signal,
        providerOptions: providerOptionsFor("manual", config),
      });
      atoms.push(observationToAtom(source, manualObservation, createdAt));
    }
  }

  const claims = buildClaims(atoms);
  const packet: CandidatePacket = {
    schema: MMI_GATEWAY_PACKET_SCHEMA,
    schemaVersion: MMI_GATEWAY_PACKET_SCHEMA_VERSION,
    gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
    status: "candidate_review_required",
    run: {
      id: activeRunId,
      createdAt,
      projectId: input.projectId ?? config.projectId,
      providerIds: [...new Set(atoms.map((atom) => atom.providerId))],
      executionMode: executionMode(atoms.map((atom) => atom.providerId)),
    },
    nonClaims: [...REQUIRED_NON_CLAIMS],
    sources: normalizedSources,
    evidenceAtoms: atoms,
    claims,
    reviewItems: buildReviewItems(claims),
    sourceMatrix: {
      bound: false,
      items: buildSourceMatrixItems(normalizedSources, atoms, claims),
    },
    review: {
      required: true,
      verdict: null,
    },
  };

  await runStagePlugins("post_ingest", config, { packet, sources: normalizedSources, issues });
  issues.push(...validateCandidatePacketSchema(packet), ...validateSafetyInvariants(packet));
  await runStagePlugins("validate", config, { packet, sources: normalizedSources, issues });
  const safeIssues = sanitizeIssues(issues);
  issues.splice(0, issues.length, ...safeIssues);

  if (input.outputDir && input.write !== false) {
    try {
      if (config.policy?.failOnUnsafeOutput !== false && hasUnsafeOutputIssue(issues)) {
        issues.push(
          issue("write_failed", "Unsafe packet output was not written because schema or secret-leak issues were detected.", {
            path: input.outputDir,
          }),
        );
        await writeRunError(path.resolve(input.outputDir), activeRunId, issues);
      } else {
        filesWritten.push(
          ...(await writeCandidatePacket(packet, path.resolve(input.outputDir), {
            issues,
            profile: input.profile ?? "generic",
          })),
        );
      }
    } catch (error) {
      issues.push(issue("write_failed", error instanceof Error ? error.message : String(error), { path: input.outputDir }));
    }
  }

  await runStagePlugins("output", config, { packet, sources: normalizedSources, issues });
  const returnIssues = sanitizeIssues(issues);
  issues.splice(0, issues.length, ...returnIssues);
  return {
    packet,
    issues,
    outputDir: input.outputDir,
    filesWritten,
  };
}

async function writeRunError(outputDir: string, runId: string, issues: GatewayIssue[]): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "run_error.json"),
    JSON.stringify(
      {
        schema: "mmi.gateway.run_error",
        schemaVersion: MMI_GATEWAY_PACKET_SCHEMA_VERSION,
        runId,
        status: "blocked_before_packet_write",
        issues: issues.map((item) => {
          const enriched = issueWithRecovery(item);
          return {
            code: enriched.code,
            message: enriched.message,
            severity: enriched.severity,
            recovery: enriched.recovery,
            suggestedFix: enriched.recovery,
            path: enriched.path,
            id: enriched.id,
            providerId: enriched.providerId,
          };
        }),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
