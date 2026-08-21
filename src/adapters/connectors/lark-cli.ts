import { spawnJson } from "../process/spawn-json.js";
import { sha256 } from "../../domain/digests.js";
import { type ExternalReceipt } from "../../domain/external-receipt.js";
import {
  FeishuDocumentError,
  mapFeishuProcessError,
  validateFeishuDocumentTarget,
  validateLarkEnvironment,
  validateLarkIdentity,
  type LarkEnvironment,
  type LarkIdentity,
  type ValidatedFeishuDocumentTarget,
} from "../../registry/connectors/feishu-document.js";
import { canonicalRequirementText, MAX_REQUIREMENT_BYTES } from "../../registry/connectors/local-requirement.js";
import { credentialLikeValue, inspectDecodedCredentialSurface, inspectDecodedCredentialText } from "../../registry/connectors/secret-detector.js";
import type { NormalizedRequirementSource } from "../../registry/connectors/requirement-source.js";
import {
  KnowledgePublishError,
  mapKnowledgeError,
  validateKnowledgeBinding,
  validateKnowledgePublishTarget,
  type KnowledgePublishTarget,
} from "../../registry/connectors/knowledge-publish.js";

const timeoutMs = 30_000;
const maxStdoutBytes = 1024 * 1024;
const pageLimit = 100;
const pageSize = 100;

export interface FeishuDocumentReadInput {
  executable: string;
  document: string;
  identity?: LarkIdentity;
  environment?: LarkEnvironment;
}

export interface NormalizedFeishuDocument extends NormalizedRequirementSource {
  type: "feishu.document";
  documentToken: string;
}

export interface PublishKnowledgeInput {
  executable: string;
  target: KnowledgePublishTarget;
  binding: unknown;
  identity?: LarkIdentity;
  environment?: LarkEnvironment;
  markDispatched?(): Promise<void>;
}

interface FetchPage {
  documentToken: string;
  canonicalUrl: string;
  title: string;
  markdown: string;
  hasMore: boolean;
  nextOffset?: string;
  updatedAt?: string;
  metadata: Record<string, string | string[]>;
  identity: string;
}

function invalidResponse(): never {
  throw new FeishuDocumentError("WSSPEC_FEISHU_RESPONSE_INVALID", "飞书文档响应不符合受审计 Schema。");
}

function record(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || required.some((key) => !Object.hasOwn(value, key))) return invalidResponse();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes || value.includes("\0") || (!allowEmpty && value === "")) {
    return invalidResponse();
  }
  return value.normalize("NFC");
}

function normalizedTitle(value: unknown): string {
  if (typeof value !== "string") return invalidResponse();
  if (!inspectDecodedCredentialText(value, { maximumBytes: 2_048, maximumDecodeRounds: 4 }).ok) return invalidResponse();
  const source = text(value, 2_048);
  const result = source.trim();
  if (result === "" || [...result].length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(result)
    || !inspectDecodedCredentialText(result, { maximumBytes: 2_048, maximumDecodeRounds: 4 }).ok) return invalidResponse();
  return result;
}

function confidentialMarkdown(value: unknown): string {
  if (typeof value !== "string") return invalidResponse();
  if (!inspectDecodedCredentialText(value, { maximumBytes: MAX_REQUIREMENT_BYTES, maximumDecodeRounds: 4 }).ok) return invalidResponse();
  const result = text(value, MAX_REQUIREMENT_BYTES, true);
  if (!inspectDecodedCredentialText(result, { maximumBytes: MAX_REQUIREMENT_BYTES, maximumDecodeRounds: 4 }).ok) return invalidResponse();
  return result;
}

function metadataValue(value: unknown): string {
  if (typeof value !== "string") return invalidResponse();
  if (!inspectDecodedCredentialSurface(value, { maximumBytes: 1_024, maximumDecodeRounds: 4 }).ok) return invalidResponse();
  const result = text(value, 256);
  if (!inspectDecodedCredentialSurface(result, { maximumBytes: 1_024, maximumDecodeRounds: 4 }).ok) return invalidResponse();
  return result;
}

function canonicalPageIdentity(input: Omit<FetchPage, "hasMore" | "identity" | "markdown" | "nextOffset">): string {
  const metadata = Object.entries(input.metadata).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value].sort((left, right) => left.localeCompare(right)) : value,
  ]);
  return JSON.stringify({
    documentToken: input.documentToken,
    canonicalUrl: input.canonicalUrl,
    title: input.title,
    updatedAt: input.updatedAt ?? null,
    metadata,
  });
}

function timestamp(value: unknown): string {
  const source = text(value, 64);
  const parsed = Date.parse(source);
  if (!Number.isFinite(parsed)) return invalidResponse();
  return new Date(parsed).toISOString();
}

function canonicalResponseUrl(value: unknown, token: string, input: ValidatedFeishuDocumentTarget): string {
  const source = text(value, 2_048);
  let target: ValidatedFeishuDocumentTarget;
  try { target = validateFeishuDocumentTarget(source); }
  catch { return invalidResponse(); }
  const accepted = target.documentToken === token || (input.kind === "wiki" && target.documentToken === input.documentToken);
  if (!accepted) return invalidResponse();
  return target.canonicalInputUrl ?? invalidResponse();
}

function offset(value: unknown): string {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return invalidResponse();
  return String(parsed);
}

function fetchPage(value: unknown, input: ValidatedFeishuDocumentTarget): FetchPage {
  const source = record(value, ["doc_id", "doc_url", "has_more", "markdown", "revision", "title"]);
  const documentToken = text(source.doc_id, 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(documentToken)
    || credentialLikeValue(documentToken)
    || (input.kind !== "wiki" && documentToken !== input.documentToken)
    || typeof source.has_more !== "boolean") return invalidResponse();
  const metadata: Record<string, string | string[]> = {};
  for (const key of ["owner", "revision", "space"] as const) {
    if (source[key] !== undefined) {
      metadata[key] = metadataValue(source[key]);
    }
  }
  const page = {
    documentToken,
    canonicalUrl: canonicalResponseUrl(source.doc_url, documentToken, input),
    title: normalizedTitle(source.title),
    markdown: confidentialMarkdown(source.markdown),
    hasMore: source.has_more,
    ...(source.has_more ? { nextOffset: offset(source.next_offset) } : {}),
    ...(source.updated_at === undefined ? {} : { updatedAt: timestamp(source.updated_at) }),
    metadata,
  };
  return { ...page, identity: canonicalPageIdentity(page) };
}

async function execute(input: {
  executable: string;
  argv: readonly string[];
  payload?: unknown;
  environment?: LarkEnvironment;
  secrets?: readonly string[];
}): Promise<unknown> {
  try {
    return (await spawnJson({
      executable: input.executable,
      argv: input.argv,
      input: input.payload ?? {},
      timeoutMs,
      maxStdoutBytes,
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
      ...(() => {
        const environment = validateLarkEnvironment(input.environment);
        return environment === undefined ? {} : { environment };
      })(),
    })).value;
  } catch (error) {
    return mapFeishuProcessError(error);
  }
}

function fetchArgv(token: string, identity: LarkIdentity, nextOffset?: string): readonly string[] {
  return nextOffset === undefined
    ? ["docs", "+fetch", "--doc", token, "--format", "json", "--as", identity]
    : ["docs", "+fetch", "--doc", token, "--offset", nextOffset, "--limit", String(pageSize), "--format", "json", "--as", identity];
}

async function fetchDocument(input: FeishuDocumentReadInput, requiredToken?: string): Promise<NormalizedFeishuDocument> {
  const target = validateFeishuDocumentTarget(input.document);
  const identity = validateLarkIdentity(input.identity);
  const pages: FetchPage[] = [];
  const seenOffsets = new Set<string>();
  let nextOffset: string | undefined;
  let totalBytes = 0;
  for (let index = 0; index < pageLimit; index += 1) {
    const page = fetchPage(await execute({
      executable: input.executable,
      argv: fetchArgv(target.documentToken, identity, nextOffset),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    }), target);
    if (requiredToken !== undefined && page.documentToken !== requiredToken) return invalidResponse();
    const first = pages[0];
    if (first !== undefined && page.identity !== first.identity) {
      return invalidResponse();
    }
    totalBytes += Buffer.byteLength(page.markdown, "utf8");
    if (totalBytes > MAX_REQUIREMENT_BYTES) {
      throw new FeishuDocumentError("WSSPEC_FEISHU_RESPONSE_TOO_LARGE", "飞书分页正文总量超过上限。");
    }
    pages.push(page);
    if (!page.hasMore) break;
    if (page.nextOffset === undefined || seenOffsets.has(page.nextOffset)) {
      throw new FeishuDocumentError("WSSPEC_FEISHU_PAGINATION_INVALID", "飞书分页 cursor 缺失或形成循环。");
    }
    seenOffsets.add(page.nextOffset);
    nextOffset = page.nextOffset;
  }
  const last = pages.at(-1);
  if (last === undefined || last.hasMore) {
    throw new FeishuDocumentError("WSSPEC_FEISHU_PAGINATION_INVALID", "飞书分页超过最大页数。");
  }
  const first = pages[0]!;
  let body: string;
  try { body = canonicalRequirementText(pages.map((page) => page.markdown).join("")); }
  catch (error) {
    const code = (error as { code?: string }).code === "WSSPEC_SOURCE_TOO_LARGE" ? "WSSPEC_FEISHU_RESPONSE_TOO_LARGE" : "WSSPEC_FEISHU_RESPONSE_INVALID";
    throw new FeishuDocumentError(code, "飞书文档 Markdown 无法规范化。");
  }
  return {
    type: "feishu.document",
    stableId: `feishu:${first.documentToken}`,
    documentToken: first.documentToken,
    canonicalUrl: first.canonicalUrl,
    title: first.title,
    body,
    ...(first.updatedAt === undefined ? {} : { updatedAt: first.updatedAt }),
    metadata: first.metadata,
  };
}

export async function readFeishuDocument(input: FeishuDocumentReadInput): Promise<NormalizedFeishuDocument> {
  return fetchDocument(input);
}

function mapWriteResponse(value: unknown, operation: "create" | "update", expectedToken?: string): string {
  if (operation === "create") {
    const source = record(value, ["doc_id", "doc_url"]);
    const token = text(source.doc_id, 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(token) || credentialLikeValue(token)) return invalidResponse();
    let responseUrl: ValidatedFeishuDocumentTarget;
    try { responseUrl = validateFeishuDocumentTarget(text(source.doc_url, 2_048)); }
    catch { return invalidResponse(); }
    if (responseUrl.kind !== "wiki" && responseUrl.documentToken !== token) return invalidResponse();
    return token;
  }
  const source = record(value, ["doc_id", "mode", "success"]);
  if (source.success !== true || source.mode !== "overwrite") return invalidResponse();
  const token = text(source.doc_id, 128);
  if (token !== expectedToken) return invalidResponse();
  return token;
}

export async function publishKnowledge(input: PublishKnowledgeInput): Promise<ExternalReceipt> {
  const target = validateKnowledgePublishTarget(input.target);
  const binding = validateKnowledgeBinding(input.binding, target);
  const identity = validateLarkIdentity(input.identity);
  const secrets = [...new Set([input.target.markdown, target.markdown])];
  const argv = target.operation === "create"
    ? ["docs", "+create", "--title", target.title, target.targetFlag, target.targetToken, "--markdown", target.markdown, "--as", identity]
    : ["docs", "+update", "--doc", target.documentToken, "--mode", "overwrite", "--markdown", target.markdown, "--new-title", target.title, "--as", identity];
  let token: string;
  try {
    if (target.operation === "update" && input.markDispatched !== undefined) {
      await fetchDocument({
        executable: input.executable,
        document: target.documentToken,
        identity,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      }, target.documentToken);
    }
    await input.markDispatched?.();
    token = mapWriteResponse(await execute({
      executable: input.executable,
      argv,
      payload: { operation: target.operation },
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      secrets,
    }), target.operation, target.operation === "update" ? target.documentToken : undefined);
  } catch (error) {
    return mapKnowledgeError(error, false);
  }
  let readBack: NormalizedFeishuDocument;
  try {
    readBack = await fetchDocument({
      executable: input.executable,
      document: token,
      identity,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    }, token);
  } catch (error) {
    return mapKnowledgeError(error, true);
  }
  const publishedMarkdownDigest = sha256(target.markdown);
  const readBackMarkdownDigest = sha256(readBack.body);
  if (readBack.documentToken !== token || readBack.title !== target.title || readBackMarkdownDigest !== publishedMarkdownDigest) {
    throw new KnowledgePublishError("WSSPEC_KNOWLEDGE_READBACK_MISMATCH", "知识发布回读的 token、标题或 Markdown 摘要不一致。");
  }
  return {
    version: 1,
    kind: "external-receipt",
    target: "knowledge",
    stableId: binding.stableId,
    externalWorkItemId: binding.externalWorkItemId,
    publishStepId: binding.publishStepId,
    publishAttemptId: binding.publishAttemptId,
    publishInputDigest: binding.publishInputDigest,
    publishedContentDigest: publishedMarkdownDigest,
    readBackContentDigest: readBackMarkdownDigest,
    status: "confirmed",
    readBackStatus: "confirmed",
  };
}
