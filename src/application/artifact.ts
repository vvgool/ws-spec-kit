import { execFile, spawn } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

import { createArtifactDocument } from "../domain/artifacts.js";
import { sha256 } from "../domain/digests.js";
import type { ArtifactCreateInput } from "../protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../protocol/work-package.js";
import { validate } from "../schemas/index.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import { loadApplicationState } from "./state.js";
import type { RuntimeClaim, RuntimeProjection } from "../storage/control-plane.js";
import { workPackageIdentityDigest } from "../domain/work-package-identity.js";

const execFileAsync = promisify(execFile);

export class ApplicationArtifactError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(message);
    this.name = "ApplicationArtifactError";
  }
}

export interface ArtifactAuthoringDependencies {
  afterDraftAncestorsChecked?(): Promise<void>;
  beforeDraftReaderSpawn?(): Promise<void>;
  afterDraftReaderCwdBound?(): Promise<void>;
  afterDraftOpened?(): Promise<void>;
  afterInitialRead?(): Promise<void>;
  afterArtifactDirectoryPrepared?(): Promise<void>;
  afterArtifactWriteBoundaryChecked?(): Promise<void>;
  afterFinalLink?(): Promise<void>;
  afterArtifactWrite?(): Promise<void>;
  simulateEventFailure?: boolean;
  simulateEventReturnFailure?: boolean;
  simulateEventVerificationFailure?: boolean;
  simulateProjectionFailure?: boolean;
  simulateWriterCrashDuringTempWrite?: boolean;
  simulateWriterCrashBeforeFinalLink?: boolean;
  simulateWriterCrashAfterFinalLink?: boolean;
}

function failure(code: `WSSPEC_${string}`, message: string): never {
  throw new ApplicationArtifactError(code, message);
}

interface StableDraft {
  bytes: Buffer;
  digest: string;
  identity: string;
}

interface DirectoryIdentity {
  path: string;
  identity: BigIntStats;
  requireArtifactSafety: boolean;
}

interface ArtifactDirectory {
  path: string;
  lineage: DirectoryIdentity[];
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalDraftPath(candidate: string, roots: readonly string[]): string {
  if (candidate === "" || path.isAbsolute(candidate) || candidate.includes("\\") || candidate.normalize("NFC") !== candidate
    || path.posix.normalize(candidate) !== candidate
    || candidate.split("/").some((part) => part === "" || part === "." || part === "..")
    || !roots.some((root) => candidate.startsWith(`${root}/`))) {
    return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact draft 必须位于 Work Package 授权目录内。");
  }
  return candidate;
}

async function ignored(worktree: string, candidate: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--", candidate], { cwd: worktree });
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === 128 || code === "1" || code === "128") return false;
    throw error;
  }
}

async function runArtifactReader(
  directory: DirectoryIdentity,
  filename: string,
  maximumBytes: number,
  expectedIdentity: string | undefined,
  dependencies?: ArtifactAuthoringDependencies,
): Promise<StableDraft> {
  const currentModule = fileURLToPath(import.meta.url);
  const extension = path.extname(currentModule);
  const helper = path.join(path.dirname(currentModule), `artifact-reader${extension}`);
  const argv = extension === ".ts"
    ? ["--import", fileURLToPath(import.meta.resolve("tsx")), helper]
    : [helper];
  const child = spawn(process.execPath, argv, {
    cwd: directory.path,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const request = {
    directoryPath: directory.path,
    directoryIdentity: { dev: String(directory.identity.dev), ino: String(directory.identity.ino) },
    filename,
    maximumBytes,
    ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
  };
  child.stdin.on("error", () => undefined);
  child.stdin.write(`${JSON.stringify(request)}\n`);
  const maximumOutputBytes = Math.ceil(maximumBytes / 3) * 4 + 64 * 1024;
  let total = 0;
  let pending = Buffer.alloc(0);
  let cwdBound = false;
  let opened = false;
  let response: { ok?: unknown; code?: unknown; message?: unknown; value?: unknown } | undefined;
  try {
    for await (const value of child.stdout) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
      total += chunk.length;
      if (total > maximumOutputBytes) {
        child.kill("SIGKILL");
        return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 输出超过上限。");
      }
      pending = Buffer.concat([pending, chunk], pending.length + chunk.length);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        let message: { phase?: unknown; ok?: unknown; code?: unknown; message?: unknown; value?: unknown };
        try { message = JSON.parse(line) as typeof message; }
        catch { return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 返回无效结果。"); }
        if (message.phase === "cwd_bound" && message.ok === undefined && response === undefined && !cwdBound && !opened) {
          cwdBound = true;
          await dependencies?.afterDraftReaderCwdBound?.();
          child.stdin.write("continue\n");
        } else if (message.phase === "opened" && message.ok === undefined && response === undefined && cwdBound && !opened) {
          opened = true;
          await dependencies?.afterDraftOpened?.();
          child.stdin.end("continue\n");
        } else if (message.phase === undefined && typeof message.ok === "boolean" && response === undefined) {
          response = message;
          child.stdin.end();
        } else {
          return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 返回无效结果。");
        }
        newline = pending.indexOf(0x0a);
      }
    }
    const code = await closed;
    if (code !== 0 || pending.length !== 0 || response === undefined) {
      return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 未安全完成。");
    }
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw error;
  }
  if (response.ok !== true) {
    const code = response.code === "WSSPEC_ARTIFACT_DRAFT_CHANGED"
      || response.code === "WSSPEC_ARTIFACT_DRAFT_TOO_LARGE"
      || response.code === "WSSPEC_ARTIFACT_DRAFT_PATH_INVALID"
      ? response.code : "WSSPEC_ARTIFACT_DRAFT_PATH_INVALID";
    return failure(code, typeof response.message === "string" ? response.message : "Artifact reader 执行失败。");
  }
  if (!cwdBound || !opened) {
    return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 未完成安全同步。");
  }
  const result = response.value as { contentBase64?: unknown; identity?: unknown } | undefined;
  if (typeof result?.contentBase64 !== "string" || typeof result.identity !== "string"
    || !/^\d+:\d+:\d+:\d+:\d+:\d+$/u.test(result.identity)) {
    return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 返回无效内容。");
  }
  const bytes = Buffer.from(result.contentBase64, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== result.contentBase64) {
    return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact reader 返回无效内容。");
  }
  return { bytes, digest: sha256(bytes), identity: result.identity };
}

async function readStableDraft(
  worktree: string,
  candidate: string,
  contract: NonNullable<WorkPackage["artifactAuthoring"]>,
  expectedIdentity?: string,
  dependencies?: ArtifactAuthoringDependencies,
): Promise<StableDraft> {
  const relative = canonicalDraftPath(candidate, contract.draftRoots);
  if (relative.startsWith(".acceptance/") && !await ignored(worktree, relative)) {
    return failure("WSSPEC_ARTIFACT_DRAFT_NOT_IGNORED", "位于 .acceptance 的 Artifact draft 必须被 Git 忽略。");
  }
  const root = await realpath(worktree);
  const rootIdentity = await lstat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
    return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact draft 根目录不可验证。");
  }
  const lineage: DirectoryIdentity[] = [{ path: root, identity: rootIdentity, requireArtifactSafety: false }];
  let current = root;
  const components = relative.split("/");
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    let target: BigIntStats;
    try { target = await lstat(current, { bigint: true }); }
    catch { return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact draft 路径不存在或不可验证。"); }
    if (target.isSymbolicLink() || !target.isDirectory()) {
      return failure("WSSPEC_ARTIFACT_DRAFT_PATH_INVALID", "Artifact draft 路径不能包含符号链接或非目录父节点。");
    }
    lineage.push({ path: current, identity: target, requireArtifactSafety: false });
  }
  await dependencies?.afterDraftAncestorsChecked?.();
  await verifyDirectoryLineage(
    lineage,
    "WSSPEC_ARTIFACT_DRAFT_CHANGED",
    "Artifact draft 父目录在 authoring 期间发生变化。",
  );
  await dependencies?.beforeDraftReaderSpawn?.();
  return runArtifactReader(
    lineage.at(-1)!,
    components.at(-1)!,
    contract.maxContentBytes,
    expectedIdentity,
    dependencies,
  );
}

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

function assertSafeArtifactDirectory(target: BigIntStats): void {
  const uid = process.getuid?.();
  if (uid === undefined || !target.isDirectory() || target.isSymbolicLink()
    || target.uid !== BigInt(uid) || (target.mode & 0o022n) !== 0n) {
    return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录不安全，拒绝写入。");
  }
}

async function verifyDirectoryLineage(
  lineage: readonly DirectoryIdentity[],
  code: `WSSPEC_${string}`,
  message: string,
): Promise<void> {
  for (const entry of lineage) {
    let current: BigIntStats;
    let canonical: string;
    try {
      current = await lstat(entry.path, { bigint: true });
      canonical = await realpath(entry.path);
    } catch {
      return failure(code, message);
    }
    if (!current.isDirectory() || current.isSymbolicLink() || canonical !== entry.path
      || !sameDirectoryIdentity(entry.identity, current)) {
      return failure(code, message);
    }
    if (entry.requireArtifactSafety) assertSafeArtifactDirectory(current);
  }
}

async function ensureArtifactDirectory(worktree: string, workItemId: string, artifactType: string): Promise<ArtifactDirectory> {
  const root = await realpath(worktree);
  const rootIdentity = await lstat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
    return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储根目录不可验证，拒绝写入。");
  }
  const lineage: DirectoryIdentity[] = [{ path: root, identity: rootIdentity, requireArtifactSafety: false }];
  let current = root;
  for (const part of [".wsspec", "work-items", workItemId, "artifacts", artifactType]) {
    current = path.join(current, part);
    let target: BigIntStats;
    try {
      target = await lstat(current, { bigint: true });
      assertSafeArtifactDirectory(target);
    } catch (error) {
      if (error instanceof ApplicationArtifactError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录不可验证，拒绝写入。");
      }
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录无法安全创建。");
        }
      }
      target = await lstat(current, { bigint: true });
      assertSafeArtifactDirectory(target);
    }
    const canonical = await realpath(current);
    const rechecked = await lstat(current, { bigint: true });
    if (canonical !== current || !sameDirectoryIdentity(target, rechecked)) {
      return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录身份不稳定，拒绝写入。");
    }
    assertSafeArtifactDirectory(rechecked);
    lineage.push({ path: current, identity: rechecked, requireArtifactSafety: true });
  }
  await verifyDirectoryLineage(lineage, "WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录身份不稳定，拒绝写入。");
  return { path: current, lineage };
}

type ArtifactWriterRequest = {
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

function writerIdentity(directory: ArtifactDirectory): { dev: string; ino: string } {
  const value = directory.lineage.at(-1)!.identity;
  return { dev: String(value.dev), ino: String(value.ino) };
}

function parseSerializedIdentity(value: unknown): SerializedIdentity {
  if (typeof value !== "object" || value === null) return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact writer 返回了无效身份。");
  const candidate = value as Partial<SerializedIdentity>;
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "uid"] as const) {
    if (typeof candidate[field] !== "string" || !/^\d+$/u.test(candidate[field])) {
      return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact writer 返回了无效身份。");
    }
  }
  return candidate as SerializedIdentity;
}

async function runArtifactWriter(
  directory: ArtifactDirectory,
  request: ArtifactWriterRequest,
): Promise<{ created: boolean; identity: SerializedIdentity } | { removed: boolean }> {
  const currentModule = fileURLToPath(import.meta.url);
  const extension = path.extname(currentModule);
  const helper = path.join(path.dirname(currentModule), `artifact-writer${extension}`);
  const argv = extension === ".ts"
    ? ["--import", fileURLToPath(import.meta.resolve("tsx")), helper]
    : [helper];
  const child = spawn(process.execPath, argv, {
    cwd: directory.path,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      if (overflow || code !== 0) {
        reject(new ApplicationArtifactError("WSSPEC_ARTIFACT_CONFLICT", "Artifact writer 未安全完成。"));
        return;
      }
      resolve(Buffer.concat(chunks, total).toString("utf8"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
  let response: { ok?: unknown; code?: unknown; message?: unknown; value?: unknown };
  try { response = JSON.parse(output) as typeof response; }
  catch { return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact writer 返回无效结果。"); }
  if (response.ok !== true) {
    return failure(
      response.code === "WSSPEC_ARTIFACT_CONFLICT" ? response.code : "WSSPEC_ARTIFACT_CONFLICT",
      typeof response.message === "string" ? response.message : "Artifact writer 执行失败。",
    );
  }
  if (request.operation === "rollback") {
    const value = response.value as { removed?: unknown } | undefined;
    if (typeof value?.removed !== "boolean") return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact writer 返回无效回滚结果。");
    return { removed: value.removed };
  }
  const value = response.value as { created?: unknown; identity?: unknown } | undefined;
  if (typeof value?.created !== "boolean") return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact writer 返回无效写入结果。");
  return { created: value.created, identity: parseSerializedIdentity(value.identity) };
}

async function writeArtifactNoClobber(
  filename: string,
  bytes: Buffer,
  directory: ArtifactDirectory,
  dependencies?: ArtifactAuthoringDependencies,
): Promise<{ created: boolean; identity: SerializedIdentity }> {
  await verifyDirectoryLineage(directory.lineage, "WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录在临时文件创建前发生变化。");
  await dependencies?.afterArtifactWriteBoundaryChecked?.();
  const written = await runArtifactWriter(directory, {
    operation: "write",
    directoryPath: directory.path,
    directoryIdentity: writerIdentity(directory),
    filename: path.basename(filename),
    contentBase64: bytes.toString("base64"),
    ...(dependencies?.simulateWriterCrashDuringTempWrite === true ? { simulateCrashDuringTempWrite: true } : {}),
    ...(dependencies?.simulateWriterCrashBeforeFinalLink === true ? { simulateCrashBeforeFinalLink: true } : {}),
    ...(dependencies?.simulateWriterCrashAfterFinalLink === true ? { simulateCrashAfterFinalLink: true } : {}),
  });
  if (!("created" in written)) return failure("WSSPEC_ARTIFACT_CONFLICT", "Artifact writer 返回无效写入结果。");
  if (written.created) {
    try {
      await dependencies?.afterFinalLink?.();
    } catch (error) {
      await rollbackArtifact(filename, written.identity, directory);
      throw error;
    }
  }
  return written;
}

async function rollbackArtifact(filename: string, expected: SerializedIdentity, directory: ArtifactDirectory): Promise<void> {
  await verifyDirectoryLineage(directory.lineage, "WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录在回滚前发生变化。");
  await runArtifactWriter(directory, {
    operation: "rollback",
    directoryPath: directory.path,
    directoryIdentity: writerIdentity(directory),
    filename: path.basename(filename),
    expectedIdentity: expected,
  });
}

function activeWorkPackage(
  projection: RuntimeProjection,
  input: ArtifactCreateInput,
  now: Date,
): { claim: RuntimeClaim; workPackage: WorkPackage } {
  const active = Object.entries(projection.claims).find(([, claim]) => claim.stageId === input.stepId);
  const claim = active?.[1];
  const context = active === undefined ? undefined : projection.contexts[active[0]] as { workPackage?: unknown } | undefined;
  let workPackage: WorkPackage;
  try { workPackage = validate<WorkPackage>("builtin.work-package.v1", context?.workPackage); }
  catch { return failure("WSSPEC_ARTIFACT_AUTHORING_UNAVAILABLE", "活动 Work Package 不支持受治理的 Artifact authoring。"); }
  if (workPackage.artifactAuthoring?.version !== 1) {
    return failure("WSSPEC_ARTIFACT_AUTHORING_UNAVAILABLE", "活动 Work Package 不支持受治理的 Artifact authoring。");
  }
  if (claim?.workPackageDigest === undefined || claim.workPackageDigest !== workPackageIdentityDigest(workPackage)) {
    return failure("WSSPEC_ARTIFACT_AUTHORING_UNAVAILABLE", "活动 Claim 未绑定完整 Work Package identity。");
  }
  if (claim === undefined || claim.attemptId !== input.attemptId || claim.claimToken !== input.leaseToken
    || workPackage.workItemId !== input.workItemId || workPackage.stepId !== input.stepId
    || workPackage.attemptId !== input.attemptId || workPackage.lease.token !== input.leaseToken
    || workPackage.lease.expiresAt !== claim.expiresAt || now >= new Date(claim.expiresAt)) {
    return failure("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 或 Lease 已失效。");
  }
  return { claim, workPackage };
}

function requiredArtifactOutput(workPackage: WorkPackage, input: ArtifactCreateInput): { outputId: string; contentLevel?: string } {
  const candidates = workPackage.requiredOutputs.filter((output) => output.artifactType === input.artifactType);
  if (input.outputId === undefined && candidates.length > 1) {
    return failure("WSSPEC_ARTIFACT_OUTPUT_AMBIGUOUS", "同一 artifactType 对应多个 requiredOutputs，必须显式提供 output id。");
  }
  const expected = input.outputId === undefined
    ? candidates.length === 1 ? candidates[0] : undefined
    : candidates.find((output) => output.outputId === input.outputId);
  if (expected?.outputId === undefined) {
    return failure("WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED", "Artifact 不属于活动 Work Package 的 Agent-authored requiredOutputs。");
  }
  if (expected.schemaVersion !== 1) {
    return failure("WSSPEC_ARTIFACT_OUTPUT_SCHEMA_UNSUPPORTED", "Artifact Schema 版本不受支持。");
  }
  return {
    outputId: expected.outputId,
    ...(expected.contentLevel === undefined ? {} : { contentLevel: expected.contentLevel }),
  };
}

function artifactMutationIdentity(
  input: ArtifactCreateInput,
  outputId: string,
  sourceDigest: string,
  contentLevel?: string,
): { idempotencyKey: string; operationInput: unknown } {
  return {
    idempotencyKey: `artifact:${input.stepId}:${input.attemptId}:${outputId}`,
    operationInput: {
      workItemId: input.workItemId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      leaseDigest: sha256(input.leaseToken),
      artifactType: input.artifactType,
      outputId,
      ...(contentLevel === undefined ? {} : { contentLevel }),
      sourceDigest,
    },
  };
}

export async function createApplicationArtifact(
  input: ArtifactCreateInput,
  dependencies: { now(): Date; artifactAuthoring?: ArtifactAuthoringDependencies },
): Promise<ArtifactReference> {
  const request = validate<ArtifactCreateInput>("builtin.application-artifact-create-input.v1", input);
  const state = await loadApplicationState(request.root, request.workItemId);
  const preflight = activeWorkPackage(state.projection, request, dependencies.now());
  const preflightOutput = requiredArtifactOutput(preflight.workPackage, request);
  const source = await readStableDraft(
    state.worktree,
    request.contentFile,
    preflight.workPackage.artifactAuthoring!,
    undefined,
    dependencies.artifactAuthoring,
  );
  await dependencies.artifactAuthoring?.afterInitialRead?.();
  const sourceDigest = source.digest;
  const preflightMutationIdentity = artifactMutationIdentity(
    request,
    preflightOutput.outputId,
    sourceDigest,
    preflightOutput.contentLevel,
  );
  let value: unknown;
  try {
    value = await mutateControlPlane({
      cwd: request.root,
      workItemId: request.workItemId,
      eventType: "artifact.authored",
      ...preflightMutationIdentity,
      stageId: request.stepId,
      attemptId: request.attemptId,
      resolveIdentity: (projection) => {
        const { workPackage } = activeWorkPackage(projection, request, dependencies.now());
        const output = requiredArtifactOutput(workPackage, request);
        return artifactMutationIdentity(request, output.outputId, sourceDigest, output.contentLevel);
      },
      actor: preflight.claim.actor,
      ...(dependencies.artifactAuthoring?.simulateEventFailure === undefined
        ? {} : { simulateEventFailure: dependencies.artifactAuthoring.simulateEventFailure }),
      ...(dependencies.artifactAuthoring?.simulateEventReturnFailure === undefined
        ? {} : { simulateEventReturnFailure: dependencies.artifactAuthoring.simulateEventReturnFailure }),
      ...(dependencies.artifactAuthoring?.simulateEventVerificationFailure === undefined
        ? {} : { simulateEventVerificationFailure: dependencies.artifactAuthoring.simulateEventVerificationFailure }),
      ...(dependencies.artifactAuthoring?.simulateProjectionFailure === undefined
        ? {} : { simulateProjectionFailure: dependencies.artifactAuthoring.simulateProjectionFailure }),
      mutate: async (projection) => {
        const { workPackage } = activeWorkPackage(projection, request, dependencies.now());
        const output = requiredArtifactOutput(workPackage, request);
        const locked = await readStableDraft(
          state.worktree,
          request.contentFile,
          workPackage.artifactAuthoring!,
          source.identity,
          dependencies.artifactAuthoring,
        );
        const bytes = locked.bytes;
        if (locked.digest !== sourceDigest) return failure("WSSPEC_ARTIFACT_DRAFT_CHANGED", "Artifact draft 在读取期间发生变化。");
        let body: string;
        try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return failure("WSSPEC_ARTIFACT_ENCODING_INVALID", "Artifact draft 必须是严格 UTF-8。"); }
        const document = createArtifactDocument({
          artifactType: request.artifactType,
          outputId: output.outputId,
          workItemId: request.workItemId,
          stageId: request.stepId,
          attemptId: request.attemptId,
          body,
        });
        const directory = await ensureArtifactDirectory(state.worktree, request.workItemId, request.artifactType);
        await dependencies.artifactAuthoring?.afterArtifactDirectoryPrepared?.();
        const filename = path.join(directory.path, `${document.reference.contentHash.slice("sha256:".length)}.md`);
        const written = await writeArtifactNoClobber(
          filename,
          Buffer.from(document.content, "utf8"),
          directory,
          dependencies.artifactAuthoring,
        );
        try {
          await dependencies.artifactAuthoring?.afterArtifactWrite?.();
          const finalSource = await readStableDraft(
            state.worktree,
            request.contentFile,
            workPackage.artifactAuthoring!,
            source.identity,
            dependencies.artifactAuthoring,
          );
          if (finalSource.digest !== sourceDigest) {
            return failure("WSSPEC_ARTIFACT_DRAFT_CHANGED", "Artifact draft 在 authoring 完成前发生变化。");
          }
          await verifyDirectoryLineage(directory.lineage, "WSSPEC_ARTIFACT_CONFLICT", "Artifact 存储目录在事件提交前发生变化。");
        } catch (error) {
          if (written.created) await rollbackArtifact(filename, written.identity, directory);
          throw error;
        }
        return {
          projection,
          value: {
            ...document.reference,
            ...(output.contentLevel === undefined ? {} : { contentLevel: output.contentLevel }),
            artifactDigest: sha256(document.content),
          },
          ...(written.created ? { rollback: () => rollbackArtifact(filename, written.identity, directory) } : {}),
        };
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_IDEMPOTENCY_CONFLICT") {
      return failure("WSSPEC_ARTIFACT_CONFLICT", "同一 Attempt output 已绑定不同 Artifact 内容。");
    }
    throw error;
  }
  const reference = value as Omit<ArtifactReference, "path"> & { artifactDigest: string };
  return {
    artifactType: reference.artifactType,
    outputId: reference.outputId!,
    schemaVersion: reference.schemaVersion,
    path: `.wsspec/work-items/${request.workItemId}/artifacts/${reference.artifactType}/${reference.contentHash!.slice("sha256:".length)}.md`,
    mediaType: reference.mediaType!,
    revision: reference.revision!,
    contentHash: reference.contentHash!,
    ...(reference.contentLevel === undefined ? {} : { contentLevel: reference.contentLevel }),
  };
}
