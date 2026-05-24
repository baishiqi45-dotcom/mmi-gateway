import { MmiGatewayError } from "../errors.ts";
import { MMI_PROVIDER_API_VERSION, type ProviderAdapter } from "../types.ts";
import { createManualProvider } from "./manual.ts";

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(providers: ProviderAdapter[] = []) {
    this.register(createManualProvider());
    for (const provider of providers) this.register(provider);
  }

  register(provider: ProviderAdapter): void {
    if (!provider.id.trim()) throw new MmiGatewayError("Provider id is required.", "invalid_config");
    if (provider.apiVersion !== MMI_PROVIDER_API_VERSION) {
      throw new MmiGatewayError(
        `Provider '${provider.id}' uses unsupported apiVersion '${String(provider.apiVersion)}'.`,
        "invalid_config",
      );
    }
    this.adapters.set(provider.id, provider);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): ProviderAdapter {
    const provider = this.get(id);
    if (!provider) throw new MmiGatewayError(`Unknown provider '${id}'.`, "provider_missing");
    return provider;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function createProviderRegistry(providers: ProviderAdapter[] = []): ProviderRegistry {
  return new ProviderRegistry(providers);
}
