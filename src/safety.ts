import { CandidatePacketSchema } from "./schema.ts";
import { REQUIRED_NON_CLAIMS, type CandidatePacket, type GatewayIssue, type NormalizedSource, type SourceType } from "./types.ts";

export { REQUIRED_NON_CLAIMS } from "./types.ts";

const MEDIA_TYPES = new Set<SourceType>(["image", "audio", "video"]);

export function isRemoteUrl(uri: string): boolean {
  return uri.startsWith("https://") || uri.startsWith("http://");
}

export function isDataUrl(uri: string): boolean {
  return uri.startsWith("data:");
}

export function isLocalMediaSource(source: NormalizedSource): boolean {
  return MEDIA_TYPES.has(source.type) && !isRemoteUrl(source.uri) && !isDataUrl(source.uri);
}

export function validateCandidatePacket(packet: CandidatePacket): GatewayIssue[] {
  const parsed = CandidatePacketSchema.safeParse(packet);
  const issues: GatewayIssue[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "packet_schema_invalid",
        message: issue.message,
        path: issue.path.join("."),
      });
    }
    return issues;
  }

  const nonClaims = new Set(packet.nonClaims);
  for (const required of REQUIRED_NON_CLAIMS) {
    if (!nonClaims.has(required)) {
      issues.push({
        code: "candidate_boundary_violation",
        message: `Missing required non-claim: ${required}`,
        path: "nonClaims",
      });
    }
  }

  const sourceIds = new Set(packet.sources.map((source) => source.id));
  for (const atom of packet.evidenceAtoms) {
    if (!sourceIds.has(atom.sourceId) || !atom.provenance.includes(atom.sourceId)) {
      issues.push({
        code: "candidate_boundary_violation",
        message: "Evidence atom must reference and preserve its source id in provenance.",
        id: atom.id,
      });
    }
    if (atom.reviewStatus !== "needs_review") {
      issues.push({
        code: "candidate_boundary_violation",
        message: "Evidence atom must stay in needs_review status.",
        id: atom.id,
      });
    }
  }

  if (packet.sourceMatrix.bound) {
    issues.push({
      code: "candidate_boundary_violation",
      message: "Source matrix cannot be bound by the gateway.",
      path: "sourceMatrix.bound",
    });
  }

  if (!packet.review.required || packet.review.verdict !== null) {
    issues.push({
      code: "candidate_boundary_violation",
      message: "Gateway packet must require review and leave verdict null.",
      path: "review",
    });
  }

  return issues;
}
