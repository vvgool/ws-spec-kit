import type { ConnectorManifest } from "./types.js";

const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export class ConnectorManifestError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ConnectorManifestError";
  }
}

export function defineConnectorManifest(value: ConnectorManifest): ConnectorManifest {
  if (!idPattern.test(value.id)) {
    throw new ConnectorManifestError("WSSPEC_CONNECTOR_MANIFEST_INVALID", "Connector provider id 无效。");
  }
  if (value.capabilities.length === 0 || value.capabilities.some((capability) => !idPattern.test(capability))) {
    throw new ConnectorManifestError("WSSPEC_CONNECTOR_MANIFEST_INVALID", `Connector ${value.id} 的 capability 无效。`);
  }
  if (!versionPattern.test(value.minimumVersion)) {
    throw new ConnectorManifestError("WSSPEC_CONNECTOR_MANIFEST_INVALID", `Connector ${value.id} 的最低版本无效。`);
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1
    || !Number.isSafeInteger(value.maxStdoutBytes) || value.maxStdoutBytes < 1
    || value.argvTemplates.length === 0
    || value.argvTemplates.some((argv) => argv.length === 0 || argv.some((part) => part.includes("\0")))) {
    throw new ConnectorManifestError("WSSPEC_CONNECTOR_MANIFEST_INVALID", `Connector ${value.id} 的进程边界配置无效。`);
  }
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...new Set(value.capabilities)]) as unknown as string[],
    argvTemplates: Object.freeze(value.argvTemplates.map((argv) => Object.freeze([...argv]))),
  });
}
