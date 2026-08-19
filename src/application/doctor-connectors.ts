import { ProcessJsonError, spawnParsedText, spawnText } from "../adapters/process/spawn-json.js";
import { defineConnectorManifest } from "../registry/connectors/manifest.js";
import { compareSemVer, extractSemVer, parseSemVer } from "../registry/connectors/semver.js";
import type { ConnectorEnvironmentKey, ConnectorExecutable, ConnectorManifest, DoctorAuthProbe, DoctorVersionProbe } from "../registry/connectors/types.js";

export type ConnectorHealthStatus = "available" | "unauthenticated" | "unsupported_version" | "missing_binary";

export interface ConnectorHealth {
  provider: string;
  status: ConnectorHealthStatus;
  version?: string;
  diagnostic?: string;
}

export interface DoctorConnectorsInput {
  manifests: readonly ConnectorManifest[];
  environment?: Readonly<Partial<Record<ConnectorEnvironmentKey, string | undefined>>>;
  locateExecutable(executable: ConnectorExecutable): Promise<string | undefined>;
}

async function probeVersion(executable: string, probe: DoctorVersionProbe, manifest: ConnectorManifest, environment: SpawnEnvironment): Promise<string | undefined> {
  const request = { executable, argv: probe.argv, input: { operation: "version" }, timeoutMs: manifest.timeoutMs, maxStdoutBytes: manifest.maxStdoutBytes, environment };
  return (await spawnParsedText(request, (value) => extractSemVer(value)?.source)).value;
}

type SpawnEnvironment = Readonly<Record<string, string | undefined>>;

function providerEnvironment(manifest: ConnectorManifest, environment: DoctorConnectorsInput["environment"]): SpawnEnvironment {
  return Object.fromEntries(manifest.envPolicy.allow.flatMap((name) => {
    const value = environment?.[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

async function probeAuth(executable: string, probe: Exclude<DoctorAuthProbe, { kind: "none" }>, manifest: ConnectorManifest, environment: SpawnEnvironment): Promise<boolean> {
  const request = { executable, argv: probe.argv, input: { operation: "auth" }, timeoutMs: manifest.timeoutMs, maxStdoutBytes: manifest.maxStdoutBytes, environment };
  let exitCode = 0;
  try { await spawnText(request); }
  catch (error) {
    if (!(error instanceof ProcessJsonError) || error.code !== "WSSPEC_PROCESS_EXIT_NONZERO" || error.exitCode === undefined) throw error;
    exitCode = error.exitCode;
  }
  if (probe.outcomes.authenticated.includes(exitCode)) return true;
  if (probe.outcomes.unauthenticated.includes(exitCode)) return false;
  throw new ProcessJsonError("WSSPEC_PROCESS_EXIT_NONZERO", "认证探测返回未登记结果。", "", exitCode);
}

export async function doctorConnectors(input: DoctorConnectorsInput): Promise<ConnectorHealth[]> {
  const health: ConnectorHealth[] = [];
  for (const candidate of input.manifests) {
    const provider = typeof candidate?.id === "string" && /^[a-z][a-z0-9.-]*$/u.test(candidate.id) ? candidate.id : "invalid-provider";
    let manifest: ConnectorManifest;
    try { manifest = defineConnectorManifest(candidate); }
    catch {
      health.push({ provider, status: "unsupported_version", diagnostic: "Connector manifest invalid." });
      continue;
    }
    let executable: string | undefined;
    try { executable = await input.locateExecutable(manifest.executable); }
    catch {
      health.push({ provider: manifest.id, status: "missing_binary", diagnostic: "Executable locator failed." });
      continue;
    }
    if (executable === undefined) {
      health.push({ provider: manifest.id, status: "missing_binary" });
      continue;
    }
    const environment = providerEnvironment(manifest, input.environment);
    let version: string | undefined;
    try { version = await probeVersion(executable, manifest.doctor.version, manifest, environment); }
    catch {
      health.push({ provider: manifest.id, status: "unsupported_version", diagnostic: "Version probe failed." });
      continue;
    }
    const actual = version === undefined ? undefined : parseSemVer(version);
    const minimum = parseSemVer(manifest.minimumVersion);
    if (actual === undefined || minimum === undefined || compareSemVer(actual, minimum) < 0) {
      health.push({ provider: manifest.id, status: "unsupported_version", ...(version === undefined ? {} : { version }) });
      continue;
    }
    const supportedVersion = actual.source;
    if (manifest.doctor.auth.kind === "none") {
      health.push({ provider: manifest.id, status: "available", version: supportedVersion });
      continue;
    }
    try {
      const authenticated = await probeAuth(executable, manifest.doctor.auth, manifest, environment);
      health.push({ provider: manifest.id, status: authenticated ? "available" : "unauthenticated", version: supportedVersion });
    } catch {
      health.push({ provider: manifest.id, status: "unauthenticated", version: supportedVersion, diagnostic: "Authentication probe failed." });
    }
  }
  return health;
}
