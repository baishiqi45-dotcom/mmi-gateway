import { MmiGatewayError } from "../errors.ts";
import {
  MMI_PROVIDER_API_VERSION,
  type FetchLike,
  type NormalizedSource,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderObservation,
  type SourceType,
} from "../types.ts";

export const DASHSCOPE_PROVIDER_ID = "dashscope";
export const DASHSCOPE_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DASHSCOPE_DEFAULT_MODEL = "qwen3.5-omni-plus";

export type DashScopeProviderOptions = {
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  audioFormat?: string;
  maxTokens?: number;
  fetch?: FetchLike;
};

type ChatContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: { url: string };
    }
  | {
      type: "video_url";
      video_url: { url: string };
    }
  | {
      type: "input_audio";
      input_audio: { data: string; format: string };
    };

type DashScopeResponseBody = {
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

function parseJson(text: string): DashScopeResponseBody {
  try {
    return JSON.parse(text) as DashScopeResponseBody;
  } catch {
    return { message: text.slice(0, 500) };
  }
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

function parseResponseText(text: string): DashScopeResponseBody {
  const trimmed = text.trim();
  if (!trimmed.startsWith("data:")) return parseJson(trimmed);

  let model: unknown;
  let content = "";
  let usage: DashScopeResponseBody["usage"];
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^data:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const payload = match[1];
    if (!payload || payload === "[DONE]") continue;
    const chunk = parseJson(payload);
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    content += normalizeContent(chunk.choices?.[0]?.message?.content);
    content += normalizeContent(chunk.choices?.[0]?.delta?.content);
  }
  return {
    model,
    choices: [{ message: { content } }],
    usage,
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentForSource(source: NormalizedSource, prompt: string, audioFormat: string): ChatContentPart[] {
  const textPart = {
    type: "text" as const,
    text: `Return a concise evidence-style description for this intake source. Keep uncertainty explicit and do not validate it as fact.\n\n${source.prompt ?? prompt}`,
  };
  if (source.type === "text" || source.type === "document" || source.type === "web") {
    return [
      {
        type: "text",
        text: `${textPart.text}\n\nSource text or pointer:\n${source.text ?? source.uri}`,
      },
    ];
  }
  if (source.type === "image") return [{ type: "image_url", image_url: { url: source.uri } }, textPart];
  if (source.type === "video") return [{ type: "video_url", video_url: { url: source.uri } }, textPart];
  if (source.type === "audio") {
    return [
      {
        type: "input_audio",
        input_audio: { data: source.uri, format: audioFormat },
      },
      textPart,
    ];
  }
  return [
    {
      type: "text",
      text: `${textPart.text}\n\nUnsupported source type was registered as pointer only: ${source.uri}`,
    },
  ];
}

function apiKeyFromOptions(options: DashScopeProviderOptions): string {
  const envName = options.apiKeyEnv ?? "DASHSCOPE_API_KEY";
  const key = options.apiKey ?? process.env[envName] ?? "";
  if (!key.trim()) {
    throw new MmiGatewayError(`DashScope API key is missing. Set ${envName} or pass apiKey.`, "invalid_config");
  }
  return key.trim();
}

function apiKeyHealth(options: DashScopeProviderOptions): { ok: boolean; envName: string } {
  const envName = options.apiKeyEnv ?? "DASHSCOPE_API_KEY";
  return { ok: Boolean((options.apiKey ?? process.env[envName] ?? "").trim()), envName };
}

export function createDashScopeProvider(options: DashScopeProviderOptions = {}): ProviderAdapter {
  const keyHealth = () => apiKeyHealth(options);
  return {
    apiVersion: MMI_PROVIDER_API_VERSION,
    id: DASHSCOPE_PROVIDER_ID,
    displayName: "Alibaba Cloud DashScope Qwen-Omni",
    capabilities: {
      sourceTypes: ["text", "document", "web", "image", "audio", "video"],
      acceptsLocalFiles: false,
      acceptsRemoteUrls: true,
      acceptsDataUrls: true,
      streaming: true,
    },
    healthCheck() {
      const health = keyHealth();
      if (!health.ok) {
        return {
          providerId: DASHSCOPE_PROVIDER_ID,
          status: "error",
          message: `DashScope provider is configured but ${health.envName} is not set.`,
          issues: [
            {
              code: "invalid_config",
              message: `DashScope provider expects environment variable '${health.envName}'.`,
              providerId: DASHSCOPE_PROVIDER_ID,
            },
          ],
        };
      }
      return {
        providerId: DASHSCOPE_PROVIDER_ID,
        status: "ok",
        message: "DashScope credential is present. Doctor does not call the external API.",
      };
    },
    async inspect(source: NormalizedSource, context: ProviderContext): Promise<ProviderObservation> {
      const apiKey = apiKeyFromOptions(options);
      const fetchFn = options.fetch ?? context.fetch ?? fetch;
      const model = options.model ?? DASHSCOPE_DEFAULT_MODEL;
      const body = JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: contentForSource(source, context.prompt, options.audioFormat ?? "mp3"),
          },
        ],
        max_tokens: options.maxTokens ?? 180,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
        modalities: ["text"],
      });

      const response = await fetchFn(`${normalizeBaseUrl(options.baseUrl ?? DASHSCOPE_DEFAULT_BASE_URL)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: context.signal,
      });
      const parsed = parseResponseText(await response.text());
      if (!response.ok) {
        const code = String(parsed.error?.code ?? parsed.code ?? "dashscope_http_error");
        const message = String(parsed.error?.message ?? parsed.message ?? `DashScope HTTP ${response.status}`);
        throw new MmiGatewayError(`DashScope request failed (${code}): ${message}`, "provider_error");
      }

      const content = normalizeContent(parsed.choices?.[0]?.message?.content);
      if (!content.trim()) {
        throw new MmiGatewayError("DashScope returned empty content.", "provider_contract_invalid");
      }
      return {
        sourceId: source.id,
        providerId: DASHSCOPE_PROVIDER_ID,
        model: String(parsed.model ?? model),
        content,
        confidence: 0.5,
        confidenceBasis: "DashScope returned a candidate description; it is provider perception, not reviewed source truth.",
        usage: {
          promptTokens: asNumber(parsed.usage?.prompt_tokens),
          completionTokens: asNumber(parsed.usage?.completion_tokens),
          totalTokens: asNumber(parsed.usage?.total_tokens),
        },
        warnings: ["candidate_only", "review_required"],
      };
    },
  };
}

export function dashScopeSupportsSourceType(sourceType: SourceType): boolean {
  return ["text", "document", "web", "image", "audio", "video"].includes(sourceType);
}
