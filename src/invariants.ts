import { REQUIRED_NON_CLAIMS, type CandidatePacket, type GatewayIssue, type ProviderObservation } from "./types.ts";

const FORBIDDEN_STATUS_WORDS = new Set([
  "accepted",
  "approved",
  "final",
  "project_truth",
  "source_truth",
  "source_matrix_bound",
  "usage_evidence",
  "validated",
]);

const SECRET_VALUE_PATTERNS = [/Bearer\s+[A-Za-z0-9._-]{12,}/i, /sk-[A-Za-z0-9_-]{12,}/i];

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /(?:^|[_-])(access|refresh|id|bearer)[_-]?token$/i,
  /secret/i,
  /credential/i,
];

function issue(code: GatewayIssue["code"], message: string, extras: Partial<GatewayIssue> = {}): GatewayIssue {
  return { code, message, ...extras };
}

function walk(value: unknown, visit: (key: string, value: unknown) => void, key = "$"): void {
  visit(key, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${key}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    walk(childValue, visit, `${key}.${childKey}`);
  }
}

export function validateProviderObservation(
  observation: ProviderObservation,
  expected: { sourceId?: string; providerId?: string } = {},
): GatewayIssue[] {
  const issues: GatewayIssue[] = [];
  if (!observation.sourceId.trim()) {
    issues.push(issue("provider_contract_invalid", "Provider observation sourceId is required."));
  }
  if (expected.sourceId && observation.sourceId !== expected.sourceId) {
    issues.push(
      issue("provider_contract_invalid", `Provider observation sourceId '${observation.sourceId}' does not match source '${expected.sourceId}'.`, {
        id: expected.sourceId,
        providerId: observation.providerId,
      }),
    );
  }
  if (!observation.providerId.trim()) {
    issues.push(issue("provider_contract_invalid", "Provider observation providerId is required."));
  }
  if (expected.providerId && observation.providerId !== expected.providerId) {
    issues.push(
      issue("provider_contract_invalid", `Provider observation providerId '${observation.providerId}' does not match provider '${expected.providerId}'.`, {
        id: observation.sourceId,
        providerId: expected.providerId,
      }),
    );
  }
  if (!observation.content.trim()) {
    issues.push(
      issue("provider_contract_invalid", "Provider observation content is empty.", {
        id: observation.sourceId,
        providerId: observation.providerId,
      }),
    );
  }
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
    issues.push(
      issue("provider_contract_invalid", "Provider observation confidence must be between 0 and 1.", {
        id: observation.sourceId,
        providerId: observation.providerId,
      }),
    );
  }
  if (!observation.confidenceBasis.trim()) {
    issues.push(
      issue("provider_contract_invalid", "Provider observation confidenceBasis is required.", {
        id: observation.sourceId,
        providerId: observation.providerId,
      }),
    );
  }
  return issues;
}

export function validateSafetyInvariants(packet: CandidatePacket): GatewayIssue[] {
  const issues: GatewayIssue[] = [];
  const sourceIds = new Set(packet.sources.map((source) => source.id));
  const evidenceIds = new Set(packet.evidenceAtoms.map((atom) => atom.id));

  for (const required of REQUIRED_NON_CLAIMS) {
    if (!packet.nonClaims.includes(required)) {
      issues.push(issue("candidate_boundary_violation", `Missing non-claim '${required}'.`));
    }
  }
  if (packet.status !== "candidate_review_required") {
    issues.push(issue("candidate_boundary_violation", "Packet status must remain candidate_review_required."));
  }
  if (packet.sourceMatrix.bound !== false) {
    issues.push(issue("candidate_boundary_violation", "Source matrix must not be bound by the gateway."));
  }
  if (packet.review.required !== true || packet.review.verdict !== null) {
    issues.push(issue("candidate_boundary_violation", "Review must remain required with no verdict."));
  }

  for (const atom of packet.evidenceAtoms) {
    if (!sourceIds.has(atom.sourceId)) {
      issues.push(issue("candidate_boundary_violation", `Evidence atom '${atom.id}' references an unknown source.`, { id: atom.id }));
    }
    if (!atom.provenance.includes(atom.sourceId)) {
      issues.push(issue("candidate_boundary_violation", `Evidence atom '${atom.id}' provenance must include sourceId.`, { id: atom.id }));
    }
    if (atom.reviewStatus !== "needs_review") {
      issues.push(issue("candidate_boundary_violation", `Evidence atom '${atom.id}' must remain needs_review.`, { id: atom.id }));
    }
  }

  for (const claim of packet.claims) {
    for (const evidenceId of claim.evidenceAtomIds) {
      if (!evidenceIds.has(evidenceId)) {
        issues.push(issue("candidate_boundary_violation", `Claim '${claim.id}' references an unknown evidence atom.`, { id: claim.id }));
      }
    }
    if (claim.reviewStatus !== "needs_review") {
      issues.push(issue("candidate_boundary_violation", `Claim '${claim.id}' must remain needs_review.`, { id: claim.id }));
    }
  }

  walk(packet, (path, value) => {
    const leaf = path.split(".").at(-1) ?? path;
    if (SECRET_KEY_PATTERNS.some((pattern) => pattern.test(leaf))) {
      issues.push(issue("secret_leak_risk", `Potential credential field '${leaf}' is not allowed in packet output.`, { path }));
    }
    if (typeof value !== "string") return;
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      issues.push(issue("secret_leak_risk", "Potential credential value is not allowed in packet output.", { path }));
    }
    const lowered = value.toLowerCase();
    for (const forbidden of FORBIDDEN_STATUS_WORDS) {
      if (lowered === forbidden || lowered.includes(`status:${forbidden}`)) {
        issues.push(issue("candidate_boundary_violation", `Forbidden overclaim token '${forbidden}' found.`, { path }));
      }
    }
  });

  return issues;
}
