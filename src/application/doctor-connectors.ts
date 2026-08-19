import { ProcessJsonError, spawnJson } from "../adapters/process/spawn-json.js";
import { redactText } from "../adapters/process/redaction.js";
import type { ConnectorExecutable, ConnectorManifest } from "../registry/connectors/types.js";

export type ConnectorHealthStatus = "available" | "unauthenticated" | "unsupported_version" | "missing_binary";

export interface ConnectorHealth {
  provider: string;
  status: ConnectorHealthStatus;
  version?: string;
  diagnostic?: string;
}

export interface DoctorConnectorsInput {
  manifests: readonly ConnectorManifest[];
  locateExecutable(executable: ConnectorExecutable): Promise<string | undefined>;
}

function versionOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>).version;
  if (typeof version !== "string") return undefined;
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u.exec(version)?.[0];
}

function versionParts(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (match === null) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function supported(actual: string, minimum: string): boolean {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return true;
}

function diagnosticOf(error: unknown): string {
  if (error instanceof ProcessJsonError) return redactText(error.diagnostic).slice(0, 1_024);
  return "Connector probe failed.";
}

function authenticated(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).authenticated === true;
}

export async function doctorConnectors(input: DoctorConnectorsInput): Promise<ConnectorHealth[]> {
  const health: ConnectorHealth[] = [];
  for (const manifest of input.manifests) {
    const executable = await input.locateExecutable(manifest.executable);
    if (executable === undefined) {
      health.push({ provider: manifest.id, status: "missing_binary" });
      continue;
    }
    const versionArgv = manifest.argvTemplates[0];
    if (versionArgv === undefined) {
      health.push({ provider: manifest.id, status: "unsupported_version", diagnostic: "Missing version probe." });
      continue;
    }
    let version: string | undefined;
    try {
      const result = await spawnJson({
        executable,
        argv: versionArgv,
        input: { operation: "version" },
        timeoutMs: manifest.timeoutMs,
        maxStdoutBytes: manifest.maxStdoutBytes,
      });
      version = versionOf(result.value);
    } catch (error) {
      health.push({ provider: manifest.id, status: "unsupported_version", diagnostic: diagnosticOf(error) });
      continue;
    }
    if (version === undefined || !supported(version, manifest.minimumVersion)) {
      health.push({ provider: manifest.id, status: "unsupported_version", ...(version === undefined ? {} : { version }) });
      continue;
    }
    const authArgv = manifest.argvTemplates[1];
    if (authArgv === undefined) {
      health.push({ provider: manifest.id, status: "available", version });
      continue;
    }
    try {
      const result = await spawnJson({
        executable,
        argv: authArgv,
        input: { operation: "auth" },
        timeoutMs: manifest.timeoutMs,
        maxStdoutBytes: manifest.maxStdoutBytes,
      });
      health.push({ provider: manifest.id, status: authenticated(result.value) ? "available" : "unauthenticated", version });
    } catch (error) {
      health.push({ provider: manifest.id, status: "unauthenticated", version, diagnostic: diagnosticOf(error) });
    }
  }
  return health;
}
