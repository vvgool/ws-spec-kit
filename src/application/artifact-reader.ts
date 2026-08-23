import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const maximumRequestBytes = 16 * 1024;
const maximumDraftBytes = 1_048_576;

interface ReaderRequest {
  directoryPath: string;
  directoryIdentity: { dev: string; ino: string };
  filename: string;
  maximumBytes: number;
  expectedIdentity?: string;
}

class ArtifactReaderError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(message);
  }
}

function fail(code: `WSSPEC_${string}`, message: string): never {
  throw new ArtifactReaderError(code, message);
}

function sameNode(left: BigIntStats, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(value: BigIntStats): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.nlink].join(":");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return identity(left) === identity(right);
}

async function assertDirectoryBinding(request: ReaderRequest): Promise<void> {
  const expected = { dev: BigInt(request.directoryIdentity.dev), ino: BigInt(request.directoryIdentity.ino) };
  const current = await lstat(".", { bigint: true });
  const absolute = await lstat(request.directoryPath, { bigint: true }).catch(() => undefined);
  const canonical = await realpath(request.directoryPath).catch(() => undefined);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(current, expected)
    || absolute === undefined || !absolute.isDirectory() || absolute.isSymbolicLink()
    || !sameNode(absolute, expected) || canonical !== request.directoryPath) {
    fail("WSSPEC_ARTIFACT_DRAFT_CHANGED", "Artifact draft 父目录在读取期间发生变化。");
  }
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
    if (total > maximumBytes) {
      fail("WSSPEC_ARTIFACT_DRAFT_TOO_LARGE", "Artifact draft 超过 Work Package 的字节上限。");
    }
  }
  return Buffer.concat(chunks, total);
}

const input = process.stdin[Symbol.asyncIterator]();
let pending = Buffer.alloc(0);

async function readLine(maximumBytes: number): Promise<string> {
  while (true) {
    const newline = pending.indexOf(0x0a);
    if (newline >= 0) {
      if (newline > maximumBytes) fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 请求超过上限。");
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      return line;
    }
    if (pending.length > maximumBytes) fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 请求超过上限。");
    const next = await input.next();
    if (next.done === true) fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 请求不完整。");
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as string);
    pending = Buffer.concat([pending, chunk], pending.length + chunk.length);
  }
}

function parseRequest(line: string): ReaderRequest {
  let value: Partial<ReaderRequest>;
  try { value = JSON.parse(line) as Partial<ReaderRequest>; }
  catch { return fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 请求无效。"); }
  if (typeof value.directoryPath !== "string" || !path.isAbsolute(value.directoryPath)
    || typeof value.directoryIdentity?.dev !== "string" || !/^\d+$/u.test(value.directoryIdentity.dev)
    || typeof value.directoryIdentity.ino !== "string" || !/^\d+$/u.test(value.directoryIdentity.ino)
    || typeof value.filename !== "string" || value.filename === "" || value.filename === "." || value.filename === ".."
    || value.filename.includes("/") || value.filename.includes("\\") || value.filename.normalize("NFC") !== value.filename
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes! < 1 || value.maximumBytes! > maximumDraftBytes
    || (value.expectedIdentity !== undefined && (typeof value.expectedIdentity !== "string"
      || !/^\d+:\d+:\d+:\d+:\d+:\d+$/u.test(value.expectedIdentity)))) {
    return fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 请求无效。");
  }
  return value as ReaderRequest;
}

async function synchronize(phase: "cwd_bound" | "opened"): Promise<void> {
  process.stdout.write(`${JSON.stringify({ phase })}\n`);
  if (await readLine(16) !== "continue") {
    return fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 同步请求无效。");
  }
}

async function readDraft(request: ReaderRequest): Promise<{ contentBase64: string; identity: string }> {
  await synchronize("cwd_bound");
  await assertDirectoryBinding(request);
  const before = await lstat(request.filename, { bigint: true }).catch(() => undefined);
  if (before === undefined || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    return fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact draft 必须是单链接普通文件。");
  }
  if (before.size > BigInt(request.maximumBytes)) {
    return fail("WSSPEC_ARTIFACT_DRAFT_TOO_LARGE", "Artifact draft 超过 Work Package 的字节上限。");
  }
  if (request.expectedIdentity !== undefined && identity(before) !== request.expectedIdentity) {
    return fail("WSSPEC_ARTIFACT_DRAFT_CHANGED", "Artifact draft 在 authoring 期间发生变化。");
  }
  const handle = await open(request.filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return fail("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact draft 不是可验证的普通文件。");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) {
      return fail("WSSPEC_ARTIFACT_DRAFT_CHANGED", "Artifact draft 在打开期间发生变化。");
    }
    await assertDirectoryBinding(request);
    await synchronize("opened");
    await assertDirectoryBinding(request);
    const bytes = await readBounded(handle, request.maximumBytes);
    const after = await handle.stat({ bigint: true });
    const final = await lstat(request.filename, { bigint: true }).catch(() => undefined);
    await assertDirectoryBinding(request);
    if (final === undefined || !sameIdentity(opened, after) || !sameIdentity(after, final)
      || BigInt(bytes.length) !== after.size) {
      return fail("WSSPEC_ARTIFACT_DRAFT_CHANGED", "Artifact draft 在读取期间发生变化。");
    }
    return { contentBase64: bytes.toString("base64"), identity: identity(after) };
  } finally {
    await handle.close();
  }
}

try {
  const request = parseRequest(await readLine(maximumRequestBytes));
  const value = await readDraft(request);
  process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
} catch (error) {
  const known = error instanceof ArtifactReaderError;
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: known ? error.code : "WSSPEC_ARTIFACT_DRAFT_PATH_INVALID",
    message: known ? error.message : "Artifact reader 执行失败。",
  })}\n`);
}
