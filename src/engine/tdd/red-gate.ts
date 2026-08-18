import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { computeWorkspaceTreeDigest, sha256 } from "../../domain/digests.js";
import { validate } from "../../schemas/index.js";
import {
  testPathRules as supportedTestPathRules,
  type FixedTestGate,
  type RedEvidenceInput,
  type TddCycleEvidence,
  type TestFileDigest,
  type TestPathRule,
  type TrustedEvidence,
} from "./types.js";
import { VerificationError } from "./types.js";

const summaryLimit = 8_192;
const captureLimit = summaryLimit * 4;
const reportLimit = 1024 * 1024;

const nodeTestReporterSource = [
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "function absoluteFile(value) {",
  "  const filename = String(value || '');",
  "  if (filename === '') return '';",
  "  return path.resolve(filename.startsWith('file:') ? fileURLToPath(filename) : filename);",
  "}",
  "function values(error) {",
  "  const result = [];",
  "  let current = error;",
  "  while (current && typeof current === 'object' && result.length < 8) { result.push(current); current = current.cause; }",
  "  return result;",
  "}",
  "function kind(error) {",
  "  const items = values(error);",
  "  const codes = items.map((value) => String(value.code || ''));",
  "  const names = items.map((value) => String(value.name || ''));",
  "  const messages = items.map((value) => String(value.message || ''));",
  "  if (codes.includes('ERR_ASSERTION') || names.includes('AssertionError')) return 'assertion';",
  "  if (names.includes('SyntaxError') || messages.some((value) => /SyntaxError|Unexpected token/u.test(value))) return 'syntax';",
  "  if (codes.some((value) => /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/u.test(value))",
  "    || messages.some((value) => /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/u.test(value))) return 'dependency';",
  "  return 'other';",
  "}",
  "export default async function* reporter(source) {",
  "  const failures = [];",
  "  let failureTotal = 0;",
  "  const diagnosticKinds = new Map();",
  "  let summary;",
  "  for await (const event of source) {",
  "    if (event.type === 'test:stderr' && event.data?.file) {",
  "      const message = String(event.data.message || '');",
  "      const file = absoluteFile(event.data.file);",
  "      if (/SyntaxError|Unexpected token/u.test(message)) diagnosticKinds.set(file, 'syntax');",
  "      else if (/Cannot find (?:module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/u.test(message)) diagnosticKinds.set(file, 'dependency');",
  "    }",
  "    if (event.type === 'test:fail' && event.data && event.data.details?.type !== 'suite') {",
  "      failureTotal += 1;",
  "      const file = absoluteFile(event.data.file);",
  "      const classified = kind(event.data.details?.error);",
  "      if (failures.length < 100) failures.push({ name: String(event.data.name || 'unnamed test').slice(0, 512), file, kind: classified === 'other' ? (diagnosticKinds.get(file) || 'other') : classified });",
  "    }",
  "    if (event.type === 'test:summary' && event.data && event.data.file === undefined) {",
  "      const counts = event.data.counts || {};",
  "      summary = { success: event.data.success === true, tests: Number(counts.tests || 0), passed: Number(counts.passed || 0), failed: Number(counts.failed || 0), cancelled: Number(counts.cancelled || 0), skipped: Number(counts.skipped || 0), todo: Number(counts.todo || 0) };",
  "    }",
  "  }",
  "  for (const failure of failures) { if (failure.kind === 'other' && diagnosticKinds.has(failure.file)) failure.kind = diagnosticKinds.get(failure.file); }",
  "  yield JSON.stringify({ version: 1, adapter: 'node-test', summary, failureTotal, truncated: failureTotal > failures.length, failures });",
  "}",
  "",
].join("\n");

interface NodeTestReport {
  version: 1;
  adapter: "node-test";
  summary: { success: boolean; tests: number; passed: number; failed: number; cancelled: number; skipped: number; todo: number };
  failureTotal: number;
  truncated: boolean;
  failures: Array<{ name: string; file: string; kind: "assertion" | "syntax" | "dependency" | "other" }>;
}

interface ResolvedGate {
  executable: string;
  executableDigest: string;
  environment: Record<string, string>;
  commandDigest: string;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  report?: string;
}

function normalizedRelative(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  if (normalized === "" || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new VerificationError("WSSPEC_TDD_TEST_PATH_INVALID", `测试路径无效：${filename}`);
  }
  return normalized;
}

export function isTestPath(filename: string, rules: readonly TestPathRule[] = []): boolean {
  const normalized = filename.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  return rules.some((rule) => {
    if (rule === "node") {
      return /^(?:test|tests)\//u.test(normalized)
        || normalized.includes("/__tests__/")
        || /(?:^|[._-])(?:test|tests|spec)\.[^/]+$/iu.test(basename);
    }
    if (rule === "java") return /(?:^|\/)src\/(?:test|androidTest)\//u.test(normalized);
    if (rule === "ruby") return /^(?:test|spec)\//u.test(normalized) || /_(?:test|spec)\.rb$/u.test(basename);
    return /(?:^|\/)(?:Tests|[^/]+\.Tests)\//iu.test(normalized) || /(?:Test|Tests)\.cs$/iu.test(basename);
  });
}

function assertRules(rules: readonly TestPathRule[]): void {
  if (rules.length === 0 || new Set(rules).size !== rules.length
    || rules.some((rule) => !(supportedTestPathRules as readonly string[]).includes(rule))) {
    throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "Test Gate 缺少受支持的测试路径规则。 ");
  }
}

export async function testFileManifest(worktree: string, testPaths: readonly string[], rules: readonly TestPathRule[]): Promise<{ files: TestFileDigest[]; digest: string }> {
  assertRules(rules);
  const files: TestFileDigest[] = [];
  for (const filename of [...new Set(testPaths.map(normalizedRelative))].sort((left, right) => left.localeCompare(right))) {
    if (!isTestPath(filename, rules)) throw new VerificationError("WSSPEC_TDD_TEST_PATH_INVALID", `不是项目配置允许的测试路径：${filename}`);
    const absolute = path.join(worktree, ...filename.split("/"));
    let fileStat;
    try {
      fileStat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", `Red 测试已删除：${filename}`);
      throw error;
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new VerificationError("WSSPEC_TDD_TEST_PATH_INVALID", `测试路径必须是工作区内普通文件：${filename}`);
    files.push({ path: filename, digest: sha256(await readFile(absolute)) });
  }
  if (files.length === 0) throw new VerificationError("WSSPEC_TDD_TEST_PATH_INVALID", "Test Gate 至少需要一个测试文件。 ");
  return { files, digest: sha256(`${JSON.stringify({ version: 1, files })}\n`) };
}

function effectiveEnvironment(gate: FixedTestGate): Record<string, string> {
  const inheritedNames = new Set(["PATH", ...gate.inheritEnv]);
  const inherited = Object.fromEntries([...inheritedNames].sort((left, right) => left.localeCompare(right))
    .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!] as const]));
  return { ...inherited, ...gate.env };
}

async function executableCandidate(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    const canonical = await realpath(candidate);
    const stat = await lstat(canonical);
    return stat.isFile() && !stat.isSymbolicLink() ? canonical : undefined;
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

async function resolveExecutable(command: string, environment: Readonly<Record<string, string>>, worktree: string): Promise<string> {
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    const candidate = await executableCandidate(path.isAbsolute(command) ? command : path.resolve(worktree, command));
    if (candidate !== undefined) return candidate;
  } else {
    const extensions = process.platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
    for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
      const base = path.resolve(worktree, directory === "" ? "." : directory);
      for (const extension of extensions) {
        const candidate = await executableCandidate(path.join(base, `${command}${extension}`));
        if (candidate !== undefined) return candidate;
      }
    }
  }
  throw new VerificationError("WSSPEC_TDD_GATE_EXECUTION_FAILED", `Test Gate 找不到可执行文件：${command}`);
}

function gateConfiguration(gate: FixedTestGate): Record<string, unknown> {
  return { commandId: gate.commandId, argv: [...gate.argv], cwd: gate.cwd, timeoutMs: gate.timeoutMs, inheritEnv: [...gate.inheritEnv], env: gate.env, testPathRules: [...gate.testPathRules], reporter: gate.reporter };
}

async function resolveGate(gate: FixedTestGate, worktree: string): Promise<ResolvedGate> {
  if (gate.argv.length === 0 || gate.argv.some((part) => typeof part !== "string") || gate.timeoutMs < 1 || gate.reporter.type !== "node-test" || gate.reporter.version !== 1) {
    throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", `Test Gate ${gate.commandId} 配置无效。`);
  }
  assertRules(gate.testPathRules);
  const environment = effectiveEnvironment(gate);
  const executable = await resolveExecutable(gate.argv[0]!, environment, worktree);
  const executableDigest = sha256(await readFile(executable));
  if (executableDigest !== sha256(await readFile(process.execPath)) || !gate.argv.slice(1).includes("--test") || gate.argv.some((part) => part.startsWith("--test-reporter"))) {
    throw new VerificationError("WSSPEC_TDD_REPORTER_UNSUPPORTED", "首版 trusted TDD 仅支持由引擎注入 reporter 的当前 node:test runner。 ");
  }
  const environmentDigest = sha256(`${JSON.stringify(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)))}\n`);
  const commandDigest = sha256(`${JSON.stringify({ version: 2, gate: gateConfiguration(gate), executablePathDigest: sha256(executable), executableDigest, environmentDigest, reporterDigest: sha256(nodeTestReporterSource) })}\n`);
  return { executable, executableDigest, environment, commandDigest };
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
  if (combined.byteLength <= captureLimit) return combined.toString("utf8");
  const half = captureLimit / 2;
  return Buffer.concat([combined.subarray(0, half), combined.subarray(-half)]).toString("utf8");
}

async function runFixedGate(gate: FixedTestGate, resolved: ResolvedGate, worktree: string): Promise<CommandResult> {
  const reportRoot = await mkdtemp(path.join(os.tmpdir(), "wsspec-tdd-report-"));
  const reporterPath = path.join(reportRoot, "reporter.mjs");
  const resultPath = path.join(reportRoot, "result.json");
  await writeFile(reporterPath, nodeTestReporterSource, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(resultPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  const initialResultStat = await lstat(resultPath);
  const argv = [`--test-reporter=${pathToFileURL(reporterPath).href}`, `--test-reporter-destination=${resultPath}`, ...gate.argv.slice(1)];
  let output = "";
  try {
    const child = spawn(resolved.executable, argv, { cwd: worktree, env: resolved.environment, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => { output = boundedAppend(output, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { output = boundedAppend(output, chunk); });
    let timedOut = false;
    let cleanupComplete = true;
    let closed = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    const terminate = (targetSignal: NodeJS.Signals): void => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try { process.kill(-child.pid, targetSignal); } catch { child.kill(targetSignal); }
      } else child.kill(targetSignal);
    };
    const result = await new Promise<Omit<CommandResult, "output" | "report">>((resolve, reject) => {
      const finish = (): void => { if (closed && cleanupComplete) resolve({ exitCode, signal, timedOut }); };
      const timer = setTimeout(() => {
        timedOut = true;
        cleanupComplete = false;
        terminate("SIGTERM");
        setTimeout(() => { terminate("SIGKILL"); cleanupComplete = true; finish(); }, 250);
      }, gate.timeoutMs);
      timer.unref();
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, closeSignal) => { clearTimeout(timer); closed = true; exitCode = code; signal = closeSignal; finish(); });
    });
    let report: string | undefined;
    if (!result.timedOut && result.signal === null) {
      const finalResultStat = await lstat(resultPath);
      if (!finalResultStat.isFile() || finalResultStat.isSymbolicLink() || finalResultStat.dev !== initialResultStat.dev || finalResultStat.ino !== initialResultStat.ino || finalResultStat.size > reportLimit) {
        throw new VerificationError("WSSPEC_TDD_REPORT_INVALID", "node:test reporter 结果目标被替换或超出大小限制。 ");
      }
      report = await readFile(resultPath, "utf8");
    }
    if (sha256(await readFile(resolved.executable)) !== resolved.executableDigest) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Test Gate 可执行文件在运行期间发生变化。 ");
    return { ...result, output, ...(report === undefined ? {} : { report }) };
  } finally {
    await rm(reportRoot, { recursive: true, force: true });
  }
}

function sanitizedOutput(output: string, secrets: readonly string[]): string {
  let sanitized = output;
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= 4)) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  return sanitized.replace(/((?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*)([^\s]+)/giu, "$1[REDACTED]").replace(/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]");
}

function parseNodeTestReport(value: string | undefined): NodeTestReport {
  if (value === undefined || Buffer.byteLength(value) > reportLimit) throw new VerificationError("WSSPEC_TDD_REPORT_INVALID", "node:test reporter 未产生受限结构化结果。 ");
  try { return validate<NodeTestReport>("builtin.tdd-node-test-report.v1", JSON.parse(value)); }
  catch { throw new VerificationError("WSSPEC_TDD_REPORT_INVALID", "node:test reporter 结果不符合严格 Schema。 "); }
}

async function reportFailures(report: NodeTestReport, worktree: string, testPaths: readonly string[]): Promise<NodeTestReport["failures"]> {
  const allowed = new Set(testPaths);
  const canonicalWorktree = await realpath(worktree);
  const matched = await Promise.all(report.failures.map(async (failure) => {
    try {
      const relative = path.relative(canonicalWorktree, await realpath(failure.file)).replaceAll("\\", "/");
      return relative !== "" && !relative.startsWith("../") && !path.isAbsolute(relative) && allowed.has(relative) ? failure : undefined;
    } catch { return undefined; }
  }));
  return matched.filter((failure): failure is NodeTestReport["failures"][number] => failure !== undefined);
}

function evidenceId(unsigned: Omit<TrustedEvidence, "evidenceId">): string {
  return `evidence-${sha256(`${JSON.stringify(unsigned)}\n`).slice("sha256:".length)}`;
}

export function parseTrustedEvidence(value: unknown): TrustedEvidence | undefined {
  try {
    const evidence = validate<TrustedEvidence>("builtin.tdd-trusted-evidence.v1", value);
    const { evidenceId: actualId, ...unsigned } = evidence;
    if (actualId !== evidenceId(unsigned)) return undefined;
    if ((evidence.phase === "red" && (evidence.exitCode === 0 || evidence.failedTests.length === 0)) || (evidence.phase === "green" && (evidence.exitCode !== 0 || evidence.failedTests.length !== 0)) || evidence.testFiles.length !== evidence.testPaths.length || evidence.testFiles.some((file, index) => file.path !== evidence.testPaths[index])) return undefined;
    return evidence;
  } catch { return undefined; }
}

export function parseTddCycleEvidence(value: unknown): TddCycleEvidence | undefined {
  try { return validate<TddCycleEvidence>("builtin.tdd-cycle-evidence.v1", value); }
  catch { return undefined; }
}

export async function executeTrustedTestGate(input: { taskId: string; phase: "red" | "green"; stepId: string; gate: FixedTestGate; worktree: string; workspaceDigest: string; testPaths: readonly string[]; expectedCommandDigest?: string; secrets?: readonly string[] }): Promise<TrustedEvidence> {
  const currentWorkspaceDigest = await computeWorkspaceTreeDigest(input.worktree);
  if (currentWorkspaceDigest !== input.workspaceDigest) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Test Gate 输入的 workspace digest 已失效。 ");
  const resolved = await resolveGate(input.gate, input.worktree);
  if (input.expectedCommandDigest !== undefined && input.expectedCommandDigest !== resolved.commandDigest) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Red Evidence 与当前命令环境或可执行文件不再一致。 ");
  const manifest = await testFileManifest(input.worktree, input.testPaths, input.gate.testPathRules);
  const result = await runFixedGate(input.gate, resolved, input.worktree).catch((error: unknown) => {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError("WSSPEC_TDD_GATE_EXECUTION_FAILED", `Test Gate 无法启动：${(error as Error).message}`);
  });
  if (result.timedOut) throw new VerificationError("WSSPEC_TDD_RED_TIMEOUT", "Test Gate 超时，不能形成可信 Evidence。 ");
  if (result.signal !== null || result.exitCode === null) throw new VerificationError("WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE", "Test Gate 被 signal 终止，不能形成可信 Evidence。 ");
  const report = parseNodeTestReport(result.report);
  const [outputWorkspaceDigest, outputManifest] = await Promise.all([computeWorkspaceTreeDigest(input.worktree), testFileManifest(input.worktree, input.testPaths, input.gate.testPathRules)]);
  if (outputWorkspaceDigest !== currentWorkspaceDigest || outputManifest.digest !== manifest.digest) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Test Gate 执行期间修改了 workspace 或 Red 测试。 ");
  if (report.truncated || report.failureTotal !== report.failures.length || report.failureTotal !== report.summary.failed) {
    throw new VerificationError("WSSPEC_TDD_REPORT_INVALID", "node:test reporter failure 聚合不完整，不能形成可信 Evidence。 ");
  }
  if (report.failures.some(({ kind }) => kind === "syntax")) throw new VerificationError("WSSPEC_TDD_RED_SYNTAX_FAILURE", "固定 Test Gate 存在语法错误，不能形成可信 Evidence。 ");
  if (report.failures.some(({ kind }) => kind === "dependency" || kind === "other")) throw new VerificationError("WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE", "固定 Test Gate 存在依赖或未分类失败，不能形成可信 Evidence。 ");
  const matchedFailures = await reportFailures(report, input.worktree, manifest.files.map(({ path: filename }) => filename));
  const inheritedSecrets = input.gate.inheritEnv.flatMap((name) => process.env[name] === undefined ? [] : [process.env[name]!]);
  const secrets = [...Object.values(input.gate.env), ...inheritedSecrets, ...(input.secrets ?? [])];
  const assertionFailures = matchedFailures.filter(({ kind }) => kind === "assertion");
  if (input.phase === "red") {
    if (result.exitCode === 0 || report.summary.success) throw new VerificationError("WSSPEC_TDD_RED_NOT_OBSERVED", "Test Gate 未观察到预期失败。 ");
    if (assertionFailures.length === 0 || report.summary.failed === 0) throw new VerificationError("WSSPEC_TDD_REPORT_INVALID", "结构化结果未包含命中 Red 测试路径的 assertion failure。 ");
  } else if (result.exitCode !== 0 || !report.summary.success || report.summary.failed !== 0 || report.summary.tests === 0) {
    throw new VerificationError("WSSPEC_TDD_GREEN_NOT_OBSERVED", "同一 Test Gate 未形成结构化零失败 Green 结果。 ");
  }
  const failures = input.phase === "red" ? assertionFailures.map(({ name }) => sanitizedOutput(name, secrets)).slice(0, 100) : [];
  const summary = sanitizedOutput(input.phase === "red" ? failures.join("\n") : `node:test passed ${report.summary.passed}/${report.summary.tests}`, secrets).slice(0, summaryLimit);
  const unsigned: Omit<TrustedEvidence, "evidenceId"> = { level: "trusted", phase: input.phase, taskId: input.taskId, stepId: input.stepId, commandId: input.gate.commandId, commandDigest: resolved.commandDigest, exitCode: result.exitCode, failedTests: failures, testPaths: manifest.files.map(({ path: filename }) => filename), testFiles: manifest.files, testPathsDigest: manifest.digest, testPathRules: [...input.gate.testPathRules], workspaceDigest: outputWorkspaceDigest, summary };
  return { evidenceId: evidenceId(unsigned), ...unsigned };
}

export async function recordRedEvidence(input: RedEvidenceInput): Promise<TrustedEvidence> {
  if (input.step.id !== "verify-red" || input.step.uses !== "command.execute" || input.step.action !== "quality.test" || input.step.expectedOutcome !== "test-failure") throw new VerificationError("WSSPEC_TDD_STEP_INVALID", "Red Evidence 只能由编译后的 verify-red Step 产生。 ");
  const modified = [...new Set(input.modifiedFiles.map(normalizedRelative))].sort((left, right) => left.localeCompare(right));
  const tests = [...new Set(input.testPaths.map(normalizedRelative))].sort((left, right) => left.localeCompare(right));
  if (modified.length === 0 || modified.some((filename) => !isTestPath(filename, input.gate.testPathRules)) || modified.some((filename) => !tests.includes(filename))) throw new VerificationError("WSSPEC_TDD_RED_SCOPE_INVALID", "Red 阶段只能修改项目配置允许的测试路径。 ");
  return executeTrustedTestGate({ taskId: input.taskId, phase: "red", stepId: input.step.id, gate: input.gate, worktree: input.worktree, workspaceDigest: input.workspaceDigest, testPaths: tests, ...(input.secrets === undefined ? {} : { secrets: input.secrets }) });
}

export async function fixedGateCommandDigest(gate: FixedTestGate, worktree: string): Promise<string> {
  return (await resolveGate(gate, worktree)).commandDigest;
}
