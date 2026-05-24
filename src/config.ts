import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { MmiGatewayError } from "./errors.ts";
import { createDashScopeProvider, createManualProvider, createMockProvider, createOpenAICompatibleProvider } from "./providers/index.ts";
import { MMI_PROVIDER_API_VERSION, type GatewayConfig, type ProviderAdapter, type SourceType } from "./types.ts";

type ManualProviderEntry = { type: "manual"; id?: string };
type MockProviderEntry = { type: "mock"; id?: string };
type DashScopeProviderEntry = { type: "dashscope"; apiKeyEnv?: string; model?: string; baseUrl?: string; audioFormat?: string; maxTokens?: number };
type OpenAICompatibleProviderEntry = {
  type: "openai-compatible";
  id: string;
  apiKeyEnv: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
  stream?: boolean;
  sourceTypes?: SourceType[];
};
type ModuleProviderEntry = {
  type: "module";
  id?: string;
  module: string;
  exportName?: string;
  options?: Record<string, unknown>;
};

type ProviderEntry =
  | ManualProviderEntry
  | MockProviderEntry
  | DashScopeProviderEntry
  | OpenAICompatibleProviderEntry
  | ModuleProviderEntry;

export type MmiConfigFile = {
  projectId?: string;
  defaultProvider?: string;
  prompt?: string;
  policy?: GatewayConfig["policy"];
  providerOptions?: Record<string, unknown>;
  providers?:
    | ProviderEntry[]
    | {
        dashscope?: {
          enabled?: boolean;
          apiKeyEnv?: string;
          model?: string;
          baseUrl?: string;
          audioFormat?: string;
          maxTokens?: number;
        };
      };
};

export const DEFAULT_CONFIG_FILE = "mmi.config.json";

export const DEFAULT_CONFIG: MmiConfigFile = {
  defaultProvider: "manual",
  policy: {
    allowLocalMediaUpload: false,
    allowLocalTextUpload: false,
    allowDataUrls: false,
    requireReview: true,
  },
  providers: [{ type: "manual" }, { type: "mock" }],
};

export type ConfigProfile = "generic" | "agent" | "dashscope" | "openai-compatible";

export function configForProfile(profile: ConfigProfile = "generic"): MmiConfigFile {
  if (profile === "agent") {
    return {
      ...DEFAULT_CONFIG,
      prompt: "Return concise candidate evidence for agent handoff. Keep uncertainty explicit and do not validate facts.",
    };
  }
  if (profile === "dashscope") {
    return {
      ...DEFAULT_CONFIG,
      defaultProvider: "dashscope",
      providers: [
        { type: "manual" },
        { type: "mock" },
        { type: "dashscope", apiKeyEnv: "DASHSCOPE_API_KEY", model: "qwen3.5-omni-plus" },
      ],
    };
  }
  if (profile === "openai-compatible") {
    return {
      ...DEFAULT_CONFIG,
      defaultProvider: "openai-compatible",
      providers: [
        { type: "manual" },
        { type: "mock" },
        {
          type: "openai-compatible",
          id: "openai-compatible",
          apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
          model: "your-model",
          baseUrl: "https://api.example.com/v1",
        },
      ],
    };
  }
  return DEFAULT_CONFIG;
}

const ProviderEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("manual"),
      id: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("mock"),
      id: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("dashscope"),
      apiKeyEnv: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      baseUrl: z.string().url().optional(),
      audioFormat: z.string().min(1).optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("openai-compatible"),
      id: z.string().min(1),
      apiKeyEnv: z.string().min(1),
      model: z.string().min(1),
      baseUrl: z.string().url(),
      maxTokens: z.number().int().positive().optional(),
      stream: z.boolean().optional(),
      sourceTypes: z.array(z.enum(["text", "document", "web", "image", "audio", "video", "folder", "other"])).min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("module"),
      id: z.string().min(1).optional(),
      module: z.string().min(1),
      exportName: z.string().min(1).optional(),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);

const ConfigFileSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    defaultProvider: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    policy: z
      .object({
        allowLocalMediaUpload: z.boolean().optional(),
        allowLocalTextUpload: z.boolean().optional(),
        allowDataUrls: z.boolean().optional(),
        requireReview: z.boolean().optional(),
        maxSourceBytes: z.number().int().positive().optional(),
        failOnProviderError: z.boolean().optional(),
        failOnUnsafeOutput: z.boolean().optional(),
      })
      .strict()
      .optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    providers: z
      .union([
        z.array(ProviderEntrySchema).min(1),
        z
          .object({
            dashscope: z
              .object({
                enabled: z.boolean().optional(),
                apiKeyEnv: z.string().min(1).optional(),
                model: z.string().min(1).optional(),
                baseUrl: z.string().url().optional(),
                audioFormat: z.string().min(1).optional(),
                maxTokens: z.number().int().positive().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export function parseConfig(value: unknown): MmiConfigFile {
  const parsed = ConfigFileSchema.safeParse(value);
  if (parsed.success) return parsed.data as MmiConfigFile;
  const detail = parsed.error.issues
    .map((schemaIssue) => `${schemaIssue.path.join(".") || "$"}: ${schemaIssue.message}`)
    .join("; ");
  throw new MmiGatewayError(`Invalid MMI config. ${detail}`, "invalid_config");
}

export async function findConfig(startDir = process.cwd()): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, DEFAULT_CONFIG_FILE);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export async function readConfig(configPath?: string): Promise<MmiConfigFile> {
  const found = configPath ?? (await findConfig());
  if (!found) return DEFAULT_CONFIG;
  return parseConfig(JSON.parse(await fs.readFile(found, "utf8")));
}

export async function writeDefaultConfig(outputPath = DEFAULT_CONFIG_FILE, profile: ConfigProfile = "generic"): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(configForProfile(profile), null, 2) + "\n", "utf8");
}

function providerList(config: MmiConfigFile): Exclude<MmiConfigFile["providers"], undefined> extends infer T
  ? Extract<T, unknown[]>
  : never {
  if (Array.isArray(config.providers)) return config.providers;
  const providers: ProviderEntry[] = [{ type: "manual" }, { type: "mock" }];
  const dashscope = config.providers?.dashscope;
  if (dashscope?.enabled || process.env[dashscope?.apiKeyEnv ?? "DASHSCOPE_API_KEY"]) {
    providers.push({
      type: "dashscope",
      apiKeyEnv: dashscope?.apiKeyEnv ?? "DASHSCOPE_API_KEY",
      model: dashscope?.model,
      baseUrl: dashscope?.baseUrl,
      audioFormat: dashscope?.audioFormat,
      maxTokens: dashscope?.maxTokens,
    });
  }
  return providers as Extract<Exclude<MmiConfigFile["providers"], undefined>, unknown[]>;
}

export function providersFromConfig(config: MmiConfigFile): ProviderAdapter[] {
  const providers = providerList(config);
  return providers.map((provider) => {
    if (provider.type === "manual") return createManualProvider(provider.id);
    if (provider.type === "mock") return createMockProvider(provider.id);
    if (provider.type === "dashscope") {
      return createDashScopeProvider({
        apiKeyEnv: provider.apiKeyEnv ?? "DASHSCOPE_API_KEY",
        model: provider.model,
        baseUrl: provider.baseUrl,
        audioFormat: provider.audioFormat,
        maxTokens: provider.maxTokens,
      });
    }
    if (provider.type === "module") {
      throw new MmiGatewayError("Module providers require gatewayConfigFromFileAsync or providersFromConfigAsync.", "invalid_config");
    }
    return createOpenAICompatibleProvider({
      id: provider.id,
      apiKeyEnv: provider.apiKeyEnv,
      model: provider.model,
      baseUrl: provider.baseUrl,
      maxTokens: provider.maxTokens,
      stream: provider.stream,
      sourceTypes: provider.sourceTypes,
    });
  });
}

export type GatewayConfigLoadOptions = {
  baseDir?: string;
};

function isModuleProviderEntry(provider: ProviderEntry): provider is ModuleProviderEntry {
  return provider.type === "module";
}

function moduleSpecifierToImportUrl(specifier: string, baseDir: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("~")) {
    const resolved = specifier.startsWith("~")
      ? path.join(process.env.HOME ?? "", specifier.slice(1))
      : path.resolve(baseDir, specifier);
    return pathToFileURL(resolved).href;
  }
  return specifier;
}

function assertProviderAdapter(value: unknown, expectedId?: string): ProviderAdapter {
  if (typeof value !== "object" || value === null) {
    throw new MmiGatewayError("Provider module export is not an object.", "invalid_config");
  }
  const provider = value as Partial<ProviderAdapter>;
  if (provider.apiVersion !== MMI_PROVIDER_API_VERSION) {
    throw new MmiGatewayError(`Provider '${expectedId ?? provider.id ?? "module"}' must use apiVersion ${MMI_PROVIDER_API_VERSION}.`, "invalid_config");
  }
  if (!provider.id || typeof provider.id !== "string") {
    throw new MmiGatewayError("Provider module export must include a string id.", "invalid_config");
  }
  if (expectedId && provider.id !== expectedId) {
    throw new MmiGatewayError(`Provider module id '${provider.id}' does not match configured id '${expectedId}'.`, "invalid_config");
  }
  if (!provider.displayName || typeof provider.displayName !== "string") {
    throw new MmiGatewayError(`Provider '${provider.id}' must include displayName.`, "invalid_config");
  }
  if (typeof provider.inspect !== "function") {
    throw new MmiGatewayError(`Provider '${provider.id}' must include inspect(source, context).`, "invalid_config");
  }
  return provider as ProviderAdapter;
}

async function providerFromModule(entry: ModuleProviderEntry, baseDir: string): Promise<ProviderAdapter> {
  const moduleExports = (await import(moduleSpecifierToImportUrl(entry.module, baseDir))) as Record<string, unknown>;
  const exported = moduleExports[entry.exportName ?? "default"] ?? moduleExports.provider ?? moduleExports.createProvider;
  if (typeof exported === "function") {
    return assertProviderAdapter(await exported(entry.options ?? {}), entry.id);
  }
  return assertProviderAdapter(exported, entry.id);
}

export async function providersFromConfigAsync(
  config: MmiConfigFile,
  options: GatewayConfigLoadOptions = {},
): Promise<ProviderAdapter[]> {
  const providers = providerList(config) as ProviderEntry[];
  const baseDir = options.baseDir ?? process.cwd();
  const loaded: ProviderAdapter[] = [];
  for (const provider of providers) {
    if (isModuleProviderEntry(provider)) loaded.push(await providerFromModule(provider, baseDir));
    else loaded.push(...providersFromConfig({ ...config, providers: [provider] }));
  }
  return loaded;
}

export function gatewayConfigFromFile(config: MmiConfigFile): GatewayConfig {
  return {
    projectId: config.projectId,
    defaultProvider: config.defaultProvider,
    prompt: config.prompt,
    policy: config.policy,
    providerOptions: config.providerOptions,
    providers: providersFromConfig(config),
  };
}

export async function gatewayConfigFromFileAsync(
  config: MmiConfigFile,
  options: GatewayConfigLoadOptions = {},
): Promise<GatewayConfig> {
  return {
    projectId: config.projectId,
    defaultProvider: config.defaultProvider,
    prompt: config.prompt,
    policy: config.policy,
    providerOptions: config.providerOptions,
    providers: await providersFromConfigAsync(config, options),
  };
}
