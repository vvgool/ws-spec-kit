export type ConnectorSecurityClass = "external-read" | "external-write" | "local-write";
export type ConnectorExecutable = "git" | "gh" | "glab" | "lark-cli";

export interface ConnectorManifest {
  id: string;
  capabilities: string[];
  securityClass: ConnectorSecurityClass;
  executable: ConnectorExecutable;
  minimumVersion: string;
  argvTemplates: readonly (readonly string[])[];
  timeoutMs: number;
  maxStdoutBytes: number;
}
