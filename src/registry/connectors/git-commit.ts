import path from "node:path";

import { inspectDecodedCredentialText } from "./secret-detector.js";
import { defineConnectorManifest } from "./manifest.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const allowedApprovalKeys = new Set([
  "baselineRevision",
  "diffDigest",
  "files",
  "message",
  "repositoryCommonDir",
  "repositoryRoot",
]);
const maximumFiles = 1_000;
const maximumMessageBytes = 64 * 1024;
const maximumPathBytes = 4_096;

export interface GitCommitApproval {
  repositoryRoot: string;
  repositoryCommonDir: string;
  baselineRevision: string;
  files: string[];
  message: string;
  diffDigest: `sha256:${string}`;
}

export interface GitCommitReceipt {
  version: 1;
  kind: "git-commit-receipt";
  provider: "git-native";
  action: "git.commit";
  repositoryCommonDir: string;
  baselineRevision: string;
  messageDigest: `sha256:${string}`;
  diffDigest: `sha256:${string}`;
  commitOid: string;
  parentOid: string;
  treeOid: string;
  files: string[];
  readBackDigest: `sha256:${string}`;
  status: "verified";
  verifiedAt: string;
}

export class GitCommitError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "GitCommitError";
  }
}

export function failGitCommit(code: `WSSPEC_${string}`, message: string): never {
  throw new GitCommitError(code, message);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "Git commit 批准输入必须是普通对象。");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedApprovalKeys.has(key))
    || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))
    || Object.keys(value).length !== allowedApprovalKeys.size) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "Git commit 批准输入字段不完整或包含额外字段。");
  }
  return value as Record<string, unknown>;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || !path.isAbsolute(value)
    || path.normalize(value) !== value || Buffer.byteLength(value, "utf8") > maximumPathBytes) {
    return failGitCommit("WSSPEC_GIT_REPOSITORY_MISMATCH", "批准的仓库路径必须是规范绝对路径。");
  }
  return value;
}

function approvedFile(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\")
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === "." || value === ".."
    || value.startsWith("../") || value === ".git" || value.startsWith(".git/")
    || value.normalize("NFC") !== value || Buffer.byteLength(value, "utf8") > maximumPathBytes) {
    return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件必须是仓库内规范相对路径。");
  }
  return value.normalize("NFC");
}

function commitMessage(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumMessageBytes) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "Git commit message 无效或超过上限。");
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trimEnd();
  if (normalized.trim() === "" || !inspectDecodedCredentialText(normalized, {
    maximumBytes: maximumMessageBytes,
    maximumDecodeRounds: 4,
  }).ok) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "Git commit message 为空或包含凭据样式内容。");
  }
  return normalized;
}

export function validateGitCommitApproval(value: unknown): Readonly<GitCommitApproval> {
  const source = plainRecord(value);
  const repositoryRoot = absolutePath(source.repositoryRoot);
  const repositoryCommonDir = absolutePath(source.repositoryCommonDir);
  if (typeof source.baselineRevision !== "string" || !oidPattern.test(source.baselineRevision)) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "批准的 baseline revision 必须是完整 Git OID。");
  }
  if (typeof source.diffDigest !== "string" || !digestPattern.test(source.diffDigest)) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "批准的 diff digest 无效。");
  }
  if (!Array.isArray(source.files) || source.files.length === 0 || source.files.length > maximumFiles) {
    return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件列表不能为空或超过上限。");
  }
  const files = source.files.map(approvedFile);
  const sorted = [...files].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (new Set(files).size !== files.length) {
    return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件列表不能包含重复路径。");
  }
  return Object.freeze({
    repositoryRoot,
    repositoryCommonDir,
    baselineRevision: source.baselineRevision,
    files: Object.freeze(sorted) as unknown as string[],
    message: commitMessage(source.message),
    diffDigest: source.diffDigest as `sha256:${string}`,
  });
}

export const gitCommitManifest = defineConnectorManifest({
  id: "git-native",
  capabilities: ["git.commit"],
  securityClass: "local-write",
  executable: "git",
  minimumVersion: "2.20.0",
  argvTemplates: [
    ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"],
    ["-c", "core.fsmonitor=false", "check-attr", "-z", "--stdin", "filter"],
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    ["-c", "core.fsmonitor=false", "read-tree", "{baselineRevision}"],
    ["-c", "core.fsmonitor=false", "--literal-pathspecs", "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
    ["-c", "core.fsmonitor=false", "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "{baselineRevision}", "--"],
    ["-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "commit", "--file=-", "--cleanup=verbatim"],
    ["-c", "core.fsmonitor=false", "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "{parentOid}", "{commitOid}", "--"],
  ],
  doctor: {
    version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
    auth: { kind: "none" },
  },
  envPolicy: { allow: ["HOME", "XDG_CONFIG_HOME"] },
  timeoutMs: 30_000,
  maxStdoutBytes: 16 * 1024 * 1024,
});
