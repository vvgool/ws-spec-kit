import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

const maximumRequestBytes = 2 * 1024 * 1024;
const artifactFilenamePattern = /^[a-f0-9]{64}\.md$/u;

interface SerializedIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
  mode: string;
  uid: string;
}

type WriterRequest = {
  operation: "write";
  directoryPath: string;
  directoryIdentity: { dev: string; ino: string };
  filename: string;
  contentBase64: string;
  simulateCrashDuringTempWrite?: boolean;
  simulateCrashBeforeFinalLink?: boolean;
  simulateCrashAfterFinalLink?: boolean;
} | {
  operation: "rollback";
  directoryPath: string;
  directoryIdentity: { dev: string; ino: string };
  filename: string;
  expectedIdentity: SerializedIdentity;
};

class ArtifactWriterError extends Error {
  readonly code = "WSSPEC_ARTIFACT_CONFLICT";
}

function fail(message: string): never {
  throw new ArtifactWriterError(message);
}

function sameNode(left: BigIntStats, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function serializeIdentity(value: BigIntStats): SerializedIdentity {
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs),
    nlink: String(value.nlink),
    mode: String(value.mode),
    uid: String(value.uid),
  };
}

function sameStoredIdentity(left: BigIntStats, right: SerializedIdentity): boolean {
  return String(left.dev) === right.dev && String(left.ino) === right.ino
    && String(left.size) === right.size && String(left.mtimeNs) === right.mtimeNs
    && String(left.ctimeNs) === right.ctimeNs && String(left.nlink) === right.nlink
    && String(left.mode) === right.mode && String(left.uid) === right.uid;
}

function assertSafeFile(value: BigIntStats, maximumBytes: number, expectedLinks = 1n): void {
  const uid = process.getuid?.();
  if (uid === undefined || !value.isFile() || value.isSymbolicLink() || value.nlink !== expectedLinks
    || value.uid !== BigInt(uid) || (value.mode & 0o022n) !== 0n || value.size > BigInt(maximumBytes)) {
    fail("Artifact 文件身份不可验证。");
  }
}

async function assertDirectoryBinding(request: WriterRequest): Promise<BigIntStats> {
  const expected = { dev: BigInt(request.directoryIdentity.dev), ino: BigInt(request.directoryIdentity.ino) };
  const current = await lstat(".", { bigint: true });
  const absolute = await lstat(request.directoryPath, { bigint: true }).catch(() => undefined);
  const canonical = await realpath(request.directoryPath).catch(() => undefined);
  const uid = process.getuid?.();
  if (uid === undefined || !current.isDirectory() || current.isSymbolicLink()
    || current.uid !== BigInt(uid) || (current.mode & 0o022n) !== 0n
    || !sameNode(current, expected) || absolute === undefined || absolute.isSymbolicLink()
    || !sameNode(absolute, expected) || canonical !== request.directoryPath) {
    fail("Artifact 存储目录身份不稳定，拒绝写入。");
  }
  return current;
}

async function readBounded(filename: string, maximumBytes: number): Promise<{ bytes: Buffer; identity: BigIntStats }> {
  const pathBefore = await lstat(filename, { bigint: true }).catch(() => undefined);
  if (pathBefore === undefined) fail("同摘要 Artifact 不可读取或已变化。");
  assertSafeFile(pathBefore, maximumBytes);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) fail("同摘要 Artifact 无法安全打开。");
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameStoredIdentity(pathBefore, serializeIdentity(before))) fail("同摘要 Artifact 身份不稳定。");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
      if (total > maximumBytes) fail("同摘要 Artifact 超过安全读取上限。");
    }
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filename, { bigint: true }).catch(() => undefined);
    if (pathAfter === undefined || !sameStoredIdentity(after, serializeIdentity(before))
      || !sameStoredIdentity(pathAfter, serializeIdentity(after)) || BigInt(bytes.length) !== before.size) {
      fail("同摘要 Artifact 在读取期间发生变化。");
    }
    return { bytes, identity: pathAfter };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(expected: BigIntStats): Promise<void> {
  const handle = await open(".", constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameNode(await handle.stat({ bigint: true }), expected)) fail("Artifact 存储目录在同步期间发生变化。");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverInterruptedLink(filename: string, bytes: Buffer, directoryIdentity: BigIntStats): Promise<void> {
  const final = await lstat(filename, { bigint: true }).catch(() => undefined);
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const temporaryPattern = new RegExp(`^\\.${escaped}\\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.tmp$`, "u");
  const candidates: Array<{ name: string; identity: BigIntStats }> = [];
  for (const entry of await readdir(".")) {
    if (!temporaryPattern.test(entry)) continue;
    const candidate = await lstat(entry, { bigint: true }).catch(() => undefined);
    if (candidate === undefined || !candidate.isFile() || candidate.isSymbolicLink()) fail("Artifact 中断临时文件不可验证。");
    candidates.push({ name: entry, identity: candidate });
  }
  let removed = false;
  const linked = final === undefined || final.nlink === 1n
    ? [] : candidates.filter(({ identity }) => sameNode(identity, final));
  if (final !== undefined && final.nlink > 1n) {
    assertSafeFile(final, bytes.length, final.nlink);
    if (linked.length === 0 || BigInt(linked.length) + 1n !== final.nlink) {
      fail("同摘要 Artifact 存在不可验证的中断链接。");
    }
    for (const candidate of linked) {
      assertSafeFile(candidate.identity, bytes.length, final.nlink);
      await unlink(candidate.name);
      removed = true;
    }
  }
  const linkedNames = new Set(linked.map(({ name }) => name));
  for (const candidate of candidates) {
    if (linkedNames.has(candidate.name)) continue;
    const orphan = await readBounded(candidate.name, bytes.length + 1);
    if (!bytes.subarray(0, orphan.bytes.length).equals(orphan.bytes)) {
      fail("Artifact 中断临时文件不是目标内容前缀，拒绝清理。");
    }
    await unlink(candidate.name);
    removed = true;
  }
  if (removed) await syncDirectory(directoryIdentity);
}

async function writeArtifact(request: Extract<WriterRequest, { operation: "write" }>): Promise<{ created: boolean; identity: SerializedIdentity }> {
  const directoryIdentity = await assertDirectoryBinding(request);
  const bytes = Buffer.from(request.contentBase64, "base64");
  if (bytes.toString("base64") !== request.contentBase64) fail("Artifact 写入内容编码无效。");
  await recoverInterruptedLink(request.filename, bytes, directoryIdentity);
  const temporary = `.${request.filename}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let temporaryIdentity: BigIntStats | undefined;
  let finalLinked = false;
  let completed = false;
  try {
    try {
      if (request.simulateCrashDuringTempWrite === true) {
        await handle.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        await handle.sync();
        process.exit(84);
      }
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    temporaryIdentity = await lstat(temporary, { bigint: true });
    assertSafeFile(temporaryIdentity, bytes.length, 1n);
    if (request.simulateCrashBeforeFinalLink === true) process.exit(85);
    try {
      await link(temporary, request.filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readBounded(request.filename, bytes.length + 1);
      if (!existing.bytes.equals(bytes)) fail("同摘要 Artifact 的现有内容不一致，拒绝覆盖。");
      await assertDirectoryBinding(request);
      completed = true;
      return { created: false, identity: serializeIdentity(existing.identity) };
    }
    finalLinked = true;
    if (request.simulateCrashAfterFinalLink === true) process.exit(86);
    const linked = await lstat(request.filename, { bigint: true });
    if (!sameNode(linked, temporaryIdentity)) fail("Artifact 最终链接身份不可验证。");
    await unlink(temporary);
    const written = await readBounded(request.filename, bytes.length + 1);
    if (!written.bytes.equals(bytes)) fail("新建 Artifact 的最终内容不一致。");
    await syncDirectory(directoryIdentity);
    await assertDirectoryBinding(request);
    completed = true;
    return { created: true, identity: serializeIdentity(written.identity) };
  } catch (error) {
    if (finalLinked && !completed && temporaryIdentity !== undefined) {
      const current = await lstat(request.filename, { bigint: true }).catch(() => undefined);
      if (current !== undefined && sameNode(current, temporaryIdentity)) {
        await unlink(request.filename);
        await syncDirectory(directoryIdentity);
      }
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function rollbackArtifact(request: Extract<WriterRequest, { operation: "rollback" }>): Promise<{ removed: boolean }> {
  const directoryIdentity = await assertDirectoryBinding(request);
  const current = await lstat(request.filename, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current === undefined) return { removed: false };
  if (!sameStoredIdentity(current, request.expectedIdentity)) fail("Artifact 在回滚前发生变化，拒绝删除。");
  await unlink(request.filename);
  await syncDirectory(directoryIdentity);
  await assertDirectoryBinding(request);
  return { removed: true };
}

async function readRequest(): Promise<WriterRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    total += chunk.length;
    if (total > maximumRequestBytes) fail("Artifact writer 请求超过上限。");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as Partial<WriterRequest>;
  if ((value.operation !== "write" && value.operation !== "rollback")
    || typeof value.directoryPath !== "string" || !path.isAbsolute(value.directoryPath)
    || typeof value.directoryIdentity?.dev !== "string" || !/^\d+$/u.test(value.directoryIdentity.dev)
    || typeof value.directoryIdentity.ino !== "string" || !/^\d+$/u.test(value.directoryIdentity.ino)
    || typeof value.filename !== "string" || !artifactFilenamePattern.test(value.filename)) {
    fail("Artifact writer 请求无效。");
  }
  if (value.operation === "write" && typeof value.contentBase64 !== "string") fail("Artifact writer 写入请求无效。");
  if (value.operation === "rollback" && (value.expectedIdentity === undefined
    || Object.values(value.expectedIdentity).some((field) => typeof field !== "string" || !/^\d+$/u.test(field)))) {
    fail("Artifact writer 回滚请求无效。");
  }
  return value as WriterRequest;
}

try {
  const request = await readRequest();
  const value = request.operation === "write" ? await writeArtifact(request) : await rollbackArtifact(request);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  const known = error instanceof ArtifactWriterError;
  process.stdout.write(JSON.stringify({
    ok: false,
    code: "WSSPEC_ARTIFACT_CONFLICT",
    message: known ? error.message : "Artifact writer 执行失败。",
  }));
}
