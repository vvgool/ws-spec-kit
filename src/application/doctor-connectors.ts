import { ProcessJsonError, spawnJson, spawnText } from "../adapters/process/spawn-json.js";
import { defineConnectorManifest } from "../registry/connectors/manifest.js";
import type { ConnectorEnvironmentKey, ConnectorExecutable, ConnectorManifest, DoctorAuthProbe, DoctorVersionProbe, JsonScalar } from "../registry/connectors/types.js";

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

interface SemVer {
  source: string;
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[];
}

const semverCandidate = /(?:^|[^0-9A-Za-z-])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![0-9A-Za-z.+-])/u;

function parseSemVer(value: string): SemVer | undefined {
  const source = semverCandidate.exec(value)?.[1];
  if (source === undefined) return undefined;
  const [withoutBuild] = source.split("+", 1);
  const prereleaseSeparator = withoutBuild!.indexOf("-");
  const coreText = prereleaseSeparator === -1 ? withoutBuild! : withoutBuild!.slice(0, prereleaseSeparator);
  const prereleaseText = prereleaseSeparator === -1 ? undefined : withoutBuild!.slice(prereleaseSeparator + 1);
  const coreParts = coreText!.split(".");
  if (coreParts.length !== 3) return undefined;
  const prerelease = prereleaseText === undefined ? [] : prereleaseText.split(".");
  if (prerelease.some((part) => part === "" || (/^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")))) return undefined;
  return { source, core: [BigInt(coreParts[0]!), BigInt(coreParts[1]!), BigInt(coreParts[2]!)], prerelease };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index]! !== right.core[index]!) return left.core[index]! < right.core[index]! ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    const compared = compareIdentifier(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
}

async function probeVersion(executable: string, probe: DoctorVersionProbe, manifest: ConnectorManifest, environment: SpawnEnvironment): Promise<string | undefined> {
  const request = { executable, argv: probe.argv, input: { operation: "version" }, timeoutMs: manifest.timeoutMs, maxStdoutBytes: manifest.maxStdoutBytes, environment };
  const value = probe.parser.kind === "text-semver"
    ? (await spawnText(request)).value
    : field((await spawnJson(request)).value, probe.parser.field);
  return typeof value === "string" ? parseSemVer(value)?.source : undefined;
}

function matches(value: JsonScalar, outcomes: readonly JsonScalar[]): boolean {
  return outcomes.some((candidate) => Object.is(candidate, value));
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
  if (probe.parser.kind === "exit-code") {
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
  const value = field((await spawnJson(request)).value, probe.parser.field);
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new ProcessJsonError("WSSPEC_PROCESS_INVALID_JSON", "认证探测字段无效。", "");
  if (matches(value as JsonScalar, probe.outcomes.authenticated)) return true;
  if (matches(value as JsonScalar, probe.outcomes.unauthenticated)) return false;
  throw new ProcessJsonError("WSSPEC_PROCESS_INVALID_JSON", "认证探测字段未映射。", "");
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
