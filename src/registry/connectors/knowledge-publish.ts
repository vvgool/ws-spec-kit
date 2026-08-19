import { canonicalRequirementText, MAX_REQUIREMENT_BYTES, MAX_REQUIREMENT_CHARACTERS } from "./local-requirement.js";
import { parseExternalBinding, type ExternalBinding } from "../../domain/external-receipt.js";
import { sha256 } from "../../domain/digests.js";
import { credentialLikeValue, inspectDecodedCredentialSurface } from "./secret-detector.js";
import { validateFeishuDocumentTarget } from "./feishu-document.js";

const tokenPattern = /^[A-Za-z0-9_-]{8,128}$/u;
const spacePattern = /^(?:[1-9][0-9]{5,31}|my_library)$/u;
const allowedKeys = new Set(["documentToken", "folderToken", "markdown", "title", "wikiNode", "wikiSpace"]);

export interface KnowledgePublishTarget {
  documentToken?: string;
  folderToken?: string;
  wikiNode?: string;
  wikiSpace?: string;
  title: string;
  markdown: string;
}

export type ValidatedKnowledgePublishTarget =
  | Readonly<{ operation: "update"; documentToken: string; title: string; markdown: string; stableId: string }>
  | Readonly<{ operation: "create"; targetFlag: "--folder-token" | "--wiki-node" | "--wiki-space"; targetToken: string; title: string; markdown: string; stableId: string }>;

export class KnowledgePublishError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "KnowledgePublishError";
  }
}

function fail(code: `WSSPEC_${string}`, message: string): never {
  throw new KnowledgePublishError(code, message);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "知识发布目标包含不允许的字段。");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))
    || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) {
    return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "知识发布目标包含不允许的属性。");
  }
  return value as Record<string, unknown>;
}

function title(value: unknown): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 3_200) {
    return fail("WSSPEC_KNOWLEDGE_CONTENT_INVALID", "知识发布标题无效。");
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized === "" || [...normalized].length > 800 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
    || credentialLikeValue(normalized)) {
    return fail("WSSPEC_KNOWLEDGE_CONTENT_INVALID", "知识发布标题必须是有界单行文本。");
  }
  return normalized;
}

function markdown(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REQUIREMENT_BYTES || [...value].length > MAX_REQUIREMENT_CHARACTERS) {
    return fail("WSSPEC_KNOWLEDGE_CONTENT_INVALID", "知识发布 Markdown 超过上限。");
  }
  try { return canonicalRequirementText(value); }
  catch { return fail("WSSPEC_KNOWLEDGE_CONTENT_INVALID", "知识发布 Markdown 无效。"); }
}

function decoded(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 2_048) {
    return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", `${label} 无效。`);
  }
  const inspected = inspectDecodedCredentialSurface(value, { detectCredentialKeys: true, maximumBytes: 8_192, maximumDecodeRounds: 4 });
  if (!inspected.ok) return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", `${label} 无效或包含凭据样式内容。`);
  return inspected.value.normalize("NFC");
}

function plainToken(value: unknown, label: string): string {
  const result = decoded(value, label);
  if (!tokenPattern.test(result)) return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", `${label} 必须是规范 token。`);
  return result;
}

function folderToken(value: unknown): string {
  const source = decoded(value, "folderToken");
  if (source.includes("://")) {
    let url: URL;
    try { url = new URL(source); }
    catch { return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "folderToken URL 无效。"); }
    const parts = url.pathname.split("/").filter(Boolean);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.port !== "" || (!host.endsWith(".feishu.cn") && !host.endsWith(".larksuite.com"))
      || parts.length !== 3 || parts[0] !== "drive" || parts[1] !== "folder"
      || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
      return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "folderToken URL 无效。");
    }
    return plainToken(parts[2], "folderToken");
  }
  return plainToken(source, "folderToken");
}

function wikiNode(value: unknown): string {
  const source = decoded(value, "wikiNode");
  if (source.includes("://")) {
    const target = documentTarget(source);
    if (target.kind !== "wiki") return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "wikiNode URL 无效。");
    return target.documentToken;
  }
  return plainToken(source, "wikiNode");
}

function documentTarget(value: unknown) {
  try { return validateFeishuDocumentTarget(value); }
  catch { return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "文档或 wiki 目标无效。"); }
}

function wikiSpace(value: unknown): string {
  const result = decoded(value, "wikiSpace");
  if (!spacePattern.test(result)) return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "wikiSpace 无效。");
  return result;
}

export function validateKnowledgePublishTarget(value: unknown): ValidatedKnowledgePublishTarget {
  const source = record(value);
  const normalizedTitle = title(source.title);
  const normalizedMarkdown = markdown(source.markdown);
  const createKeys = ["folderToken", "wikiNode", "wikiSpace"].filter((key) => source[key] !== undefined);
  if (source.documentToken !== undefined) {
    if (createKeys.length !== 0) return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "更新文档不能同时指定创建目标。");
    const target = documentTarget(source.documentToken);
    if (target.kind !== "token") return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "更新必须指定已解析的文档 token。");
    return { operation: "update", documentToken: target.documentToken, title: normalizedTitle, markdown: normalizedMarkdown, stableId: `feishu:${target.documentToken}` };
  }
  if (createKeys.length !== 1) return fail("WSSPEC_KNOWLEDGE_TARGET_INVALID", "创建文档必须在 folderToken、wikiNode、wikiSpace 中精确选择一个。");
  const key = createKeys[0]!;
  const targetToken = key === "folderToken" ? folderToken(source[key]) : key === "wikiNode" ? wikiNode(source[key]) : wikiSpace(source[key]);
  const targetFlag = key === "folderToken" ? "--folder-token" : key === "wikiNode" ? "--wiki-node" : "--wiki-space";
  return { operation: "create", targetFlag, targetToken, title: normalizedTitle, markdown: normalizedMarkdown, stableId: `feishu-target:${targetToken}` };
}

export function validateKnowledgeBinding(value: unknown, target: ValidatedKnowledgePublishTarget): ExternalBinding {
  const binding = parseExternalBinding(value);
  if (binding === undefined || binding.target !== "knowledge" || binding.stableId !== target.stableId
    || binding.expectedPublishedContentDigest !== sha256(target.markdown)) {
    return fail("WSSPEC_KNOWLEDGE_BINDING_INVALID", "知识发布必须绑定当前严格 ExternalBinding。");
  }
  return binding;
}

export function mapKnowledgeError(error: unknown, readBack: boolean): never {
  if (error instanceof KnowledgePublishError) throw error;
  if (readBack) return fail("WSSPEC_KNOWLEDGE_READBACK_FAILED", "知识发布写入后的回读失败。");
  return fail("WSSPEC_KNOWLEDGE_WRITE_FAILED", "知识发布写入失败。");
}
