export type ConnectorSecurityClass = "external-read" | "external-write" | "local-write";
export type ConnectorExecutable = "git" | "gh" | "glab" | "lark-cli";
export type ConnectorEnvironmentKey = "HOME" | "XDG_CONFIG_HOME" | "GH_CONFIG_DIR" | "GLAB_CONFIG_DIR" | "LARK_CONFIG_DIR";
export type JsonScalar = string | number | boolean | null;

export type DoctorVersionParser =
  | { kind: "text-semver" }
  | { kind: "json-field"; field: string };

export interface DoctorVersionProbe {
  kind: "version";
  argv: readonly string[];
  parser: DoctorVersionParser;
}

export type DoctorAuthProbe =
  | { kind: "none" }
  | {
      kind: "auth";
      argv: readonly string[];
      parser: { kind: "exit-code" };
      outcomes: { authenticated: readonly number[]; unauthenticated: readonly number[] };
    }
  | {
      kind: "auth";
      argv: readonly string[];
      parser: { kind: "json-field"; field: string };
      outcomes: { authenticated: readonly JsonScalar[]; unauthenticated: readonly JsonScalar[] };
    };

export interface ConnectorManifest {
  id: string;
  capabilities: string[];
  securityClass: ConnectorSecurityClass;
  executable: ConnectorExecutable;
  minimumVersion: string;
  argvTemplates: readonly (readonly string[])[];
  doctor: { version: DoctorVersionProbe; auth: DoctorAuthProbe };
  envPolicy: { allow: readonly ConnectorEnvironmentKey[] };
  timeoutMs: number;
  maxStdoutBytes: number;
}
