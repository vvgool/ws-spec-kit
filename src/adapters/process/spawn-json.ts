import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { redactText, redactValue } from "./redaction.js";

const diagnosticLimit = 1_024;
const cleanupGraceMs = 100;
const cleanupDeadlineMs = 1_000;
const cleanupPollMs = 10;
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

interface RawProcessResult {
  rawStdout: string;
  stdout: string;
  stderr: string;
  diagnostic: string;
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

function processEnvironment(environment: SpawnJsonRequest["environment"]): NodeJS.ProcessEnv {
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
  return { ...inherited, ...configured, PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` };
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
  const stat = await lstat(executable, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular executable");
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    digest: createHash("sha256").update(await readFile(executable)).digest("hex"),
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
  const secrets = request.secrets ?? [];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let termination: "timeout" | "output_limit" | undefined;

  const child = spawn(executable.path, [...request.argv], {
    shell: false,
    env: environment,
    detached: process.platform === "darwin" || process.platform === "linux",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const resultPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    let closed = false;
    let cleanupComplete = true;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let cleanupDeadline: number | undefined;

    const finish = (): void => {
      if (closed && cleanupComplete) resolve({ exitCode, signal });
    };
    const signalGroup = (targetSignal: NodeJS.Signals): void => {
      if (child.pid !== undefined && (process.platform === "darwin" || process.platform === "linux")) {
        try { process.kill(-child.pid, targetSignal); } catch { child.kill(targetSignal); }
      } else {
        child.kill(targetSignal);
      }
    };
    const processGroupExists = (): boolean => {
      if (child.pid === undefined || (process.platform !== "darwin" && process.platform !== "linux")) return !closed;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const pollCleanup = (): void => {
      if (!processGroupExists()) {
        cleanupComplete = true;
        finish();
        return;
      }
      if (cleanupDeadline !== undefined && Date.now() >= cleanupDeadline) {
        reject(new ProcessJsonError("WSSPEC_PROCESS_CLEANUP_FAILED", "Connector 子进程组未能在期限内清理。", ""));
        return;
      }
      cleanupTimer = setTimeout(pollCleanup, cleanupPollMs);
    };
    const terminate = (reason: typeof termination): void => {
      if (termination !== undefined) return;
      termination = reason;
      cleanupComplete = false;
      cleanupDeadline = Date.now() + cleanupDeadlineMs;
      clearTimeout(timeoutTimer);
      signalGroup("SIGTERM");
      cleanupTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        pollCleanup();
      }, cleanupGraceMs);
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
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      reject(new ProcessJsonError("WSSPEC_PROCESS_SPAWN_FAILED", "无法启动 Connector 子进程。", ""));
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
  await assertExecutableUnchanged(executable);

  const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
  const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
  const stdout = redactAndBound(rawStdout, request.maxStdoutBytes, secrets);
  const stderr = redactAndBound(rawStderr, request.maxStdoutBytes, secrets);
  const safeDiagnostic = diagnostic(rawStdout, rawStderr, secrets);
  if (termination === "timeout") {
    throw new ProcessJsonError("WSSPEC_PROCESS_TIMEOUT", "Connector 子进程执行超时。", "");
  }
  if (termination === "output_limit") {
    throw new ProcessJsonError("WSSPEC_PROCESS_OUTPUT_LIMIT", "Connector 子进程输出超过限制。", "");
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new ProcessJsonError("WSSPEC_PROCESS_EXIT_NONZERO", "Connector 子进程非零退出。", safeDiagnostic, result.exitCode ?? undefined);
  }

  return { rawStdout, stdout, stderr, diagnostic: safeDiagnostic, exitCode: 0 };
}

export async function spawnJson(request: SpawnJsonRequest): Promise<ProcessJsonResult> {
  const result = await runProcess(request);
  let value: unknown;
  try { value = JSON.parse(result.rawStdout); }
  catch { throw new ProcessJsonError("WSSPEC_PROCESS_INVALID_JSON", "Connector 子进程未返回合法 JSON。", result.diagnostic); }
  return { value: redactValue(value, request.secrets ?? []), exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}

export async function spawnText(request: SpawnJsonRequest): Promise<ProcessTextResult> {
  const result = await runProcess(request);
  return { value: result.stdout, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}
