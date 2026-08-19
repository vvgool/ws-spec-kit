import type {
  ConnectorEnvironmentKey,
  ConnectorExecutable,
  ConnectorManifest,
  DoctorAuthProbe,
  DoctorVersionProbe,
  JsonScalar,
} from "./types.js";

const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const securityClasses = new Set(["external-read", "external-write", "local-write"]);
const executables = new Set<ConnectorExecutable>(["git", "gh", "glab", "lark-cli"]);
const environmentKeys = new Set<ConnectorEnvironmentKey>(["HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GLAB_CONFIG_DIR", "LARK_CONFIG_DIR"]);
const rootKeys = ["argvTemplates", "capabilities", "doctor", "envPolicy", "executable", "id", "maxStdoutBytes", "minimumVersion", "securityClass", "timeoutMs"];

const auditedDoctorArgv: Record<ConnectorExecutable, { version: readonly string[]; auth?: readonly string[] }> = {
  git: { version: ["--version"] },
  gh: { version: ["--version"], auth: ["auth", "status", "--active"] },
  glab: { version: ["--version"], auth: ["auth", "status"] },
  "lark-cli": { version: ["--version"], auth: ["auth", "status", "--json"] },
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

function sameScalars(left: readonly JsonScalar[], right: readonly JsonScalar[]): boolean {
  return left.length === right.length && left.every((part, index) => Object.is(part, right[index]));
}

function scalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarOutcomes(value: unknown): { authenticated: readonly JsonScalar[]; unauthenticated: readonly JsonScalar[] } {
  const source = record(value, ["authenticated", "unauthenticated"]);
  if (!Array.isArray(source.authenticated) || source.authenticated.length === 0 || !source.authenticated.every(scalar)
    || !Array.isArray(source.unauthenticated) || source.unauthenticated.length === 0 || !source.unauthenticated.every(scalar)) return invalid();
  const authenticated = source.authenticated as JsonScalar[];
  const unauthenticated = source.unauthenticated as JsonScalar[];
  if (authenticated.some((item) => unauthenticated.some((other) => Object.is(item, other)))) return invalid();
  return { authenticated: [...authenticated], unauthenticated: [...unauthenticated] };
}

function freezeAuth(probe: DoctorAuthProbe): DoctorAuthProbe {
  if (probe.kind === "none") return Object.freeze({ kind: "none" });
  if (probe.parser.kind === "exit-code") return Object.freeze({
    kind: "auth",
    argv: Object.freeze([...probe.argv]),
    parser: Object.freeze({ kind: "exit-code" }),
    outcomes: Object.freeze({
      authenticated: Object.freeze([...(probe.outcomes.authenticated as readonly number[])]),
      unauthenticated: Object.freeze([...(probe.outcomes.unauthenticated as readonly number[])]),
    }),
  });
  return Object.freeze({
    kind: "auth",
    argv: Object.freeze([...probe.argv]),
    parser: Object.freeze({ kind: "json-field", field: probe.parser.field }),
    outcomes: Object.freeze({ authenticated: Object.freeze([...probe.outcomes.authenticated]), unauthenticated: Object.freeze([...probe.outcomes.unauthenticated]) }),
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
  const source = record(value, ["argv", "kind", "outcomes", "parser"]);
  if (source.kind !== "auth") return invalid();
  const parts = argv(source.argv);
  const audited = auditedDoctorArgv[executable].auth;
  if (audited === undefined || !sameArgv(parts, audited)) return invalid();
  const parser = source.parser as Record<string, unknown> | undefined;
  if (parser?.kind === "exit-code" && Object.keys(parser).length === 1) {
    const outcomes = scalarOutcomes(source.outcomes);
    if ((executable !== "gh" && executable !== "glab")
      || !outcomes.authenticated.every(Number.isSafeInteger) || !outcomes.unauthenticated.every(Number.isSafeInteger)
      || !sameScalars(outcomes.authenticated, [0]) || !sameScalars(outcomes.unauthenticated, [1])) return invalid();
    return {
      kind: "auth",
      argv: parts,
      parser: { kind: "exit-code" },
      outcomes: { authenticated: outcomes.authenticated as number[], unauthenticated: outcomes.unauthenticated as number[] },
    };
  }
  const parsed = record(source.parser, ["field", "kind"]);
  const outcomes = scalarOutcomes(source.outcomes);
  if (executable !== "lark-cli" || parsed.kind !== "json-field" || parsed.field !== "authenticated"
    || !sameScalars(outcomes.authenticated, [true]) || !sameScalars(outcomes.unauthenticated, [false])) return invalid();
  return {
    kind: "auth",
    argv: parts,
    parser: { kind: "json-field", field: stringValue(parsed.field, idPattern) },
    outcomes,
  };
}

export function defineConnectorManifest(value: unknown): ConnectorManifest {
  const source = record(value, rootKeys);
  const id = stringValue(source.id, idPattern);
  if (!Array.isArray(source.capabilities) || source.capabilities.length === 0) return invalid();
  const capabilities = source.capabilities.map((capability) => stringValue(capability, idPattern));
  if (!securityClasses.has(source.securityClass as string) || !executables.has(source.executable as ConnectorExecutable)) return invalid();
  const executable = source.executable as ConnectorExecutable;
  const minimumVersion = stringValue(source.minimumVersion, semverPattern);
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
