import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlias, parseDocument, visit } from "yaml";

import { ProcessJsonError } from "../../adapters/process/spawn-json.js";
import type { NormalizedRequirementSource } from "./requirement-source.js";
import { defineConnectorManifest } from "./manifest.js";
import type { ConnectorRegistry } from "./registry.js";
import { inspectDecodedCredentialSurface } from "./secret-detector.js";
import type { ConnectorManifest } from "./types.js";

const maximumManifestBytes = 64 * 1024;
const hostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u;
const pathSegmentPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u;
const stableIdPattern = /^[A-Za-z0-9:_-]{1,512}$/u;

export type IssueProviderErrorCode =
  | "WSSPEC_ISSUE_TARGET_INVALID"
  | "WSSPEC_ISSUE_ACTION_INVALID"
  | "WSSPEC_ISSUE_CONFIGURATION_INVALID"
  | "WSSPEC_ISSUE_MISSING_BINARY"
  | "WSSPEC_ISSUE_NOT_FOUND"
  | "WSSPEC_ISSUE_UNAUTHENTICATED"
  | "WSSPEC_ISSUE_FORBIDDEN"
  | "WSSPEC_ISSUE_RATE_LIMITED"
  | "WSSPEC_ISSUE_RESPONSE_INVALID"
  | "WSSPEC_ISSUE_IDENTITY_MISMATCH"
  | "WSSPEC_ISSUE_READBACK_MISMATCH"
  | "WSSPEC_ISSUE_REQUEST_FAILED"
  | "WSSPEC_ISSUE_MANIFEST_INVALID";

export class IssueProviderError extends Error {
  constructor(readonly code: IssueProviderErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "IssueProviderError";
  }
}

export interface GithubIssueTarget {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export interface GitlabIssueTarget {
  host: string;
  projectPath: string;
  iid: number;
}

export type IssueWriteAction =
  | { type: "comment"; body: string }
  | { type: "body"; body: string }
  | { type: "labels"; labels: readonly string[] }
  | { type: "state"; state: "open" }
  | { type: "issue.close" };

export interface NormalizedIssue extends NormalizedRequirementSource {
  type: "github.issue" | "gitlab.issue";
  provider: "github" | "gitlab";
  repository: string;
  number: number;
  state: "open" | "closed";
  labels: string[];
}

export interface NormalizedIssueWriteResult extends NormalizedIssue {
  externalEffectId?: string;
}

function fail(code: IssueProviderErrorCode, message: string): never {
  throw new IssueProviderError(code, message);
}

function ownRecord(value: unknown, keys: readonly string[], code: IssueProviderErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    return fail(code, "输入对象不符合精确合同。");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")
    || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) {
    return fail(code, "输入对象不符合精确合同。");
  }
  return value as Record<string, unknown>;
}

function hostname(value: unknown): string {
  if (typeof value !== "string" || !hostnamePattern.test(value) || value.includes("..")) {
    return fail("WSSPEC_ISSUE_TARGET_INVALID", "Issue host 必须是无 scheme、路径、userinfo 或端口的主机名。");
  }
  return value.toLowerCase();
}

function rejectCredentialTargetSurfaces(values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const result = inspectDecodedCredentialSurface(value);
    if (!result.ok && result.reason === "credential") {
      return fail("WSSPEC_ISSUE_TARGET_INVALID", "Issue 目标包含凭据样式内容。");
    }
  }
}

function pathSegment(value: unknown): string {
  if (typeof value !== "string" || !pathSegmentPattern.test(value) || value === "." || value === "..") {
    return fail("WSSPEC_ISSUE_TARGET_INVALID", "Issue 目标路径字段无效。");
  }
  return encodeURIComponent(value);
}

function issueNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fail("WSSPEC_ISSUE_TARGET_INVALID", "Issue 编号必须是正安全整数。");
  }
  return value as number;
}

export interface ValidatedGithubTarget extends GithubIssueTarget {
  endpoint: string;
  repository: string;
  canonicalUrl: string;
}

export function validateGithubIssueTarget(value: GithubIssueTarget): ValidatedGithubTarget {
  const source = ownRecord(value, ["host", "number", "owner", "repo"], "WSSPEC_ISSUE_TARGET_INVALID");
  rejectCredentialTargetSurfaces([source.host, source.owner, source.repo]);
  const host = hostname(source.host);
  const encodedOwner = pathSegment(source.owner);
  const encodedRepo = pathSegment(source.repo);
  const number = issueNumber(source.number);
  const owner = source.owner as string;
  const repo = source.repo as string;
  return {
    host,
    owner,
    repo,
    number,
    repository: `${owner}/${repo}`,
    endpoint: `repos/${encodedOwner}/${encodedRepo}/issues/${number}`,
    canonicalUrl: `https://${host}/${encodedOwner}/${encodedRepo}/issues/${number}`,
  };
}

export interface ValidatedGitlabTarget extends GitlabIssueTarget {
  endpoint: string;
  repository: string;
  canonicalUrl: string;
}

export function validateGitlabIssueTarget(value: GitlabIssueTarget): ValidatedGitlabTarget {
  const source = ownRecord(value, ["host", "iid", "projectPath"], "WSSPEC_ISSUE_TARGET_INVALID");
  rejectCredentialTargetSurfaces([source.host]);
  if (typeof source.projectPath !== "string" || source.projectPath.length > 1024) {
    return fail("WSSPEC_ISSUE_TARGET_INVALID", "GitLab projectPath 无效。");
  }
  const segments = source.projectPath.split("/");
  rejectCredentialTargetSurfaces([source.projectPath, ...segments]);
  const host = hostname(source.host);
  if (segments.length < 2 || segments.length > 32 || segments.some((segment) => segment === "")) {
    return fail("WSSPEC_ISSUE_TARGET_INVALID", "GitLab projectPath 必须由有界路径段组成。");
  }
  const encodedSegments = segments.map(pathSegment);
  const repository = segments.join("/");
  const iid = issueNumber(source.iid);
  return {
    host,
    projectPath: repository,
    iid,
    repository,
    endpoint: `projects/${encodeURIComponent(repository)}/issues/${iid}`,
    canonicalUrl: `https://${host}/${encodedSegments.join("/")}/-/issues/${iid}`,
  };
}

function boundedText(value: unknown, maximum: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum
    || value.includes("\0") || (!allowEmpty && value.trim() === "")) {
    return fail("WSSPEC_ISSUE_ACTION_INVALID", "Issue 写入内容无效或超过上限。");
  }
  return value;
}

export function canonicalIssueText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

export function validateIssueWriteAction(value: IssueWriteAction): IssueWriteAction {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("WSSPEC_ISSUE_ACTION_INVALID", "Issue 写动作不在允许列表中。");
  }
  const type = (value as { type?: unknown }).type;
  if (type === "comment" || type === "body") {
    const source = ownRecord(value, ["body", "type"], "WSSPEC_ISSUE_ACTION_INVALID");
    return Object.freeze({ type, body: boundedText(source.body, 1024 * 1024, type === "body") });
  }
  if (type === "labels") {
    const source = ownRecord(value, ["labels", "type"], "WSSPEC_ISSUE_ACTION_INVALID");
    if (!Array.isArray(source.labels) || source.labels.length > 100) {
      return fail("WSSPEC_ISSUE_ACTION_INVALID", "Issue labels 无效或超过上限。");
    }
    const labels = source.labels.map((label) => boundedText(label, 255, false));
    if (new Set(labels.map(canonicalIssueText)).size !== labels.length) {
      return fail("WSSPEC_ISSUE_ACTION_INVALID", "Issue labels 不能重复。");
    }
    return Object.freeze({ type, labels: Object.freeze(labels) });
  }
  if (type === "state") {
    const source = ownRecord(value, ["state", "type"], "WSSPEC_ISSUE_ACTION_INVALID");
    if (source.state !== "open") {
      return fail("WSSPEC_ISSUE_ACTION_INVALID", "Issue state 不在允许列表中。");
    }
    return Object.freeze({ type, state: source.state });
  }
  if (type === "issue.close") {
    ownRecord(value, ["type"], "WSSPEC_ISSUE_ACTION_INVALID");
    return Object.freeze({ type });
  }
  return fail("WSSPEC_ISSUE_ACTION_INVALID", "Issue 写动作不在允许列表中。");
}

export function validateIssueProviderEnvironment(
  value: unknown,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, string | undefined>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return fail("WSSPEC_ISSUE_CONFIGURATION_INVALID", "Issue Provider 配置路径无效。");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) {
    return fail("WSSPEC_ISSUE_CONFIGURATION_INVALID", "Issue Provider 配置路径无效。");
  }
  const result: Record<string, string> = {};
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!allowed.has(key) || !descriptor.enumerable || !("value" in descriptor)) {
      return fail("WSSPEC_ISSUE_CONFIGURATION_INVALID", "Issue Provider 配置路径无效。");
    }
    if (descriptor.value === undefined) continue;
    if (typeof descriptor.value !== "string" || !path.isAbsolute(descriptor.value) || descriptor.value.includes("\0")) {
      return fail("WSSPEC_ISSUE_CONFIGURATION_INVALID", "Issue Provider 配置路径无效。");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export function assertStableIssueIdentity(before: NormalizedIssue, after: NormalizedIssue): void {
  if (before.type !== after.type || before.provider !== after.provider || before.repository !== after.repository
    || before.number !== after.number || before.stableId !== after.stableId) {
    return fail("WSSPEC_ISSUE_IDENTITY_MISMATCH", "Issue 回读稳定身份与写入前不一致。");
  }
}

export function stableId(provider: "github" | "gitlab", value: unknown): string {
  const source = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  if (typeof source !== "string" || !stableIdPattern.test(source)) {
    return fail("WSSPEC_ISSUE_RESPONSE_INVALID", "Issue 响应稳定身份无效。");
  }
  return `${provider}:${source}`;
}

export function mapIssueProcessError(error: unknown): never {
  if (error instanceof IssueProviderError) throw error;
  if (!(error instanceof ProcessJsonError)) return fail("WSSPEC_ISSUE_REQUEST_FAILED", "Issue Provider 请求失败。");
  if (error.code === "WSSPEC_PROCESS_EXECUTABLE_INVALID" || error.code === "WSSPEC_PROCESS_SPAWN_FAILED") {
    return fail("WSSPEC_ISSUE_MISSING_BINARY", "Issue Provider CLI 不存在或不可执行。");
  }
  if (error.code === "WSSPEC_PROCESS_INVALID_JSON" || error.code === "WSSPEC_PROCESS_OUTPUT_LIMIT") {
    return fail("WSSPEC_ISSUE_RESPONSE_INVALID", "Issue Provider 响应不符合有界 JSON 合同。");
  }
  const diagnostic = error.diagnostic.toLowerCase();
  if (/rate[ -]?limit|too many requests|\b429\b/u.test(diagnostic)) {
    return fail("WSSPEC_ISSUE_RATE_LIMITED", "Issue Provider 达到请求速率限制。");
  }
  if (/\b404\b|not found/u.test(diagnostic)) return fail("WSSPEC_ISSUE_NOT_FOUND", "Issue 目标不存在。");
  if (/\b401\b|unauthenticated|authentication required|bad credentials/u.test(diagnostic)) {
    return fail("WSSPEC_ISSUE_UNAUTHENTICATED", "Issue Provider 未认证。");
  }
  if (/\b403\b|forbidden/u.test(diagnostic)) return fail("WSSPEC_ISSUE_FORBIDDEN", "Issue Provider 拒绝访问。");
  return fail("WSSPEC_ISSUE_REQUEST_FAILED", "Issue Provider 请求失败。");
}

const githubManifestInput = {
  id: "github-cli",
  capabilities: ["github.issue", "issue.read", "issue.write", "issue.close"],
  securityClass: "external-write",
  executable: "gh",
  minimumVersion: "2.0.0",
  argvTemplates: [
    ["api", "--method", "GET", "repos/{owner}/{repo}/issues/{number}", "--hostname", "{host}"],
    ["api", "--method", "GET", "repos/{owner}/{repo}/issues/comments/{commentId}", "--hostname", "{host}"],
    ["api", "--method", "POST", "repos/{owner}/{repo}/issues/{number}/comments", "--hostname", "{host}", "--input", "-"],
    ["api", "--method", "PATCH", "repos/{owner}/{repo}/issues/{number}", "--hostname", "{host}", "--input", "-"],
  ],
  doctor: {
    version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
    auth: { kind: "auth", argv: ["auth", "status", "--active"], parser: { kind: "exit-code" }, outcomes: { authenticated: [0], unauthenticated: [1] } },
  },
  envPolicy: { allow: ["HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"] },
  timeoutMs: 30_000,
  maxStdoutBytes: 1024 * 1024,
} as const;

const gitlabManifestInput = {
  id: "gitlab-cli",
  capabilities: ["gitlab.issue", "issue.read", "issue.write", "issue.close"],
  securityClass: "external-write",
  executable: "glab",
  minimumVersion: "1.0.0",
  argvTemplates: [
    ["api", "--method", "GET", "projects/{encodedPath}/issues/{iid}", "--hostname", "{host}"],
    ["api", "--method", "GET", "projects/{encodedPath}/issues/{iid}/notes/{noteId}", "--hostname", "{host}"],
    ["api", "--method", "POST", "projects/{encodedPath}/issues/{iid}/notes", "--hostname", "{host}", "--input", "-"],
    ["api", "--method", "PUT", "projects/{encodedPath}/issues/{iid}", "--hostname", "{host}", "--input", "-"],
  ],
  doctor: {
    version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
    auth: { kind: "auth", argv: ["auth", "status"], parser: { kind: "exit-code" }, outcomes: { authenticated: [0], unauthenticated: [1] } },
  },
  envPolicy: { allow: ["HOME", "XDG_CONFIG_HOME", "GLAB_CONFIG_DIR"] },
  timeoutMs: 30_000,
  maxStdoutBytes: 1024 * 1024,
} as const;

export const githubCliManifest = defineConnectorManifest(githubManifestInput);
export const gitlabCliManifest = defineConnectorManifest(gitlabManifestInput);

function sameManifest(left: ConnectorManifest, right: ConnectorManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadManifest(filename: string, expected: ConnectorManifest): Promise<ConnectorManifest> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumManifestBytes) throw new Error("invalid file");
    const text = await readFile(filename, "utf8");
    const document = parseDocument(text, { uniqueKeys: true, schema: "core" });
    if (document.errors.length !== 0 || document.warnings.length !== 0) throw new Error("invalid yaml");
    let containsAlias = false;
    visit(document, (_key, node) => { if (isAlias(node)) containsAlias = true; });
    if (containsAlias) throw new Error("yaml aliases are not allowed");
    const manifest = defineConnectorManifest(document.toJS({ maxAliasCount: 0 }));
    if (!sameManifest(manifest, expected)) throw new Error("contract drift");
    return manifest;
  } catch {
    return fail("WSSPEC_ISSUE_MANIFEST_INVALID", "Issue Connector Manifest 不符合审计合同。");
  }
}

export function issueConnectorResourcesRoot(): string {
  return fileURLToPath(new URL("../../../resources/connectors/", import.meta.url));
}

export async function loadIssueConnectorManifests(root = issueConnectorResourcesRoot()): Promise<readonly ConnectorManifest[]> {
  if (!path.isAbsolute(root)) return fail("WSSPEC_ISSUE_MANIFEST_INVALID", "Issue Connector Manifest 根目录必须是绝对路径。");
  return Object.freeze([
    await loadManifest(path.join(root, "github-cli.yaml"), githubCliManifest),
    await loadManifest(path.join(root, "gitlab-cli.yaml"), gitlabCliManifest),
  ]);
}

export function registerIssueConnectorManifests(registry: ConnectorRegistry, manifests: readonly ConnectorManifest[]): ConnectorRegistry {
  if (manifests.length !== 2 || manifests[0]?.id !== "github-cli" || manifests[1]?.id !== "gitlab-cli"
    || !sameManifest(manifests[0], githubCliManifest) || !sameManifest(manifests[1], gitlabCliManifest)) {
    return fail("WSSPEC_ISSUE_MANIFEST_INVALID", "Issue Connector Manifest 集合不完整或顺序异常。");
  }
  registry.register(manifests[0]).register(manifests[1]);
  return registry;
}
