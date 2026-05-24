import type { GatewayIssue, GatewayIssueRecovery } from "./types.ts";

export type MmiGatewayErrorCode = GatewayIssue["code"] | "invalid_cli";

export const ERROR_CATALOG: Record<MmiGatewayErrorCode, { message: string } & Omit<GatewayIssueRecovery, "suggestedFix">> = {
  missing_source: {
    severity: "error",
    message: "No intake sources were provided.",
    recovery: "Pass at least one --text, --file, or --url source.",
  },
  missing_sources: {
    severity: "error",
    message: "No intake sources were provided.",
    recovery: "Pass at least one --text, --file, or --url source.",
  },
  duplicate_source_id: {
    severity: "error",
    message: "Two sources used the same id.",
    recovery: "Pass unique ids or let the gateway generate ids.",
  },
  invalid_source: {
    severity: "error",
    message: "A source record is malformed.",
    recovery: "Every source needs a type plus either uri or text.",
  },
  source_too_large: {
    severity: "warning",
    message: "A source exceeds the configured local file size limit.",
    recovery: "Use a smaller source, pointer-only intake, or a reviewed storage/extractor adapter.",
  },
  provider_missing: {
    severity: "error",
    message: "The selected provider is not registered.",
    recovery: "Use the manual provider, register a provider adapter, or enable DashScope in config.",
  },
  unknown_provider: {
    severity: "error",
    message: "The selected provider is not registered.",
    recovery: "Use the manual provider, register a provider adapter, or enable DashScope in config.",
  },
  unsupported_source_type: {
    severity: "warning",
    message: "The provider cannot inspect this source type.",
    recovery: "Select another provider or route the source as pointer-only manual evidence.",
  },
  local_text_upload_blocked: {
    severity: "warning",
    message: "Local private text/document upload is disabled by policy.",
    recovery: "Use manual pointer-only intake, provide reviewed public/signed input, or explicitly enable local text upload after review.",
  },
  local_media_upload_blocked: {
    severity: "warning",
    message: "Local media upload is disabled by policy.",
    recovery: "Use a signed URL or enable a storage adapter before provider inspection.",
  },
  data_url_blocked: {
    severity: "warning",
    message: "Data URL inspection is disabled by policy.",
    recovery: "Use a remote URL or explicitly enable data URLs in policy.",
  },
  provider_error: {
    severity: "warning",
    message: "The provider call failed.",
    recovery: "Run mmi doctor, check credentials, or route as manual pointer-only intake.",
  },
  provider_contract_invalid: {
    severity: "error",
    message: "The provider returned no usable description.",
    recovery: "Retry with a clearer prompt or route to manual review.",
  },
  provider_empty_content: {
    severity: "error",
    message: "The provider returned no usable description.",
    recovery: "Retry with a clearer prompt or route to manual review.",
  },
  invalid_provider_observation: {
    severity: "error",
    message: "A provider returned an invalid observation.",
    recovery: "Fix the provider adapter so it returns sourceId, providerId, content, confidence, and confidenceBasis.",
  },
  secret_leak_risk: {
    severity: "error",
    message: "A packet appears to contain a credential-like field or value.",
    recovery: "Remove secrets from source metadata and provider output before writing packets.",
  },
  packet_schema_invalid: {
    severity: "error",
    message: "The candidate packet does not match the versioned schema.",
    recovery: "Run mmi validate and compare with the published JSON Schema.",
  },
  candidate_boundary_violation: {
    severity: "error",
    message: "The packet tried to cross a candidate-only safety boundary.",
    recovery: "Keep outputs review-required and do not mark truth, validation, or execution permission.",
  },
  plugin_error: {
    severity: "error",
    message: "An intake plugin failed.",
    recovery: "Fix or disable the plugin, then rerun intake. The gateway does not assume plugin output is safe after an exception.",
  },
  write_failed: {
    severity: "error",
    message: "The gateway could not write the output packet.",
    recovery: "Check output directory permissions and disk space.",
  },
  invalid_config: {
    severity: "error",
    message: "The gateway config is invalid.",
    recovery: "Run mmi doctor and compare the config with CONFIGURATION.md.",
  },
  invalid_cli: {
    severity: "error",
    message: "The CLI arguments are invalid.",
    recovery: "Run mmi --help for supported commands and flags.",
  },
};

export function recoveryForIssue(code: GatewayIssue["code"] | MmiGatewayErrorCode): GatewayIssueRecovery {
  const entry = ERROR_CATALOG[code as MmiGatewayErrorCode];
  const recovery = entry?.recovery ?? "Run mmi --help or inspect the issue message.";
  return {
    severity: entry?.severity ?? "error",
    recovery,
    suggestedFix: recovery,
    docs: entry?.docs,
  };
}

export function issueWithRecovery<TIssue extends GatewayIssue>(issue: TIssue): TIssue & GatewayIssueRecovery {
  return {
    ...sanitizeIssue(issue),
    ...recoveryForIssue(issue.code),
  };
}

const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|authorization|bearer[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|credential|password)\b\s*[:=]\s*([^\s,;'"`]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=_-]{8,}/gi;
const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9._-]{8,}/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=<redacted>`)
    .replace(SK_KEY_PATTERN, "sk-<redacted>");
}

export function sanitizeIssue<TIssue extends GatewayIssue>(issue: TIssue): TIssue {
  return {
    ...issue,
    message: redactSensitiveText(issue.message),
    path: issue.path ? redactSensitiveText(issue.path) : issue.path,
    id: issue.id ? redactSensitiveText(issue.id) : issue.id,
    providerId: issue.providerId ? redactSensitiveText(issue.providerId) : issue.providerId,
    pluginId: issue.pluginId ? redactSensitiveText(issue.pluginId) : issue.pluginId,
  };
}

export function sanitizeIssues<TIssue extends GatewayIssue>(issues: TIssue[]): TIssue[] {
  return issues.map(sanitizeIssue);
}

export class MmiGatewayError extends Error {
  readonly code: MmiGatewayErrorCode;
  readonly issue?: GatewayIssue;

  constructor(message: string, code: MmiGatewayErrorCode = "invalid_config", issue?: GatewayIssue) {
    super(message);
    this.name = "MmiGatewayError";
    this.code = code;
    this.issue = issue;
  }
}
