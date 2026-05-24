export const MMI_GATEWAY_PACKET_SCHEMA = "mmi.gateway.packet" as const;
export const MMI_GATEWAY_PACKET_SCHEMA_VERSION = "1.0.0" as const;
export const MMI_GATEWAY_PACKAGE_VERSION = "0.6.0" as const;

export const REQUIRED_NON_CLAIMS = [
  "not_source_truth",
  "not_project_truth",
  "not_training_data_permission",
  "not_production_execution_permission",
  "not_review_verdict",
  "not_source_matrix_binding",
] as const;

export type SourceType =
  | "text"
  | "document"
  | "web"
  | "image"
  | "audio"
  | "video"
  | "folder"
  | "other";

export type ReviewStatus = "needs_review" | "blocked" | "rejected";
export type ExecutionMode = "local_manual" | "provider_probe" | "mixed";
export type PacketProfile = "generic" | "creative_project_foundation" | "field_video_project_base" | "visual_asset_library_only";

export type ProviderCapability = {
  sourceTypes: SourceType[];
  acceptsLocalFiles: boolean;
  acceptsRemoteUrls: boolean;
  acceptsDataUrls: boolean;
  maxSourceBytes?: number;
  streaming?: boolean;
};

export type ProviderHealthStatus = "ok" | "warning" | "error";

export type ProviderHealth = {
  providerId: string;
  status: ProviderHealthStatus;
  message: string;
  issues?: GatewayIssue[];
};

export type SourceInput = {
  id?: string;
  type: SourceType;
  uri?: string;
  text?: string;
  prompt?: string;
  provider?: string;
  privacy?: "public" | "signed_url" | "project_private" | "synthetic";
  rights?: "cleared" | "not_reviewed" | "restricted";
  metadata?: Record<string, unknown>;
};

export type NormalizedSource = {
  id: string;
  type: SourceType;
  uri: string;
  text?: string;
  prompt?: string;
  provider: string;
  privacy: NonNullable<SourceInput["privacy"]>;
  rights: NonNullable<SourceInput["rights"]>;
  metadata: Record<string, unknown>;
};

export type ProviderUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
};

export type GatewayIssueRecovery = {
  severity: "info" | "warning" | "error";
  recovery: string;
  suggestedFix: string;
  docs?: string;
};

export type ProviderObservation = {
  sourceId: string;
  providerId: string;
  model?: string;
  content: string;
  confidence: number;
  confidenceBasis: string;
  usage?: ProviderUsage;
  warnings?: string[];
};

export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type ProviderContext = {
  runId: string;
  createdAt: string;
  projectId?: string;
  prompt: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  providerOptions?: unknown;
};

export const MMI_PROVIDER_API_VERSION = 1 as const;

export type ProviderAdapter = {
  apiVersion: typeof MMI_PROVIDER_API_VERSION;
  id: string;
  displayName: string;
  capabilities: ProviderCapability;
  inspect(source: NormalizedSource, context: ProviderContext): Promise<ProviderObservation>;
  healthCheck?(context: Omit<ProviderContext, "prompt"> & { prompt?: string }): Promise<ProviderHealth> | ProviderHealth;
  dispose?(): Promise<void> | void;
};

export type ProviderFactory<TOptions extends Record<string, unknown> = Record<string, unknown>> = (
  options?: TOptions,
) => ProviderAdapter;

export type GatewayIssue = {
  code:
    | "missing_source"
    | "missing_sources"
    | "duplicate_source_id"
    | "invalid_source"
    | "source_too_large"
    | "unsupported_source_type"
    | "local_text_upload_blocked"
    | "local_media_upload_blocked"
    | "data_url_blocked"
    | "unknown_provider"
    | "provider_missing"
    | "provider_error"
    | "provider_contract_invalid"
    | "provider_empty_content"
    | "invalid_provider_observation"
    | "secret_leak_risk"
    | "packet_schema_invalid"
    | "candidate_boundary_violation"
    | "plugin_error"
    | "write_failed"
    | "invalid_config"
    | "invalid_cli";
  message: string;
  path?: string;
  id?: string;
  providerId?: string;
  pluginId?: string;
  stage?: string;
};

export type IntakePluginStage = "pre_ingest" | "post_ingest" | "validate" | "output";

export type IntakePluginContext = {
  packet?: CandidatePacket;
  sources?: NormalizedSource[];
  issues: GatewayIssue[];
};

export type IntakePlugin = {
  apiVersion?: typeof MMI_PLUGIN_API_VERSION;
  id: string;
  stage: IntakePluginStage;
  run(context: IntakePluginContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export const MMI_PLUGIN_API_VERSION = 1 as const;

export type GatewayPolicy = {
  allowLocalMediaUpload?: boolean;
  allowLocalTextUpload?: boolean;
  allowDataUrls?: boolean;
  requireReview?: boolean;
  maxSourceBytes?: number;
  failOnProviderError?: boolean;
  failOnUnsafeOutput?: boolean;
};

export type GatewayConfig = {
  projectId?: string;
  defaultProvider?: string;
  providers?: ProviderAdapter[];
  plugins?: IntakePlugin[];
  policy?: GatewayPolicy;
  prompt?: string;
  providerOptions?: Record<string, unknown>;
};

export type GatewayConfigFile = {
  projectId?: string;
  defaultProvider?: string;
  prompt?: string;
  policy?: GatewayPolicy;
  providerOptions?: Record<string, unknown>;
  providers?: {
    dashscope?: {
      enabled?: boolean;
      apiKeyEnv?: string;
      baseUrl?: string;
      model?: string;
      audioFormat?: string;
      maxTokens?: number;
    };
  };
};

export type GatewayRunInput = {
  sources: SourceInput[];
  preflightIssues?: GatewayIssue[];
  runId?: string;
  createdAt?: string;
  outputDir?: string;
  provider?: string;
  projectId?: string;
  prompt?: string;
  write?: boolean;
  fetch?: FetchLike;
  signal?: AbortSignal;
  profile?: PacketProfile;
};

export type SourceManifest = {
  schema?: "mmi.gateway.source_manifest";
  schemaVersion?: typeof MMI_GATEWAY_PACKET_SCHEMA_VERSION;
  sources: SourceInput[];
};

export type EvidenceAtom = {
  id: string;
  sourceId: string;
  sourceType: SourceType;
  locator: {
    uri: string;
    range: string;
    kind?: "whole_source" | "file_pointer" | "text_range" | "timecode" | "image_region";
    startMs?: number;
    endMs?: number;
    lineStart?: number;
    lineEnd?: number;
    page?: number;
    frameId?: string;
    region?: {
      x: number;
      y: number;
      width: number;
      height: number;
      unit: "pixel" | "ratio";
    };
  };
  content: string;
  extractionMethod: string;
  providerId: string;
  model?: string;
  confidence: number;
  confidenceBasis: string;
  reviewStatus: ReviewStatus;
  provenance: string[];
  privacyFlags: string[];
  rightsFlags: string[];
  usage?: ProviderUsage;
  createdAt: string;
};

export type ClaimCandidate = {
  id: string;
  text: string;
  evidenceAtomIds: string[];
  confidence: number;
  reviewStatus: ReviewStatus;
  allowedUse: string;
  deniedUse: string;
};

export type ReviewItem = {
  id: string;
  targetType: "evidence_atom" | "claim_candidate" | "source_matrix_item";
  targetId: string;
  evidenceAtomIds: string[];
  status: "pending" | "blocked";
  question: string;
};

export type SourceMatrixItem = {
  id: string;
  sourceId: string;
  sourceType: SourceType;
  evidenceAtomIds: string[];
  linkedClaimIds: string[];
  allowedUse: string;
  deniedUse: string;
};

export type CandidatePacket = {
  schema: typeof MMI_GATEWAY_PACKET_SCHEMA;
  schemaVersion: typeof MMI_GATEWAY_PACKET_SCHEMA_VERSION;
  gatewayVersion: typeof MMI_GATEWAY_PACKAGE_VERSION;
  status: "candidate_review_required";
  run: {
    id: string;
    createdAt: string;
    projectId?: string;
    providerIds: string[];
    executionMode: ExecutionMode;
  };
  nonClaims: string[];
  sources: NormalizedSource[];
  evidenceAtoms: EvidenceAtom[];
  claims: ClaimCandidate[];
  reviewItems: ReviewItem[];
  sourceMatrix: {
    bound: false;
    items: SourceMatrixItem[];
  };
  review: {
    required: true;
    verdict: null;
  };
};

export type GatewayRunResult = {
  packet: CandidatePacket;
  issues: GatewayIssue[];
  outputDir?: string;
  filesWritten?: string[];
};

export type CandidatePacketOutputManifest = {
  schema: "mmi.gateway.output_manifest";
  schemaVersion: typeof MMI_GATEWAY_PACKET_SCHEMA_VERSION;
  packetSchema: typeof MMI_GATEWAY_PACKET_SCHEMA;
  profile: PacketProfile;
  run: CandidatePacket["run"];
  status: CandidatePacket["status"];
  entrypoints: {
    packet: string;
    sources: string;
    evidenceAtoms: string;
    claims: string;
    reviewItems: string;
    sourceMatrix: string;
    issues: string;
    agentHandoff: string;
    humanReadme: string;
  };
  commands: {
    validate: string;
    handoff: string;
  };
  nextActions: Array<{
    id: string;
    command?: string;
    description: string;
    required: boolean;
  }>;
  counts: {
    sources: number;
    evidenceAtoms: number;
    claims: number;
    reviewItems: number;
    issues: number;
  };
  boundary: {
    reviewRequired: true;
    sourceMatrixBound: false;
    nonClaims: string[];
  };
};
