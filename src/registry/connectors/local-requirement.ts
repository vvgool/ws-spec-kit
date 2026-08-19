import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../domain/digests.js";
import type { RequirementSourceInput } from "../../protocol/application.js";

export const MAX_REQUIREMENT_BYTES = 1_048_576;
export const MAX_REQUIREMENT_CHARACTERS = 262_144;

export interface CapturedLocalRequirement {
  type: "prompt" | "file";
  origin: string;
  text: string;
  contentDigest: string;
}

export class LocalRequirementError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "LocalRequirementError";
  }
}

function fail(code: `WSSPEC_${string}`, message: string): never {
  throw new LocalRequirementError(code, message);
}

function sameIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

function boundedText(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_REQUIREMENT_BYTES) {
    return fail("WSSPEC_SOURCE_TOO_LARGE", "需求来源超过 1 MiB 字节上限。");
  }
  const canonical = (text.startsWith("\ufeff") ? text.slice(1) : text)
    .replace(/\r\n?/gu, "\n")
    .normalize("NFC");
  if (Buffer.byteLength(canonical, "utf8") > MAX_REQUIREMENT_BYTES
    || [...canonical].length > MAX_REQUIREMENT_CHARACTERS) {
    return fail("WSSPEC_SOURCE_TOO_LARGE", "需求来源超过字节或 Unicode 字符上限。");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(canonical)) {
    return fail("WSSPEC_SOURCE_BINARY", "需求来源包含 NUL 或二进制控制字符。");
  }
  if (canonical.trim() === "") return fail("WSSPEC_SOURCE_EMPTY", "需求来源不能为空。");
  return canonical;
}

export function canonicalRequirementText(text: string): string {
  return boundedText(text);
}

function canonicalRelativePath(candidate: string): { accessPath: string; stablePath: string } {
  if (candidate === "" || path.isAbsolute(candidate) || candidate.includes("\\")
    || path.posix.normalize(candidate) !== candidate
    || candidate.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return fail("WSSPEC_SOURCE_PATH_INVALID", "需求文件路径必须是规范的仓库相对 POSIX 路径。");
  }
  if (![".md", ".txt"].includes(path.posix.extname(candidate))) {
    return fail("WSSPEC_SOURCE_TYPE_UNSUPPORTED", "只支持仓库内 .md 或 .txt 需求文件。");
  }
  return { accessPath: candidate, stablePath: candidate.normalize("NFC") };
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertNoSymlinkComponents(root: string, relative: string): Promise<string> {
  let current = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let target;
    try {
      target = await lstat(current, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        return fail("WSSPEC_SOURCE_PATH_INVALID", "需求文件路径不能包含符号链接。");
      }
      throw error;
    }
    if (target.isSymbolicLink()) return fail("WSSPEC_SOURCE_PATH_INVALID", "需求文件路径不能包含符号链接。");
    if (index < parts.length - 1 && !target.isDirectory()) {
      return fail("WSSPEC_SOURCE_PATH_INVALID", "需求文件父路径必须是普通目录。");
    }
  }
  return current;
}

export async function readLocalRequirementFile(repositoryRoot: string, candidate: string): Promise<{ path: string; text: string }> {
  const relative = canonicalRelativePath(candidate);
  const root = await realpath(repositoryRoot);
  const filename = await assertNoSymlinkComponents(root, relative.accessPath);
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile()) return fail("WSSPEC_SOURCE_NOT_REGULAR_FILE", "需求来源必须是普通文件。");
  if (before.nlink !== 1n) return fail("WSSPEC_SOURCE_PATH_INVALID", "需求来源必须只有一个文件名链接。");
  if (before.size > BigInt(MAX_REQUIREMENT_BYTES)) {
    return fail("WSSPEC_SOURCE_TOO_LARGE", "需求来源超过 1 MiB 字节上限。");
  }

  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (["ELOOP", "EFTYPE"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return fail("WSSPEC_SOURCE_PATH_INVALID", "需求文件在打开前被替换为符号链接。");
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return fail("WSSPEC_SOURCE_NOT_REGULAR_FILE", "需求来源必须是普通文件。");
    if (opened.nlink !== 1n) return fail("WSSPEC_SOURCE_CHANGED_DURING_READ", "需求文件链接数在打开期间发生变化。");
    if (!sameIdentity(before, opened)) return fail("WSSPEC_SOURCE_CHANGED_DURING_READ", "需求文件在打开期间被替换。");
    const openedPath = await realpath(filename);
    const openedPathTarget = await lstat(openedPath, { bigint: true });
    if (!contained(root, openedPath) || !sameIdentity(opened, openedPathTarget)) {
      return fail("WSSPEC_SOURCE_PATH_INVALID", "需求文件打开后的真实路径或身份不匹配。");
    }
    if (opened.size > BigInt(MAX_REQUIREMENT_BYTES)) {
      return fail("WSSPEC_SOURCE_TOO_LARGE", "需求来源超过 1 MiB 字节上限。");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_REQUIREMENT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
      if (total > MAX_REQUIREMENT_BYTES) return fail("WSSPEC_SOURCE_TOO_LARGE", "需求来源超过 1 MiB 字节上限。");
    }
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || !sameIdentity(opened, after) || BigInt(total) !== opened.size) {
      return fail("WSSPEC_SOURCE_CHANGED_DURING_READ", "需求文件在读取期间发生变化。");
    }
    try {
      const finalPath = await realpath(filename);
      const finalTarget = await lstat(finalPath, { bigint: true });
      if (!contained(root, finalPath) || !sameIdentity(after, finalTarget)) {
        return fail("WSSPEC_SOURCE_CHANGED_DURING_READ", "需求文件路径在读取期间被替换。");
      }
    } catch (error) {
      if (error instanceof LocalRequirementError) throw error;
      return fail("WSSPEC_SOURCE_CHANGED_DURING_READ", "需求文件路径在读取期间消失或变化。");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      return fail("WSSPEC_SOURCE_BINARY", "需求来源不是严格 UTF-8 文本。");
    }
    return { path: relative.stablePath, text: boundedText(decoded) };
  } finally {
    await handle.close();
  }
}

export async function captureLocalRequirement(root: string, source: RequirementSourceInput): Promise<CapturedLocalRequirement> {
  if (source.type === "prompt") {
    const text = boundedText(source.text);
    return { type: "prompt", origin: "prompt", text, contentDigest: sha256(text) };
  }
  if (source.type === "file") {
    const captured = await readLocalRequirementFile(root, source.path);
    return { type: "file", origin: captured.path, text: captured.text, contentDigest: sha256(captured.text) };
  }
  return fail("WSSPEC_SOURCE_TYPE_UNSUPPORTED", "当前阶段只支持 Prompt 和仓库内 Markdown/TXT 来源。");
}
