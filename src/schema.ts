import { z } from "zod";
import {
  MMI_GATEWAY_PACKET_SCHEMA,
  MMI_GATEWAY_PACKET_SCHEMA_VERSION,
  MMI_GATEWAY_PACKAGE_VERSION,
  REQUIRED_NON_CLAIMS,
  type CandidatePacket,
  type GatewayIssue,
  type SourceManifest,
} from "./types.ts";

export const SourceTypeSchema = z.enum([
  "text",
  "document",
  "web",
  "image",
  "audio",
  "video",
  "folder",
  "other",
]);

export const ReviewStatusSchema = z.enum(["needs_review", "blocked", "rejected"]);

export const SourceInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: SourceTypeSchema,
    uri: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    prompt: z.string().optional(),
    provider: z.string().min(1).optional(),
    privacy: z.enum(["public", "signed_url", "project_private", "synthetic"]).optional(),
    rights: z.enum(["cleared", "not_reviewed", "restricted"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((source) => Boolean(source.uri || source.text), {
    message: "A source must include either uri or text.",
  });

export const SourceManifestSchema = z.object({
  schema: z.literal("mmi.gateway.source_manifest").optional(),
  schemaVersion: z.literal(MMI_GATEWAY_PACKET_SCHEMA_VERSION).optional(),
  sources: z.array(SourceInputSchema).min(1),
}) satisfies z.ZodType<SourceManifest>;

export const NormalizedSourceSchema = z.object({
  id: z.string().min(1),
  type: SourceTypeSchema,
  uri: z.string().min(1),
  text: z.string().optional(),
  prompt: z.string().optional(),
  provider: z.string().min(1),
  privacy: z.enum(["public", "signed_url", "project_private", "synthetic"]),
  rights: z.enum(["cleared", "not_reviewed", "restricted"]),
  metadata: z.record(z.string(), z.unknown()),
});

export const EvidenceAtomSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  sourceType: SourceTypeSchema,
  locator: z.object({
    uri: z.string().min(1),
    range: z.string().min(1),
  }),
  content: z.string().min(1),
  extractionMethod: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().optional(),
  confidence: z.number().min(0).max(1),
  confidenceBasis: z.string().min(1),
  reviewStatus: z.literal("needs_review"),
  provenance: z.array(z.string().min(1)).min(1),
  privacyFlags: z.array(z.string().min(1)),
  rightsFlags: z.array(z.string().min(1)),
  usage: z
    .object({
      promptTokens: z.number().nonnegative().optional(),
      completionTokens: z.number().nonnegative().optional(),
      totalTokens: z.number().nonnegative().optional(),
      estimatedCostUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  createdAt: z.string().min(1),
});

export const ClaimCandidateSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  evidenceAtomIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  reviewStatus: z.literal("needs_review"),
  allowedUse: z.string().min(1),
  deniedUse: z.string().min(1),
});

export const ReviewItemSchema = z.object({
  id: z.string().min(1),
  targetType: z.enum(["evidence_atom", "claim_candidate", "source_matrix_item"]),
  targetId: z.string().min(1),
  evidenceAtomIds: z.array(z.string().min(1)).min(1),
  status: z.enum(["pending", "blocked"]),
  question: z.string().min(1),
});

export const SourceMatrixItemSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  sourceType: SourceTypeSchema,
  evidenceAtomIds: z.array(z.string().min(1)).min(1),
  linkedClaimIds: z.array(z.string().min(1)),
  allowedUse: z.string().min(1),
  deniedUse: z.string().min(1),
});

export const CandidatePacketSchema = z.object({
  schema: z.literal(MMI_GATEWAY_PACKET_SCHEMA),
  schemaVersion: z.literal(MMI_GATEWAY_PACKET_SCHEMA_VERSION),
  gatewayVersion: z.literal(MMI_GATEWAY_PACKAGE_VERSION),
  status: z.literal("candidate_review_required"),
  run: z.object({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    projectId: z.string().optional(),
    providerIds: z.array(z.string().min(1)),
    executionMode: z.enum(["local_manual", "provider_probe", "mixed"]),
  }),
  nonClaims: z.array(z.string().min(1)).superRefine((items, context) => {
    for (const required of REQUIRED_NON_CLAIMS) {
      if (!items.includes(required)) {
        context.addIssue({
          code: "custom",
          message: `Missing required non-claim '${required}'.`,
        });
      }
    }
  }),
  sources: z.array(NormalizedSourceSchema).min(1),
  evidenceAtoms: z.array(EvidenceAtomSchema),
  claims: z.array(ClaimCandidateSchema),
  reviewItems: z.array(ReviewItemSchema),
  sourceMatrix: z.object({
    bound: z.literal(false),
    items: z.array(SourceMatrixItemSchema),
  }),
  review: z.object({
    required: z.literal(true),
    verdict: z.null(),
  }),
}) satisfies z.ZodType<CandidatePacket>;

export function validateCandidatePacketSchema(packet: unknown): GatewayIssue[] {
  const parsed = CandidatePacketSchema.safeParse(packet);
  if (parsed.success) return [];
  return parsed.error.issues.map((schemaIssue) => ({
    code: "packet_schema_invalid",
    message: schemaIssue.message,
    path: schemaIssue.path.join("."),
  }));
}

export function candidatePacketJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(CandidatePacketSchema) as Record<string, unknown>;
  return augmentCandidatePacketJsonSchema(schema);
}

export function sourceManifestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SourceManifestSchema) as Record<string, unknown>;
  schema.$id = `https://mmi.dev/schemas/${MMI_GATEWAY_PACKET_SCHEMA_VERSION}/source-manifest.schema.json`;
  schema.$schema = "https://json-schema.org/draft/2020-12/schema";
  schema.title = "MMI Gateway Source Manifest";
  return schema;
}

function augmentCandidatePacketJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const nonClaims = properties?.nonClaims as Record<string, unknown> | undefined;
  if (nonClaims) {
    nonClaims.allOf = REQUIRED_NON_CLAIMS.map((required) => ({
      contains: { const: required },
    }));
  }
  schema.$id = `https://mmi.dev/schemas/${MMI_GATEWAY_PACKET_SCHEMA_VERSION}/candidate-packet.schema.json`;
  return schema;
}

export const sourceInputSchema = SourceInputSchema;
export const sourceManifestSchema = SourceManifestSchema;
export const candidatePacketSchema = CandidatePacketSchema;
