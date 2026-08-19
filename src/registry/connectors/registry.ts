import { defineConnectorManifest } from "./manifest.js";
import type { ConnectorManifest } from "./types.js";

export class ConnectorRegistryError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ConnectorRegistryError";
  }
}

export class ConnectorRegistry {
  readonly #providers = new Map<string, ConnectorManifest>();

  register(input: ConnectorManifest): this {
    const manifest = defineConnectorManifest(input);
    if (this.#providers.has(manifest.id)) {
      throw new ConnectorRegistryError("WSSPEC_CONNECTOR_PROVIDER_DUPLICATE", `Connector provider ${manifest.id} 已注册。`);
    }
    this.#providers.set(manifest.id, manifest);
    return this;
  }

  resolve(capability: string, provider: string): ConnectorManifest {
    const manifest = this.#providers.get(provider);
    if (manifest === undefined) {
      throw new ConnectorRegistryError("WSSPEC_CONNECTOR_PROVIDER_NOT_FOUND", `找不到 Connector provider ${provider}。`);
    }
    if (!manifest.capabilities.includes(capability)) {
      throw new ConnectorRegistryError(
        "WSSPEC_CONNECTOR_CAPABILITY_NOT_FOUND",
        `Connector provider ${provider} 不支持 capability ${capability}。`,
      );
    }
    return manifest;
  }

  manifests(): readonly ConnectorManifest[] {
    return [...this.#providers.values()];
  }
}
