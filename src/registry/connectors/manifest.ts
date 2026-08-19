import type {
  ConnectorEnvironmentKey,
  ConnectorExecutable,
  ConnectorManifest,
  DoctorAuthProbe,
  DoctorVersionProbe,
} from "./types.js";
import { parseSemVer } from "./semver.js";

const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const securityClasses = new Set(["external-read", "external-write", "local-write"]);
const executables = new Set<ConnectorExecutable>(["git", "gh", "glab", "lark-cli"]);
const environmentKeys = new Set<ConnectorEnvironmentKey>(["HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GLAB_CONFIG_DIR", "LARK_CONFIG_DIR"]);
const rootKeys = ["argvTemplates", "capabilities", "doctor", "envPolicy", "executable", "id", "maxStdoutBytes", "minimumVersion", "securityClass", "timeoutMs"];

const auditedDoctorArgv: Record<ConnectorExecutable, { version: readonly string[]; auth?: readonly string[] }> = {
  git: { version: ["--version"] },
  gh: { version: ["--version"], auth: ["auth", "status", "--active"] },
  glab: { version: ["--version"], auth: ["auth", "status"] },
  "lark-cli": { version: ["--version"] },
};

export class ConnectorManifestError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ConnectorManifestError";
  }
}

function invalid(): never {
  throw new ConnectorManifestError("WSSPEC_CONNECTOR_MANIFEST_INVALID", "Connector Manifest 不符合完整安全合同。");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join("\0") !== [...keys].sort().join("\0")) return invalid();
  return source;
}

function stringValue(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || (pattern !== undefined && !pattern.test(value))) return invalid();
  return value;
}

function argv(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return invalid();
  return value.map((part) => stringValue(part));
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((part, index) => Object.is(part, right[index]));
}

function exitCodeOutcomes(value: unknown): { authenticated: readonly number[]; unauthenticated: readonly number[] } {
  const source = record(value, ["authenticated", "unauthenticated"]);
  if (!Array.isArray(source.authenticated) || source.authenticated.length === 0 || !source.authenticated.every(Number.isSafeInteger)
    || !Array.isArray(source.unauthenticated) || source.unauthenticated.length === 0 || !source.unauthenticated.every(Number.isSafeInteger)) return invalid();
  const authenticated = source.authenticated as number[];
  const unauthenticated = source.unauthenticated as number[];
  if (authenticated.some((item) => unauthenticated.includes(item))) return invalid();
  return { authenticated: [...authenticated], unauthenticated: [...unauthenticated] };
}

function freezeAuth(probe: DoctorAuthProbe): DoctorAuthProbe {
  if (probe.kind === "none") return Object.freeze({ kind: "none" });
  if (probe.kind === "unavailable") return Object.freeze({ kind: "unavailable", reasonCode: probe.reasonCode });
  return Object.freeze({
    kind: "auth",
    argv: Object.freeze([...probe.argv]),
    parser: Object.freeze({ kind: "exit-code" }),
    outcomes: Object.freeze({
      authenticated: Object.freeze([...probe.outcomes.authenticated]),
      unauthenticated: Object.freeze([...probe.outcomes.unauthenticated]),
    }),
  });
}

function versionProbe(value: unknown, executable: ConnectorExecutable): DoctorVersionProbe {
  const source = record(value, ["argv", "kind", "parser"]);
  if (source.kind !== "version") return invalid();
  const parts = argv(source.argv);
  if (!sameArgv(parts, auditedDoctorArgv[executable].version)) return invalid();
  const parser = source.parser as Record<string, unknown> | undefined;
  if (parser?.kind === "text-semver" && Object.keys(parser).length === 1) return { kind: "version", argv: parts, parser: { kind: "text-semver" } };
  return invalid();
}

function authProbe(value: unknown, executable: ConnectorExecutable): DoctorAuthProbe {
  if (executable === "git") {
    const source = record(value, ["kind"]);
    if (source.kind !== "none") return invalid();
    return { kind: "none" };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "unavailable") {
    const source = record(value, ["kind", "reasonCode"]);
    if (source.reasonCode !== "WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE") return invalid();
    return { kind: "unavailable", reasonCode: "WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE" };
  }
  if (executable === "lark-cli") return invalid();
  const source = record(value, ["argv", "kind", "outcomes", "parser"]);
  if (source.kind !== "auth") return invalid();
  const parts = argv(source.argv);
  const audited = auditedDoctorArgv[executable].auth;
  if (audited === undefined || !sameArgv(parts, audited)) return invalid();
  const parser = source.parser as Record<string, unknown> | undefined;
  if (parser?.kind === "exit-code" && Object.keys(parser).length === 1) {
    const outcomes = exitCodeOutcomes(source.outcomes);
    if ((executable !== "gh" && executable !== "glab")
      || !sameNumbers(outcomes.authenticated, [0]) || !sameNumbers(outcomes.unauthenticated, [1])) return invalid();
    return {
      kind: "auth",
      argv: parts,
      parser: { kind: "exit-code" },
      outcomes,
    };
  }
  return invalid();
}

export function defineConnectorManifest(value: unknown): ConnectorManifest {
  const source = record(value, rootKeys);
  const id = stringValue(source.id, idPattern);
  if (!Array.isArray(source.capabilities) || source.capabilities.length === 0) return invalid();
  const capabilities = source.capabilities.map((capability) => stringValue(capability, idPattern));
  if (!securityClasses.has(source.securityClass as string) || !executables.has(source.executable as ConnectorExecutable)) return invalid();
  const executable = source.executable as ConnectorExecutable;
  const minimumVersion = stringValue(source.minimumVersion);
  if (parseSemVer(minimumVersion) === undefined) return invalid();
  if (!Number.isSafeInteger(source.timeoutMs) || (source.timeoutMs as number) < 1
    || !Number.isSafeInteger(source.maxStdoutBytes) || (source.maxStdoutBytes as number) < 1
    || !Array.isArray(source.argvTemplates) || source.argvTemplates.length === 0) return invalid();
  const argvTemplates = source.argvTemplates.map(argv);
  const doctorSource = record(source.doctor, ["auth", "version"]);
  const doctor = { version: versionProbe(doctorSource.version, executable), auth: authProbe(doctorSource.auth, executable) };
  const envSource = record(source.envPolicy, ["allow"]);
  if (!Array.isArray(envSource.allow) || !envSource.allow.every((name) => typeof name === "string" && environmentKeys.has(name as ConnectorEnvironmentKey))) return invalid();
  const allow = [...new Set(envSource.allow as ConnectorEnvironmentKey[])];
  const manifest: ConnectorManifest = {
    id,
    capabilities: Object.freeze([...new Set(capabilities)]) as unknown as string[],
    securityClass: source.securityClass as ConnectorManifest["securityClass"],
    executable,
    minimumVersion,
    argvTemplates: Object.freeze(argvTemplates.map((parts) => Object.freeze([...parts]))),
    doctor: Object.freeze({
      version: Object.freeze({ ...doctor.version, argv: Object.freeze([...doctor.version.argv]), parser: Object.freeze({ ...doctor.version.parser }) }),
      auth: freezeAuth(doctor.auth),
    }),
    envPolicy: Object.freeze({ allow: Object.freeze(allow) }),
    timeoutMs: source.timeoutMs as number,
    maxStdoutBytes: source.maxStdoutBytes as number,
  };
  return Object.freeze(manifest);
}
