import { MmiGatewayError } from "../errors.ts";
import {
  MMI_PROVIDER_API_VERSION,
  type FetchLike,
  type NormalizedSource,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderContext,
  type ProviderObservation,
  type SourceType,
} from "../types.ts";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "video_url"; video_url: { url: string } };

export type OpenAICompatibleProviderConfig = {
  id: string;
  displayName?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  stream?: boolean;
  sourceTypes?: SourceType[];
  contentPartMapper?: (source: NormalizedSource, prompt: string) => ContentPart[];
};

type ProviderResponse = {
  model?: unknown;
  choices?: Array<{
    message?: { content?: unknown };
    delta?: { content?: unknown };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  error?: { code?: unknown; message?: unknown };
  code?: unknown;
  message?: unknown;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function apiKeyFrom(config: OpenAICompatibleProviderConfig): string {
  return (config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? "").trim();
}

function apiKeyHealth(config: OpenAICompatibleProviderConfig): { ok: boolean; envName?: string } {
  return { ok: Boolean(apiKeyFrom(config)), envName: config.apiKeyEnv };
}

function parseJson(text: string): ProviderResponse {
  try {
    return JSON.parse(text) as ProviderResponse;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
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
  return "";
}

function parseProviderResponse(text: string): ProviderResponse {
  const trimmed = text.trim();
  if (!trimmed.startsWith("data:")) return parseJson(trimmed);

  let content = "";
  let model: unknown;
  let usage: ProviderResponse["usage"];
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^data:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const payload = match[1];
    if (!payload || payload === "[DONE]") continue;
    const chunk = parseJson(payload);
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const messageText = normalizeContent(chunk.choices?.[0]?.message?.content);
    if (messageText) content += messageText;
    const deltaText = normalizeContent(chunk.choices?.[0]?.delta?.content);
    if (deltaText) content += deltaText;
  }

  return { model, choices: [{ message: { content } }], usage };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultContentParts(source: NormalizedSource, prompt: string): ContentPart[] {
  const instruction = {
    type: "text" as const,
    text: `Return a concise candidate evidence description. Do not treat this as verified truth.\n\n${prompt}`,
  };
  if (source.type === "image") return [{ type: "image_url", image_url: { url: source.uri } }, instruction];
  if (source.type === "audio") {
    return [
      {
        type: "input_audio",
        input_audio: {
          data: source.uri,
          format: source.uri.split(".").pop()?.toLowerCase() || "mp3",
        },
      },
      instruction,
    ];
  }
  if (source.type === "video") return [{ type: "video_url", video_url: { url: source.uri } }, instruction];
  return [{ type: "text", text: `${instruction.text}\n\n${source.text ?? source.uri}` }];
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleProviderConfig): ProviderAdapter {
  const capability: ProviderCapability = {
    sourceTypes: config.sourceTypes ?? ["text", "document", "web", "image", "audio"],
    acceptsLocalFiles: false,
    acceptsRemoteUrls: true,
    acceptsDataUrls: true,
  };

  return {
    apiVersion: MMI_PROVIDER_API_VERSION,
    id: config.id,
    displayName: config.displayName ?? `${config.id} OpenAI-compatible provider`,
    capabilities: capability,
    healthCheck() {
      const health = apiKeyHealth(config);
      if (!health.ok) {
        return {
          providerId: config.id,
          status: "error",
          message: health.envName
            ? `${config.id} provider is configured but ${health.envName} is not set.`
            : `${config.id} provider is configured without apiKey or apiKeyEnv.`,
          issues: [
            {
              code: "invalid_config",
              message: health.envName
                ? `Provider '${config.id}' expects environment variable '${health.envName}'.`
                : `Provider '${config.id}' expects apiKey or apiKeyEnv.`,
              providerId: config.id,
            },
          ],
        };
      }
      return {
        providerId: config.id,
        status: "ok",
        message: `${config.id} credential is present. Doctor does not call the external API.`,
      };
    },
    async inspect(source: NormalizedSource, context: ProviderContext): Promise<ProviderObservation> {
      const apiKey = apiKeyFrom(config);
      if (!apiKey) {
        throw new MmiGatewayError(`${config.id} API key is missing.`, "provider_error", {
          code: "provider_error",
          message: `${config.id} API key is missing.`,
          id: config.id,
        });
      }

      const fetchFn: FetchLike = context.fetch ?? fetch;
      const response = await fetchFn(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: context.signal,
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: "user",
              content: (config.contentPartMapper ?? defaultContentParts)(source, source.prompt ?? context.prompt),
            },
          ],
          max_tokens: config.maxTokens ?? 180,
          temperature: 0,
          stream: config.stream ?? false,
          stream_options: config.stream ? { include_usage: true } : undefined,
          modalities: ["text"],
        }),
      });

      const body = parseProviderResponse(await response.text());
      if (!response.ok) {
        throw new MmiGatewayError(
          String(body.error?.message ?? body.message ?? `${config.id} HTTP ${response.status}`),
          "provider_error",
          {
            code: "provider_error",
            message: String(body.error?.message ?? body.message ?? `${config.id} HTTP ${response.status}`),
            id: config.id,
          },
        );
      }

      const content = normalizeContent(body.choices?.[0]?.message?.content);
      if (!content.trim()) {
        throw new MmiGatewayError(`${config.id} returned empty content.`, "provider_error", {
          code: "provider_error",
          message: `${config.id} returned empty content.`,
          id: config.id,
        });
      }

      return {
        sourceId: source.id,
        providerId: config.id,
        model: String(body.model ?? config.model),
        content,
        confidence: 0.5,
        confidenceBasis: "Provider returned a candidate observation; review is still required.",
        usage: {
          promptTokens: asNumber(body.usage?.prompt_tokens),
          completionTokens: asNumber(body.usage?.completion_tokens),
          totalTokens: asNumber(body.usage?.total_tokens),
        },
      };
    },
  };
}
