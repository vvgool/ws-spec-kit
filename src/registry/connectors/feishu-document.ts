import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isAlias, parseDocument, visit } from "yaml";

import { ProcessJsonError } from "../../adapters/process/spawn-json.js";
import { defineConnectorManifest } from "./manifest.js";
import { ConnectorRegistry } from "./registry.js";
import { credentialLikeValue, inspectDecodedCredentialSurface } from "./secret-detector.js";
import type { ConnectorEnvironmentKey, ConnectorManifest } from "./types.js";

const maximumManifestBytes = 64 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{8,128}$/u;
const allowedHosts = ["feishu.cn", "larksuite.com"] as const;
const allowedEnvironment = new Set<ConnectorEnvironmentKey>(["HOME", "XDG_CONFIG_HOME", "LARK_CONFIG_DIR"]);

export type LarkIdentity = "user" | "bot";
export type LarkEnvironment = Readonly<Partial<Record<"HOME" | "XDG_CONFIG_HOME" | "LARK_CONFIG_DIR", string | undefined>>>;

export interface ValidatedFeishuDocumentTarget {
  documentToken: string;
  kind: "token" | "doc" | "docx" | "wiki";
  canonicalInputUrl?: string;
}

export class FeishuDocumentError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "FeishuDocumentError";
  }
}

function fail(code: `WSSPEC_${string}`, message: string): never {
  throw new FeishuDocumentError(code, message);
}

function inspectSurface(value: string): string {
  const result = inspectDecodedCredentialSurface(value, {
    detectCredentialKeys: true,
    maximumBytes: 8_192,
    maximumDecodeRounds: 4,
  });
  if (!result.ok) return fail("WSSPEC_FEISHU_TARGET_INVALID", "飞书文档目标无效或包含凭据样式内容。");
  return result.value;
}

function validToken(value: string): string {
  const decoded = inspectSurface(value).normalize("NFC");
  if (!tokenPattern.test(decoded) || credentialLikeValue(decoded)) {
    return fail("WSSPEC_FEISHU_TARGET_INVALID", "飞书文档 token 无效。");
  }
  return decoded;
}

function allowedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return allowedHosts.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

export function validateFeishuDocumentTarget(value: unknown): ValidatedFeishuDocumentTarget {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 2_048
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return fail("WSSPEC_FEISHU_TARGET_INVALID", "飞书文档目标必须是有界 URL 或 token。");
  }
  inspectSurface(value);
  if (!value.includes("://")) {
    return { documentToken: validToken(value), kind: "token" };
  }
  let url: URL;
  try { url = new URL(value); }
  catch { return fail("WSSPEC_FEISHU_TARGET_INVALID", "飞书文档 URL 无效。"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== ""
    || url.search !== "" || url.hash !== "" || !allowedHost(url.hostname)) {
    return fail("WSSPEC_FEISHU_TARGET_INVALID", "飞书文档 URL 不属于受支持的安全目标。");
  }
  inspectSurface(url.hostname);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || !["doc", "docx", "wiki"].includes(parts[0]!)) {
    return fail("WSSPEC_FEISHU_TARGET_INVALID", "飞书文档 URL 路径无效。");
  }
  const documentToken = validToken(parts[1]!);
  const kind = parts[0] as "doc" | "docx" | "wiki";
  return {
    documentToken,
    kind,
    canonicalInputUrl: `https://${url.hostname.toLowerCase()}/${kind}/${documentToken}`,
  };
}

export function validateLarkIdentity(value: unknown): LarkIdentity {
  if (value === undefined || value === "user") return "user";
  if (value === "bot") return "bot";
  return fail("WSSPEC_FEISHU_CONFIGURATION_INVALID", "飞书身份只允许 user 或 bot。");
}

export function validateLarkEnvironment(value: unknown): LarkEnvironment | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return fail("WSSPEC_FEISHU_CONFIGURATION_INVALID", "飞书 Provider 环境配置无效。");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedEnvironment.has(key as ConnectorEnvironmentKey))
    || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) {
    return fail("WSSPEC_FEISHU_CONFIGURATION_INVALID", "飞书 Provider 环境包含不允许的属性。");
  }
  const result: Record<string, string | undefined> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const candidate = descriptor.value;
    if (!allowedEnvironment.has(key as ConnectorEnvironmentKey) || (candidate !== undefined
      && (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")))) {
      return fail("WSSPEC_FEISHU_CONFIGURATION_INVALID", "飞书 Provider 环境只允许受审计的绝对配置目录。");
    }
    result[key] = candidate;
  }
  return result;
}

export function mapFeishuProcessError(error: unknown): never {
  if (error instanceof FeishuDocumentError) throw error;
  if (!(error instanceof ProcessJsonError)) return fail("WSSPEC_FEISHU_REQUEST_FAILED", "飞书文档请求失败。");
  if (error.code === "WSSPEC_PROCESS_EXECUTABLE_INVALID" || error.code === "WSSPEC_PROCESS_SPAWN_FAILED") {
    return fail("WSSPEC_FEISHU_MISSING_BINARY", "lark-cli 不存在或不可执行。");
  }
  if (error.code === "WSSPEC_PROCESS_OUTPUT_LIMIT") {
    return fail("WSSPEC_FEISHU_RESPONSE_TOO_LARGE", "飞书文档响应超过上限。");
  }
  if (error.code === "WSSPEC_PROCESS_INVALID_JSON") {
    return fail("WSSPEC_FEISHU_RESPONSE_INVALID", "飞书文档响应不是合法 JSON。");
  }
  const diagnostic = error.diagnostic.toLowerCase();
  if (/rate[ -]?limit|too many requests|\b429\b/u.test(diagnostic)) {
    return fail("WSSPEC_FEISHU_RATE_LIMITED", "飞书文档请求达到速率限制。");
  }
  if (/\b404\b|not found/u.test(diagnostic)) return fail("WSSPEC_FEISHU_NOT_FOUND", "飞书文档不存在。");
  if (/\b401\b|unauthenticated|authentication required|not configured|refresh token/u.test(diagnostic)) {
    return fail("WSSPEC_FEISHU_UNAUTHENTICATED", "lark-cli 当前身份未认证。");
  }
  if (/\b403\b|forbidden|permission denied/u.test(diagnostic)) {
    return fail("WSSPEC_FEISHU_FORBIDDEN", "飞书文档访问被拒绝。");
  }
  return fail("WSSPEC_FEISHU_REQUEST_FAILED", "飞书文档请求失败。");
}

const larkManifestInput = {
  id: "lark-cli",
  capabilities: ["feishu.document", "document.read", "knowledge.publish"],
  securityClass: "external-write",
  executable: "lark-cli",
  minimumVersion: "1.0.0",
  argvTemplates: [
    ["docs", "+fetch", "--doc", "{documentToken}", "--format", "json", "--as", "{identity}"],
    ["docs", "+fetch", "--doc", "{documentToken}", "--offset", "{offset}", "--limit", "100", "--format", "json", "--as", "{identity}"],
    ["docs", "+create", "--title", "{title}", "--folder-token", "{folderToken}", "--markdown", "{markdown}", "--as", "{identity}"],
    ["docs", "+create", "--title", "{title}", "--wiki-node", "{wikiNode}", "--markdown", "{markdown}", "--as", "{identity}"],
    ["docs", "+create", "--title", "{title}", "--wiki-space", "{wikiSpace}", "--markdown", "{markdown}", "--as", "{identity}"],
    ["docs", "+update", "--doc", "{documentToken}", "--mode", "overwrite", "--markdown", "{markdown}", "--new-title", "{title}", "--as", "{identity}"],
  ],
  doctor: {
    version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
    auth: { kind: "unavailable", reasonCode: "WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE" },
  },
  envPolicy: { allow: ["HOME", "XDG_CONFIG_HOME", "LARK_CONFIG_DIR"] },
  timeoutMs: 30_000,
  maxStdoutBytes: 1024 * 1024,
} as const;

export const larkCliManifest = defineConnectorManifest(larkManifestInput);

function sameManifest(left: ConnectorManifest, right: ConnectorManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function larkConnectorResourcesRoot(): string {
  return fileURLToPath(new URL("../../../resources/connectors/", import.meta.url));
}

export async function loadLarkConnectorManifest(root = larkConnectorResourcesRoot()): Promise<ConnectorManifest> {
  if (!path.isAbsolute(root)) return fail("WSSPEC_FEISHU_MANIFEST_INVALID", "lark Connector Manifest 根目录必须是绝对路径。");
  try {
    const filename = path.join(root, "lark-cli.yaml");
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumManifestBytes) throw new Error("invalid file");
    const document = parseDocument(await readFile(filename, "utf8"), { uniqueKeys: true, schema: "core" });
    if (document.errors.length !== 0 || document.warnings.length !== 0) throw new Error("invalid yaml");
    let alias = false;
    visit(document, (_key, node) => { if (isAlias(node)) alias = true; });
    if (alias) throw new Error("aliases forbidden");
    const manifest = defineConnectorManifest(document.toJS({ maxAliasCount: 0 }));
    if (!sameManifest(manifest, larkCliManifest)) throw new Error("contract drift");
    return manifest;
  } catch {
    return fail("WSSPEC_FEISHU_MANIFEST_INVALID", "lark Connector Manifest 不符合审计合同。");
  }
}

export function registerLarkConnectorManifest(registry: ConnectorRegistry, manifest: ConnectorManifest): ConnectorRegistry {
  if (!sameManifest(manifest, larkCliManifest)) {
    return fail("WSSPEC_FEISHU_MANIFEST_INVALID", "lark Connector Manifest 与审计合同不一致。");
  }
  registry.register(manifest);
  return registry;
}
