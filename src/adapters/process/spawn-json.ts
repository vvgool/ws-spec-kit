import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { redactText, redactValue } from "./redaction.js";

const diagnosticLimit = 1_024;
const cleanupGraceMs = 100;
const cleanupDeadlineMs = 1_000;
const cleanupPollMs = 10;
const maxExecutableBytes = 128 * 1024 * 1024;
const safeEnvironmentNames = ["LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "TERM", "TZ"] as const;
const configurableEnvironmentNames = new Set(["HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GLAB_CONFIG_DIR", "LARK_CONFIG_DIR"]);

export interface SpawnJsonRequest {
  executable: string;
  argv: readonly string[];
  input: unknown;
  timeoutMs: number;
  maxStdoutBytes: number;
  secrets?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface ProcessJsonResult {
  value: unknown;
  exitCode: 0;
  stdout: string;
  stderr: string;
}

export interface ProcessTextResult {
  value: string;
  exitCode: 0;
  stdout: string;
  stderr: string;
}

export interface ParsedProcessTextResult<T> {
  value: T | undefined;
  exitCode: 0;
  stdout: string;
  stderr: string;
}

interface RawProcessResult {
  rawStdout: string;
  stdout: string;
  stderr: string;
  diagnostic: string;
  secrets: readonly string[];
  cleanupFailure(): Promise<void>;
  exitCode: 0;
}

export type ProcessJsonErrorCode =
  | "WSSPEC_PROCESS_EXECUTABLE_INVALID"
  | "WSSPEC_PROCESS_REQUEST_INVALID"
  | "WSSPEC_PROCESS_SPAWN_FAILED"
  | "WSSPEC_PROCESS_EXECUTABLE_CHANGED"
  | "WSSPEC_PROCESS_TIMEOUT"
  | "WSSPEC_PROCESS_OUTPUT_LIMIT"
  | "WSSPEC_PROCESS_CLEANUP_FAILED"
  | "WSSPEC_PROCESS_EXIT_NONZERO"
  | "WSSPEC_PROCESS_INVALID_JSON";

export class ProcessJsonError extends Error {
  constructor(
    readonly code: ProcessJsonErrorCode,
    message: string,
    readonly diagnostic: string,
    readonly exitCode?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProcessJsonError";
  }
}

function diagnostic(rawStdout: string, rawStderr: string, secrets: readonly string[]): string {
  if (secrets.some((secret) => secret.length < 4)) return "";
  const combined = redactText([`stdout: ${rawStdout}`, `stderr: ${rawStderr}`].join("\n"), secrets);
  if (secrets.some((secret) => secret !== "" && combined.includes(secret))) return "";
  return redactAndBound(combined, diagnosticLimit, []);
}

function redactAndBound(value: string, limit: number, secrets: readonly string[]): string {
  const redactedValue = redactText(value, secrets);
  let bounded = Buffer.from(redactedValue).subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(bounded) > limit) bounded = bounded.slice(0, -1);
  return bounded;
}

interface ProcessEnvironment {
  env: NodeJS.ProcessEnv;
  secrets: readonly string[];
}

function processEnvironment(environment: SpawnJsonRequest["environment"]): ProcessEnvironment {
  const inherited = Object.fromEntries(safeEnvironmentNames.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  const configured = Object.fromEntries(Object.entries(environment ?? {}).flatMap(([name, value]) => {
    if (!configurableEnvironmentNames.has(name) || (value !== undefined && (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")))) {
      throw new ProcessJsonError("WSSPEC_PROCESS_REQUEST_INVALID", "进程环境参数无效。", "");
    }
    return value === undefined ? [] : [[name, value]];
  }));
  const env = { ...inherited, ...configured, PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  return { env, secrets: Object.values(configured).filter((value) => value !== "") };
}

interface ExecutableIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  digest: string;
}

interface ResolvedExecutable {
  path: string;
  identity: ExecutableIdentity;
}

async function executableIdentity(executable: string): Promise<ExecutableIdentity> {
  const before = await lstat(executable, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxExecutableBytes)) throw new Error("not a bounded regular executable");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  const after = await lstat(executable, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error("executable changed while hashing");
  }
  return {
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeNs: after.mtimeNs,
    digest: hash.digest("hex"),
  };
}

function sameIdentity(left: ExecutableIdentity, right: ExecutableIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.digest === right.digest;
}

async function assertTrustedPath(canonical: string): Promise<void> {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const root = path.parse(canonical).root;
  const relativeParts = canonical.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current !== canonical && !stat.isDirectory())
      || (stat.mode & 0o022) !== 0
      || (currentUid !== undefined && stat.uid !== 0 && stat.uid !== currentUid)) {
      throw new Error("untrusted executable path");
    }
  }
}

async function resolvedExecutable(executable: string): Promise<ResolvedExecutable> {
  if (!path.isAbsolute(executable) || executable.includes("\0")) {
    throw new ProcessJsonError("WSSPEC_PROCESS_EXECUTABLE_INVALID", "可执行文件必须是绝对路径。", "");
  }
  try {
    const canonical = await realpath(executable);
    await assertTrustedPath(canonical);
    await access(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return { path: canonical, identity: await executableIdentity(canonical) };
  } catch {
    throw new ProcessJsonError("WSSPEC_PROCESS_EXECUTABLE_INVALID", "可执行文件不存在或不可执行。", "");
  }
}

async function assertExecutableUnchanged(executable: ResolvedExecutable): Promise<void> {
  try {
    const canonical = await realpath(executable.path);
    if (canonical !== executable.path || !sameIdentity(executable.identity, await executableIdentity(canonical))) throw new Error("changed");
  } catch {
    throw new ProcessJsonError("WSSPEC_PROCESS_EXECUTABLE_CHANGED", "Connector 可执行文件在执行期间发生变化。", "");
  }
}

function assertRequest(request: SpawnJsonRequest): void {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1
    || !Number.isSafeInteger(request.maxStdoutBytes) || request.maxStdoutBytes < 1
    || request.argv.some((part) => typeof part !== "string" || part.includes("\0"))) {
    throw new ProcessJsonError("WSSPEC_PROCESS_REQUEST_INVALID", "进程请求参数无效。", "");
  }
}

function boundedAppend(chunks: Buffer[], capturedBytes: number, chunk: Buffer, limit: number): number {
  const available = Math.max(0, limit - capturedBytes);
  if (available > 0) chunks.push(chunk.subarray(0, available));
  return capturedBytes + chunk.byteLength;
}

function processGroupExists(child: ChildProcessWithoutNullStreams): boolean {
  if (child.pid === undefined || (process.platform !== "darwin" && process.platform !== "linux")) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined || (process.platform !== "darwin" && process.platform !== "linux")) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function cleanupError(): ProcessJsonError {
  return new ProcessJsonError("WSSPEC_PROCESS_CLEANUP_FAILED", "Connector 子进程组未能在期限内清理。", "");
}

async function cleanupProcessGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!processGroupExists(child)) return;
  const deadline = Date.now() + cleanupDeadlineMs;
  try {
    signalProcessGroup(child, "SIGTERM");
    const graceDeadline = Math.min(deadline, Date.now() + cleanupGraceMs);
    while (processGroupExists(child) && Date.now() < graceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, cleanupPollMs));
    }
    if (!processGroupExists(child)) return;
    signalProcessGroup(child, "SIGKILL");
    while (processGroupExists(child)) {
      if (Date.now() >= deadline) throw cleanupError();
      await new Promise((resolve) => setTimeout(resolve, cleanupPollMs));
    }
  } catch (error) {
    if (error instanceof ProcessJsonError && error.code === "WSSPEC_PROCESS_CLEANUP_FAILED") throw error;
    throw cleanupError();
  }
}

async function runProcess(request: SpawnJsonRequest): Promise<RawProcessResult> {
  assertRequest(request);
  const environment = processEnvironment(request.environment);
  let serializedInput: string;
  try {
    const value = JSON.stringify(request.input);
    if (value === undefined) throw new Error("not JSON");
    serializedInput = value;
  } catch {
    throw new ProcessJsonError("WSSPEC_PROCESS_REQUEST_INVALID", "进程输入必须是可序列化 JSON。", "");
  }
  const executable = await resolvedExecutable(request.executable);
  const secrets = [...(request.secrets ?? []), ...environment.secrets];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let termination: "timeout" | "output_limit" | undefined;

  const child = spawn(executable.path, [...request.argv], {
    shell: false,
    env: environment.env,
    detached: process.platform === "darwin" || process.platform === "linux",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let cleanupPromise: Promise<void> | undefined;
  const cleanupFailure = (): Promise<void> => {
    cleanupPromise ??= cleanupProcessGroup(child);
    return cleanupPromise;
  };
  const resultPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    let closed = false;
    let cleanupComplete = true;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;

    const finish = (): void => {
      if (closed && cleanupComplete) resolve({ exitCode, signal });
    };
    const terminate = (reason: typeof termination): void => {
      if (termination !== undefined) return;
      termination = reason;
      cleanupComplete = false;
      clearTimeout(timeoutTimer);
      void cleanupFailure().then(() => {
        cleanupComplete = true;
        finish();
      }, reject);
    };
    const timeoutTimer = setTimeout(() => terminate("timeout"), request.timeoutMs);
    timeoutTimer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = boundedAppend(stdoutChunks, stdoutBytes, chunk, request.maxStdoutBytes);
      if (stdoutBytes > request.maxStdoutBytes) terminate("output_limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = boundedAppend(stderrChunks, stderrBytes, chunk, request.maxStdoutBytes);
      if (stderrBytes > request.maxStdoutBytes) terminate("output_limit");
    });
    child.once("error", () => {
      clearTimeout(timeoutTimer);
      void cleanupFailure().then(
        () => reject(new ProcessJsonError("WSSPEC_PROCESS_SPAWN_FAILED", "无法启动 Connector 子进程。", "")),
        reject,
      );
    });
    child.once("close", (code, closeSignal) => {
      clearTimeout(timeoutTimer);
      closed = true;
      exitCode = code;
      signal = closeSignal;
      finish();
    });
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${serializedInput}\n`);
  const result = await resultPromise;
  try {
    if (termination === "timeout") {
      throw new ProcessJsonError("WSSPEC_PROCESS_TIMEOUT", "Connector 子进程执行超时。", "");
    }
    if (termination === "output_limit") {
      throw new ProcessJsonError("WSSPEC_PROCESS_OUTPUT_LIMIT", "Connector 子进程输出超过限制。", "");
    }
    await assertExecutableUnchanged(executable);
    const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
    const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
    const stdout = redactAndBound(rawStdout, request.maxStdoutBytes, secrets);
    const stderr = redactAndBound(rawStderr, request.maxStdoutBytes, secrets);
    const safeDiagnostic = diagnostic(rawStdout, rawStderr, secrets);
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new ProcessJsonError("WSSPEC_PROCESS_EXIT_NONZERO", "Connector 子进程非零退出。", safeDiagnostic, result.exitCode ?? undefined);
    }
    return { rawStdout, stdout, stderr, diagnostic: safeDiagnostic, secrets, cleanupFailure, exitCode: 0 };
  } catch (error) {
    await cleanupFailure();
    throw error;
  }
}

export async function spawnJson(request: SpawnJsonRequest): Promise<ProcessJsonResult> {
  const result = await runProcess(request);
  let value: unknown;
  try { value = JSON.parse(result.rawStdout); }
  catch {
    await result.cleanupFailure();
    throw new ProcessJsonError("WSSPEC_PROCESS_INVALID_JSON", "Connector 子进程未返回合法 JSON。", result.diagnostic);
  }
  return { value: redactValue(value, result.secrets), exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}

export async function spawnText(request: SpawnJsonRequest): Promise<ProcessTextResult> {
  const result = await runProcess(request);
  return { value: result.stdout, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}

export async function spawnParsedText<T>(
  request: SpawnJsonRequest,
  parse: (value: string) => T | undefined,
): Promise<ParsedProcessTextResult<T>> {
  const result = await runProcess(request);
  try {
    const value = parse(result.stdout);
    if (value === undefined) await result.cleanupFailure();
    return { value, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    await result.cleanupFailure();
    throw error;
  }
}
