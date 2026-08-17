import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";
import { parse } from "yaml";

import { sha256 } from "./digests.js";
import { SchemaValidationError, validate } from "../schemas/index.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export interface ArtifactMetadata {
  artifactType: string;
  schemaVersion: 1;
  workItemId: string;
  stageId: string;
  attemptId: string;
  revision: number;
  contentHash: string;
}

export interface Artifact {
  metadata: ArtifactMetadata;
  body: string;
}

export interface ArtifactExpectation {
  repositoryRoot: string;
  artifactType: string;
  workItemId: string;
  stageId: string;
  attemptId: string;
}

export interface ArtifactReference {
  artifactType: string;
  schemaVersion: 1;
  path: string;
  mediaType: "text/markdown";
  revision: number;
  contentHash: string;
}

export class ArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

const sectionContracts: Record<string, string[]> = {
  specification: ["目标与背景", "范围", "需求", "验收条件", "约束", "排除项", "开放问题"],
  design: ["上下文与架构", "组件职责和边界", "接口与数据契约", "安全与权限", "失败与恢复", "兼容或迁移", "测试策略", "已知权衡"],
  plan: ["有序交付任务", "任务依赖", "精确文件范围", "验证方式", "人工检查点", "回滚方式"],
  tasks: ["任务"],
  "implementation-result": ["实际改动", "修改文件", "计划偏差", "验证摘要", "未完成项", "残余风险"],
  "review-result": ["Findings"],
  "verification-result": ["Gate/Evidence 矩阵", "未通过项", "覆盖限制", "残余风险"],
  "knowledge-entry": ["背景", "需求或 Bug", "关键决策", "实现摘要", "验证证据", "适用范围", "限制", "相关引用"],
};

function normalizeBody(body: string): string {
  const normalized = body
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n*$/u, "");
  return `${normalized}\n`;
}

export function computeArtifactContentHash(metadataWithoutHash: Record<string, unknown>, body: string): string {
  const canonicalMetadata = canonicalize(metadataWithoutHash);
  if (canonicalMetadata === undefined) {
    throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "Artifact 元数据无法规范化。");
  }
  return sha256(`${canonicalMetadata}\n${normalizeBody(body)}`);
}

function decodeStrict(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new ArtifactError("WSSPEC_ARTIFACT_ENCODING_INVALID", "Artifact 禁止 UTF-8 BOM。");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ArtifactError("WSSPEC_ARTIFACT_ENCODING_INVALID", "Artifact 必须是严格 UTF-8。");
  }
}

export async function readArtifact(filename: string): Promise<Artifact> {
  const content = decodeStrict(await readFile(filename));
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(content);
  if (match === null) {
    throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "Artifact 缺少完整 YAML front matter。");
  }
  let metadata: ArtifactMetadata;
  try {
    metadata = validate<ArtifactMetadata>("builtin.artifact.v1", parse(match[1]!));
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", `${error.path}: ${error.message}`);
    }
    throw error;
  }
  return { metadata, body: match[2]! };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sectionBody(type: string, section: string, body: string): string {
  const heading = new RegExp(`^#{1,6}\\s+${escapeRegExp(section)}\\s*$`, "mu");
  const match = heading.exec(body);
  if (match === null) throw new ArtifactError("WSSPEC_ARTIFACT_INCOMPLETE", `${type} 缺少必需章节：${section}`);
  const afterHeading = body.slice(match.index + match[0].length).replace(/^\r?\n/u, "");
  const nextHeading = /^#{1,6}\s+/mu.exec(afterHeading);
  const content = afterHeading.slice(0, nextHeading?.index ?? afterHeading.length).trim();
  if (content === "") throw new ArtifactError("WSSPEC_ARTIFACT_INCOMPLETE", `${type} 的必需章节为空：${section}`);
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredYaml(type: string, section: string, body: string): Record<string, unknown> {
  const fenced = /```yaml\s*\n([\s\S]*?)\n```/u.exec(sectionBody(type, section, body));
  if (fenced === null) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", `${type}.${section} 缺少 fenced YAML。`);
  const value = parse(fenced[1]!);
  if (!isRecord(value)) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", `${type}.${section} 必须是对象。`);
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", `结构化字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

function verifyStructuredContent(type: string, body: string): void {
  if (type === "tasks") {
    const tasks = structuredYaml(type, "任务", body).tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "tasks 必须是非空数组。");
    for (const task of tasks) {
      if (!isRecord(task) || !Array.isArray(task.dependencies)) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "task 结构不完整。");
      requireString(task, "id");
      requireString(task, "completion");
      if (!["pending", "in_progress", "completed", "blocked"].includes(requireString(task, "status"))) {
        throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "task.status 不合法。");
      }
    }
  }
  if (type === "review-result") {
    const findings = structuredYaml(type, "Findings", body).findings;
    if (!Array.isArray(findings)) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "findings 必须是数组。");
    for (const finding of findings) {
      if (!isRecord(finding)) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "finding 必须是对象。");
      requireString(finding, "id");
      if (!["P0", "P1", "P2", "P3"].includes(requireString(finding, "severity"))) {
        throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "finding.severity 不合法。");
      }
      requireString(finding, "description");
      requireString(finding, "evidence");
      const findingPath = requireString(finding, "path");
      if (path.isAbsolute(findingPath) || findingPath.split(/[\\/]/u).includes("..")) {
        throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "finding.path 必须是仓库相对路径。");
      }
      if (!["open", "fixed", "accepted", "false-positive"].includes(requireString(finding, "disposition"))) {
        throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "finding.disposition 不合法。");
      }
      if (finding.line !== undefined && (!Number.isInteger(finding.line) || (finding.line as number) < 1)) {
        throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "finding.line 必须是正整数。");
      }
    }
  }
  if (type === "verification-result") {
    const gates = structuredYaml(type, "Gate/Evidence 矩阵", body).gates;
    if (!Array.isArray(gates) || gates.length === 0) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "gates 必须是非空数组。");
    for (const gate of gates) {
      if (!isRecord(gate) || typeof gate.required !== "boolean") throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "gate 结构不完整。");
      for (const field of ["gateId", "expectedLevel", "evidenceId", "workspaceTreeDigest", "result"]) requireString(gate, field);
      if (!(typeof gate.occurredAt === "string" || gate.occurredAt instanceof Date)) {
        throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "gate.occurredAt 必须是时间字符串。");
      }
    }
  }
}

function verifySections(type: string, body: string): void {
  const sections = sectionContracts[type];
  if (sections === undefined) throw new ArtifactError("WSSPEC_ARTIFACT_SCHEMA_NOT_FOUND", `未注册内置 Artifact 类型：${type}`);
  for (const section of sections) sectionBody(type, section, body);
  verifyStructuredContent(type, body);
}

export async function verifyArtifact(filename: string, expected: ArtifactExpectation): Promise<ArtifactReference> {
  const [root, actual] = await Promise.all([realpath(expected.repositoryRoot), realpath(filename)]);
  const relative = path.relative(root, actual);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new ArtifactError("WSSPEC_ARTIFACT_REFERENCE_INVALID", "Artifact 路径越出仓库边界。");
  }
  const artifact = await readArtifact(actual);
  const { metadata } = artifact;
  if (
    metadata.artifactType !== expected.artifactType ||
    metadata.workItemId !== expected.workItemId ||
    metadata.stageId !== expected.stageId ||
    metadata.attemptId !== expected.attemptId
  ) {
    throw new ArtifactError("WSSPEC_ARTIFACT_REFERENCE_INVALID", "Artifact 类型或生产者身份与预期不符。");
  }
  verifySections(metadata.artifactType, artifact.body);
  const { contentHash, ...metadataWithoutHash } = metadata;
  const actualHash = computeArtifactContentHash(metadataWithoutHash, artifact.body);
  if (actualHash !== contentHash) {
    throw new ArtifactError("WSSPEC_ARTIFACT_HASH_MISMATCH", "Artifact 内容哈希与规范化内容不匹配。");
  }
  return {
    artifactType: metadata.artifactType,
    schemaVersion: metadata.schemaVersion,
    path: relative.split(path.sep).join("/"),
    mediaType: "text/markdown",
    revision: metadata.revision,
    contentHash,
  };
}
