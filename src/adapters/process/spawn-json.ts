import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { redactText, redactValue } from "./redaction.js";

const diagnosticLimit = 1_024;
const cleanupGraceMs = 100;
const safeEnvironmentNames = ["LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "TERM", "TZ"] as const;

export interface SpawnJsonRequest {
  executable: string;
  argv: readonly string[];
  input: unknown;
  timeoutMs: number;
  maxStdoutBytes: number;
  secrets?: readonly string[];
}

export interface ProcessJsonResult {
  value: unknown;
  exitCode: 0;
  stdout: string;
  stderr: string;
}

export type ProcessJsonErrorCode =
  | "WSSPEC_PROCESS_EXECUTABLE_INVALID"
  | "WSSPEC_PROCESS_REQUEST_INVALID"
  | "WSSPEC_PROCESS_SPAWN_FAILED"
  | "WSSPEC_PROCESS_TIMEOUT"
  | "WSSPEC_PROCESS_OUTPUT_LIMIT"
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

function diagnostic(stdout: string, stderr: string, secrets: readonly string[]): string {
  const combined = [`stdout: ${stdout}`, `stderr: ${stderr}`].join("\n");
  const bounded = Buffer.from(combined).subarray(0, diagnosticLimit).toString("utf8");
  return redactAndBound(bounded, diagnosticLimit, secrets);
}

function redactAndBound(value: string, limit: number, secrets: readonly string[]): string {
  const redactedValue = redactText(value, secrets);
  let bounded = Buffer.from(redactedValue).subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(bounded) > limit) bounded = bounded.slice(0, -1);
  return bounded;
}

function processEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(safeEnvironmentNames.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

async function resolvedExecutable(executable: string): Promise<string> {
  if (!path.isAbsolute(executable) || executable.includes("\0")) {
    throw new ProcessJsonError("WSSPEC_PROCESS_EXECUTABLE_INVALID", "可执行文件必须是绝对路径。", "");
  }
  try {
    const canonical = await realpath(executable);
    const stat = await lstat(canonical);
    await access(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular executable");
    return canonical;
  } catch {
    throw new ProcessJsonError("WSSPEC_PROCESS_EXECUTABLE_INVALID", "可执行文件不存在或不可执行。", "");
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

export async function spawnJson(request: SpawnJsonRequest): Promise<ProcessJsonResult> {
  assertRequest(request);
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

  const child = spawn(executable, [...request.argv], {
    shell: false,
    env: processEnvironment(),
    detached: process.platform === "darwin" || process.platform === "linux",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const resultPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    let closed = false;
    let cleanupComplete = true;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let cleanupTimer: NodeJS.Timeout | undefined;

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
    const terminate = (reason: typeof termination): void => {
      if (termination !== undefined) return;
      termination = reason;
      cleanupComplete = false;
      clearTimeout(timeoutTimer);
      signalGroup("SIGTERM");
      cleanupTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        cleanupTimer = setTimeout(() => {
          cleanupComplete = true;
          finish();
        }, cleanupGraceMs);
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

  const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stdout = redactAndBound(rawStdout, request.maxStdoutBytes, secrets);
  const stderr = redactAndBound(Buffer.concat(stderrChunks).toString("utf8"), request.maxStdoutBytes, secrets);
  const safeDiagnostic = diagnostic(stdout, stderr, secrets);
  if (termination === "timeout") {
    throw new ProcessJsonError("WSSPEC_PROCESS_TIMEOUT", "Connector 子进程执行超时。", safeDiagnostic);
  }
  if (termination === "output_limit") {
    throw new ProcessJsonError("WSSPEC_PROCESS_OUTPUT_LIMIT", "Connector 子进程输出超过限制。", safeDiagnostic);
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new ProcessJsonError("WSSPEC_PROCESS_EXIT_NONZERO", "Connector 子进程非零退出。", safeDiagnostic, result.exitCode ?? undefined);
  }

  let value: unknown;
  try { value = JSON.parse(rawStdout); }
  catch { throw new ProcessJsonError("WSSPEC_PROCESS_INVALID_JSON", "Connector 子进程未返回合法 JSON。", safeDiagnostic); }
  return { value: redactValue(value, secrets), exitCode: 0, stdout, stderr };
}
