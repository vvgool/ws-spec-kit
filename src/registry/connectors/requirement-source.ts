import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";

import { sha256 } from "../../domain/digests.js";
import { validate } from "../../schemas/index.js";
import {
  canonicalRequirementText,
  LocalRequirementError,
  readLocalRequirementFile,
} from "./local-requirement.js";
import { credentialLikeField, credentialLikeValue } from "./secret-detector.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;
const workItemIdPattern = /^WSS-[A-Za-z0-9-]+$/u;
const artifactIdPattern = /^source-([a-f0-9]{64})$/u;
const metadataKeyPattern = /^[a-z][a-zA-Z0-9]{0,63}$/u;
const prototypeKeys = new Set(["__proto__", "constructor", "prototype"]);
const metadataAllowlist: Record<NormalizedRequirementSource["type"], ReadonlySet<string>> = {
  "user.prompt": new Set(),
  "local.file": new Set(),
  "github.issue": new Set(["assignees", "author", "labels", "repository", "state"]),
  "gitlab.issue": new Set(["assignees", "author", "labels", "repository", "state"]),
  "feishu.document": new Set(["owner", "revision", "space"]),
};

export interface NormalizedRequirementSource {
  type: "user.prompt" | "local.file" | "github.issue" | "gitlab.issue" | "feishu.document";
  stableId: string;
  canonicalUrl?: string;
  title: string;
  body: string;
  updatedAt?: string;
  metadata: Record<string, string | string[]>;
}

export interface SourceArtifact extends NormalizedRequirementSource {
  version: 1;
  artifactType: "requirement-source";
  schemaVersion: 1;
  artifactId: string;
  contentDigest: string;
}

export interface SourceArtifactReference {
  artifactType: "requirement-source";
  schemaVersion: 1;
  artifactId: string;
  path: string;
  revision: 1;
  contentHash: string;
  mediaType: "application/json";
}

export type CaptureRequirementSource =
  | { type: "user.prompt"; text: string }
  | { type: "local.file"; path: string }
  | NormalizedRequirementSource;

export interface CaptureRequirementInput {
  repositoryRoot: string;
  artifactRoot: string;
  workItemId: string;
  source: CaptureRequirementSource;
}

export class SourceArtifactError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "SourceArtifactError";
  }
}

function fail(code: `WSSPEC_${string}`, message: string): never {
  throw new SourceArtifactError(code, message);
}

function normalizedScalar(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > maximum * 4) {
    return fail("WSSPEC_SOURCE_INVALID", `${label} 缺失或超过上限。`);
  }
  const normalized = (value.startsWith("\ufeff") ? value.slice(1) : value).replace(/\r\n?/gu, "\n").normalize("NFC").trim();
  if (normalized === "" || [...normalized].length > maximum
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    return fail("WSSPEC_SOURCE_INVALID", `${label} 不是有效的有界单行文本。`);
  }
  return normalized;
}

export function requirementTitle(body: string): string {
  const line = body.split("\n").find((candidate) => candidate.trim() !== "")?.trim() ?? "Requirement";
  const withoutHeading = line.replace(/^#{1,6}\s+/u, "").trim();
  return [...withoutHeading].slice(0, 512).join("") || "Requirement";
}

function normalizedUrl(value: unknown): string {
  const source = normalizedScalar(value, "canonicalUrl", 2048);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return fail("WSSPEC_SOURCE_INVALID", "canonicalUrl 必须是合法 URL。");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) return fail("WSSPEC_SOURCE_INVALID", "canonicalUrl 只允许 HTTP(S) URL。");
  const decode = (surface: string): string => {
    try { return decodeURIComponent(surface.replace(/\+/gu, "%20")); }
    catch { return fail("WSSPEC_SOURCE_INVALID", "canonicalUrl 包含不合法编码。"); }
  };
  const querySurfaces = parsed.search.slice(1).split("&").flatMap((entry) => {
    if (entry === "") return [];
    const separator = entry.indexOf("=");
    return separator < 0
      ? [decode(entry)]
      : [decode(entry.slice(0, separator)), decode(entry.slice(separator + 1))];
  });
  const surfaces = [
    decode(parsed.username),
    decode(parsed.password),
    decode(parsed.hostname),
    ...parsed.pathname.split("/").map(decode),
    ...querySurfaces,
    decode(parsed.hash.slice(1)),
  ];
  if (parsed.username !== "" || parsed.password !== "" || surfaces.some(credentialLikeField)) {
    return fail("WSSPEC_SOURCE_INVALID", "canonicalUrl 不能包含凭据样式内容。");
  }
  return parsed.toString();
}

function metadataRecord(type: NormalizedRequirementSource["type"], value: unknown): Record<string, string | string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 必须是对象。");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 不能继承自定义 prototype。");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.length > 16 || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) {
    return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 字段数量或属性类型不合法。");
  }
  const result: Record<string, string | string[]> = {};
  let aggregateBytes = 0;
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor) || prototypeKeys.has(key)
      || credentialLikeField(key) || !metadataKeyPattern.test(key)
      || !metadataAllowlist[type].has(key)) {
      return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 包含不允许的字段。");
    }
    const values = Array.isArray(descriptor.value) ? descriptor.value : [descriptor.value];
    if (values.length === 0 || values.length > 32 || values.some((item) => typeof item !== "string")) {
      return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 数组不合法。");
    }
    const normalized = values.map((item) => {
      let current: string;
      try {
        current = normalizedScalar(item, "metadata value", 256);
      } catch {
        return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 值不合法。");
      }
      if (credentialLikeValue(current)) return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 包含凭据样式内容。");
      aggregateBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(current, "utf8");
      return current;
    });
    if (aggregateBytes > 16_384) return fail("WSSPEC_SOURCE_METADATA_INVALID", "metadata 总大小超过上限。");
    result[key] = Array.isArray(descriptor.value) ? normalized : normalized[0]!;
  }
  return result;
}

function normalizeProvider(source: NormalizedRequirementSource): NormalizedRequirementSource {
  if (!Object.hasOwn(metadataAllowlist, source.type)) return fail("WSSPEC_SOURCE_TYPE_UNSUPPORTED", "不支持该需求来源类型。");
  const body = canonicalRequirementText(source.body);
  let updatedAt: string | undefined;
  if (source.updatedAt !== undefined) {
    const value = normalizedScalar(source.updatedAt, "updatedAt", 64);
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return fail("WSSPEC_SOURCE_INVALID", "updatedAt 必须是合法时间。");
    updatedAt = new Date(timestamp).toISOString();
  }
  return {
    type: source.type,
    stableId: normalizedScalar(source.stableId, "stableId", 512),
    ...(source.canonicalUrl === undefined ? {} : { canonicalUrl: normalizedUrl(source.canonicalUrl) }),
    title: normalizedScalar(source.title, "title", 512),
    body,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    metadata: metadataRecord(source.type, source.metadata),
  };
}

function artifactDigest(artifact: Omit<SourceArtifact, "artifactId">): string {
  const encoded = canonicalize(artifact);
  if (encoded === undefined) return fail("WSSPEC_SOURCE_INVALID", "需求来源无法规范化为 JSON。");
  return sha256(encoded);
}

function artifactFromSource(source: NormalizedRequirementSource): SourceArtifact {
  const unsigned: Omit<SourceArtifact, "artifactId"> = {
    version: 1,
    artifactType: "requirement-source",
    schemaVersion: 1,
    ...source,
    contentDigest: sha256(source.body),
  };
  const digest = artifactDigest(unsigned);
  return validate<SourceArtifact>("builtin.source-artifact.v1", {
    ...unsigned,
    artifactId: `source-${digest.slice("sha256:".length)}`,
  });
}

function referencePath(workItemId: string, artifactId: string): string {
  if (!workItemIdPattern.test(workItemId)) return fail("WSSPEC_SOURCE_INVALID", "Work Item ID 不合法。");
  const match = artifactIdPattern.exec(artifactId);
  if (match === null) return fail("WSSPEC_SOURCE_INVALID", "Source Artifact ID 不合法。");
  return `.wsspec/work-items/${workItemId}/source/${match[1]}.json`;
}

export function sourceArtifactReference(workItemId: string, artifact: SourceArtifact): SourceArtifactReference {
  const match = artifactIdPattern.exec(artifact.artifactId);
  if (match === null) return fail("WSSPEC_SOURCE_INVALID", "Source Artifact ID 不合法。");
  return {
    artifactType: "requirement-source",
    schemaVersion: 1,
    artifactId: artifact.artifactId,
    path: referencePath(workItemId, artifact.artifactId),
    revision: 1,
    contentHash: `sha256:${match[1]}`,
    mediaType: "application/json",
  };
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectoryIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

function assertSafeDirectory(target: BigIntStats): void {
  const uid = process.getuid?.();
  if (uid === undefined || !target.isDirectory() || target.uid !== BigInt(uid) || (target.mode & 0o022n) !== 0n) {
    fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 目录必须由当前用户拥有且不可被组或其他用户写入。");
  }
}

async function authenticateArtifactRoot(repositoryRoot: string | undefined, artifactRoot: string): Promise<{ root: string; identity: BigIntStats }> {
  let supplied: BigIntStats;
  try { supplied = await lstat(artifactRoot, { bigint: true }); }
  catch { return fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 根目录不存在或不可验证。"); }
  if (supplied.isSymbolicLink()) return fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 根目录不能是符号链接。");
  assertSafeDirectory(supplied);
  const root = await realpath(artifactRoot);
  const canonical = await lstat(root, { bigint: true });
  assertSafeDirectory(canonical);
  if (!sameDirectoryIdentity(supplied, canonical)) return fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 根目录身份不稳定。");
  if (repositoryRoot !== undefined) {
    const repository = await realpath(repositoryRoot);
    const relative = path.relative(repository, root);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 根目录必须位于当前仓库或 worktree 内。");
    }
  }
  return { root, identity: canonical };
}

async function ensureArtifactDirectory(repositoryRoot: string, artifactRoot: string, relativeDirectory: string): Promise<string> {
  const authenticated = await authenticateArtifactRoot(repositoryRoot, artifactRoot);
  let current = authenticated.root;
  for (const part of relativeDirectory.split("/")) {
    current = path.join(current, part);
    let target: BigIntStats;
    try {
      target = await lstat(current, { bigint: true });
      if (target.isSymbolicLink()) return fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 目录包含符号链接。");
      assertSafeDirectory(target);
    } catch (error) {
      if (error instanceof SourceArtifactError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      target = await lstat(current, { bigint: true });
      if (target.isSymbolicLink()) return fail("WSSPEC_SOURCE_PATH_INVALID", "并发创建的 Artifact 目录不安全。");
      assertSafeDirectory(target);
    }
    const canonical = await realpath(current);
    const rechecked = await lstat(current, { bigint: true });
    if (canonical !== current || !sameDirectoryIdentity(target, rechecked)) {
      return fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 目录在创建或验证期间被替换。");
    }
    assertSafeDirectory(rechecked);
  }
  const rootAfter = await lstat(authenticated.root, { bigint: true });
  if (!sameDirectoryIdentity(authenticated.identity, rootAfter)) {
    return fail("WSSPEC_SOURCE_PATH_INVALID", "Artifact 根目录在创建期间被替换。");
  }
  assertSafeDirectory(rootAfter);
  return current;
}

async function readExistingBytes(filename: string, maximum: number): Promise<Buffer> {
  let pathBefore: BigIntStats;
  try { pathBefore = await lstat(filename, { bigint: true }); }
  catch { return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "同摘要 Artifact 不可读取或已变化。"); }
  if (!pathBefore.isFile() || pathBefore.nlink !== 1n || pathBefore.size > BigInt(maximum)) {
    return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "同摘要 Artifact 必须是单链接普通文件。");
  }
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "同摘要 Artifact 不是可验证的普通文件。");
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)
      || !sameFileIdentity(pathBefore, before)) return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "同摘要 Artifact 不合法。");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    let pathAfter: BigIntStats;
    try { pathAfter = await lstat(filename, { bigint: true }); }
    catch { return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "同摘要 Artifact 在读取期间消失。"); }
    if (after.nlink !== 1n || !sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter)
      || BigInt(bytes.length) !== before.size) {
      return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "同摘要 Artifact 在读取期间发生变化。");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readSettledExistingBytes(filename: string, maximum: number): Promise<Buffer> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const target = await lstat(filename, { bigint: true });
      if (target.nlink !== 2n) break;
    } catch {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  return readExistingBytes(filename, maximum);
}

async function writeNoClobber(filename: string, bytes: Buffer): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readSettledExistingBytes(filename, bytes.length + 1);
      if (!existing.equals(bytes)) return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "同摘要 Artifact 的现有字节不一致，拒绝覆盖。");
      return;
    }
    await unlink(temporary);
    const written = await readExistingBytes(filename, bytes.length + 1);
    if (!written.equals(bytes)) return fail("WSSPEC_SOURCE_ARTIFACT_CONFLICT", "新建 Artifact 的最终字节不一致。");
    const directory = await open(path.dirname(filename), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function normalizedInput(input: CaptureRequirementInput): Promise<NormalizedRequirementSource> {
  const source = input.source;
  try {
    if (source.type === "user.prompt" && "text" in source) {
      const body = canonicalRequirementText(source.text);
      return { type: "user.prompt", stableId: sha256(body), title: requirementTitle(body), body, metadata: {} };
    }
    if (source.type === "local.file" && "path" in source) {
      const captured = await readLocalRequirementFile(input.repositoryRoot, source.path);
      return { type: "local.file", stableId: captured.path, title: requirementTitle(captured.text), body: captured.text, metadata: {} };
    }
    return normalizeProvider(source as NormalizedRequirementSource);
  } catch (error) {
    if (error instanceof SourceArtifactError) throw error;
    if (error instanceof LocalRequirementError) throw new SourceArtifactError(error.code, error.message.slice(error.code.length + 2));
    throw error;
  }
}

export async function captureRequirement(input: CaptureRequirementInput): Promise<SourceArtifact> {
  const source = await normalizedInput(input);
  const artifact = artifactFromSource(source);
  const encoded = canonicalize(artifact);
  if (encoded === undefined) return fail("WSSPEC_SOURCE_INVALID", "Source Artifact 无法规范化。");
  const reference = sourceArtifactReference(input.workItemId, artifact);
  const relativeDirectory = path.posix.dirname(reference.path);
  const directory = await ensureArtifactDirectory(input.repositoryRoot, input.artifactRoot, relativeDirectory);
  await writeNoClobber(path.join(directory, path.posix.basename(reference.path)), Buffer.from(`${encoded}\n`, "utf8"));
  return artifact;
}

function strictArtifact(value: unknown): SourceArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact Schema 不合法。");
  const source = value as Record<string, unknown>;
  const optional = ["canonicalUrl", "updatedAt"].filter((key) => Object.hasOwn(source, key));
  const expected = ["artifactId", "artifactType", "body", "contentDigest", "metadata", "schemaVersion", "stableId", "title", "type", "version", ...optional].sort();
  if (Object.keys(source).sort().join("\0") !== expected.join("\0")
    || source.version !== 1 || source.schemaVersion !== 1 || source.artifactType !== "requirement-source"
    || typeof source.artifactId !== "string" || typeof source.contentDigest !== "string") {
    return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact Schema 不合法。");
  }
  try {
    validate("builtin.source-artifact.v1", value);
  } catch {
    return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact Schema 不合法。");
  }
  let normalized: NormalizedRequirementSource;
  try {
    normalized = normalizeProvider({
      type: source.type as NormalizedRequirementSource["type"],
      stableId: source.stableId as string,
      ...(source.canonicalUrl === undefined ? {} : { canonicalUrl: source.canonicalUrl as string }),
      title: source.title as string,
      body: source.body as string,
      ...(source.updatedAt === undefined ? {} : { updatedAt: source.updatedAt as string }),
      metadata: source.metadata as Record<string, string | string[]>,
    });
  } catch {
    return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 字段不合法。");
  }
  const rebuilt = artifactFromSource(normalized);
  if (canonicalize(rebuilt) !== canonicalize(value)) return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 摘要或规范值不一致。");
  return rebuilt;
}

export async function verifySourceArtifact(artifactRoot: string, workItemId: string, reference: SourceArtifactReference): Promise<SourceArtifact> {
  const expectedPath = referencePath(workItemId, reference.artifactId);
  const match = artifactIdPattern.exec(reference.artifactId);
  if (reference.artifactType !== "requirement-source" || reference.schemaVersion !== 1 || reference.revision !== 1
    || reference.mediaType !== "application/json" || reference.path !== expectedPath
    || match === null || reference.contentHash !== `sha256:${match[1]}`) {
    return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 引用不合法。");
  }
  const root = (await authenticateArtifactRoot(undefined, artifactRoot)).root;
  const filename = path.join(root, reference.path);
  const relative = path.relative(root, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return fail("WSSPEC_SOURCE_PATH_INVALID", "Source Artifact 越出允许边界。");
  let canonicalFilename: string;
  try { canonicalFilename = await realpath(filename); }
  catch { return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 不存在或无法解析真实路径。"); }
  if (canonicalFilename !== filename) return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 路径包含符号链接。");
  let bytes: Buffer;
  try {
    bytes = await readExistingBytes(filename, 1_200_000);
  } catch (error) {
    if (error instanceof SourceArtifactError) throw new SourceArtifactError("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 不可读取或已变化。");
    throw error;
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 不是 UTF-8 JSON。"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 不是合法 JSON。"); }
  const artifact = strictArtifact(parsed);
  const encoded = canonicalize(artifact);
  if (artifact.artifactId !== reference.artifactId || encoded === undefined || text !== `${encoded}\n`) {
    return fail("WSSPEC_SOURCE_SNAPSHOT_CHANGED", "Source Artifact 磁盘字节或摘要已变化。");
  }
  return artifact;
}
