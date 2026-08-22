#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  cleanEnvironment,
  inspectBoundFile,
  readAuthority,
  readSignedJson,
  sha256,
  sha256File,
  writeSignedJson,
} from "./lib/evidence.mjs";
import { prepareSmoke } from "./prepare-agent-smoke.mjs";

const execFileAsync = promisify(execFile);
const phases = ["auto", "explicit", "recovery"];
const canonicalExecutableNames = {
  codex: new Set(["codex"]),
  claude: new Set(["claude"]),
  cursor: new Set(["agent", "cursor-agent"]),
};
const sessionKeys = new Set(["session_id", "sessionId", "thread_id", "threadId", "conversation_id", "conversationId"]);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--client", "--client-executable", "--directory"].includes(name) || value === undefined || value.startsWith("--")) {
      throw new Error("用法：run-agent-smoke.mjs --client <codex|claude|cursor> --client-executable <绝对路径> [--directory <目录>]");
    }
    if (values[name] !== undefined) throw new Error(`重复参数：${name}`);
    values[name] = value;
  }
  const client = values["--client"];
  const executable = values["--client-executable"];
  if (!Object.hasOwn(canonicalExecutableNames, client) || typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw new Error("必须提供有效 client 和显式绝对 client executable；不允许 PATH 解析");
  }
  return { client, executable, directory: values["--directory"] };
}

function executableIdentity(info, digest, requestedName, resolvedName) {
  return sha256({
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: info.mode & 0o777,
    nlink: info.nlink,
    size: info.size,
    uid: info.uid,
    digest,
    requestedName,
    resolvedName,
  });
}

async function inspectExecutable(client, filename) {
  const requestedName = path.basename(filename);
  if (!canonicalExecutableNames[client].has(requestedName)) throw new Error(`${client} executable 名称不在 canonical allowlist`);
  const requestedInfo = await lstat(filename);
  const resolved = await realpath(filename);
  const info = await lstat(resolved);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : info.uid;
  if (!info.isFile() || info.isSymbolicLink() || ![0, currentUid].includes(info.uid) || (info.mode & 0o022) !== 0) {
    throw new Error("client executable 必须是 root/当前用户拥有且不可 group/world-write 的普通文件");
  }
  if (!requestedInfo.isFile() && !requestedInfo.isSymbolicLink()) throw new Error("client executable 请求路径类型无效");
  const digest = await sha256File(resolved);
  return {
    filename: resolved,
    requestedName,
    resolvedName: path.basename(resolved),
    digest,
    identity: executableIdentity(info, digest, requestedName, path.basename(resolved)),
  };
}

function prompts(phase, workItemToken) {
  if (phase === "auto") {
    return `WSSPECKIT_SMOKE_AUTO：Work Item token=${workItemToken}。请自行发现项目 Driver；inspect 当前 Work Item 后，最多完成一个 acquire -> submit 控制面周期，然后立即停止。`;
  }
  if (phase === "explicit") {
    return `WSSPECKIT_SMOKE_EXPLICIT：Work Item token=${workItemToken}。这是全新 client session；请显式使用 wsspeckit-driver，inspect 后最多完成一个 acquire -> submit 控制面周期，然后立即停止。`;
  }
  return `WSSPECKIT_SMOKE_RECOVERY：Work Item token=${workItemToken}。这是与前两阶段无关的全新 client session；只通过 inspect + acquire 恢复，推进至多一个控制面动作后立即停止。`;
}

function phaseArguments(client, phase, workItemToken) {
  const prompt = prompts(phase, workItemToken);
  if (client === "codex") {
    return ["exec", "--json", "--skip-git-repo-check", prompt];
  }
  if (client === "claude") {
    return ["--print", "--output-format", "stream-json", "--verbose", prompt];
  }
  return ["--print", "--output-format", "stream-json", prompt];
}

function findSessionId(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = findSessionId(item, depth + 1);
      if (candidate !== undefined) return candidate;
    }
    return undefined;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (sessionKeys.has(key) && typeof candidate === "string" && candidate.length > 0 && candidate.length <= 512) return candidate;
  }
  for (const candidate of Object.values(value)) {
    const nested = findSessionId(candidate, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function outputSummary(stdout) {
  const typeCounts = {};
  let parsedJsonCount = 0;
  let sessionId;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      parsedJsonCount += 1;
      sessionId ??= findSessionId(value);
      const candidate = typeof value?.type === "string" ? value.type : typeof value?.event === "string" ? value.event : "untyped";
      const type = /^[A-Za-z0-9._-]{1,64}$/u.test(candidate) ? candidate : "other";
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    } catch {
      typeCounts.nonJson = (typeCounts.nonJson ?? 0) + 1;
    }
  }
  return { sessionId, summary: { parsedJsonCount, typeCounts } };
}

async function runHost(executable, args, root, environment) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync(executable, args, {
      cwd: root,
      env: environment,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    return { startedAt, endedAt: new Date().toISOString(), exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: typeof error?.code === "number" ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
    };
  }
}

function invocationPaths(root, phase) {
  return {
    manifest: path.join(root, ".acceptance", `agent-smoke-invocation-${phase}.json`),
    receipt: path.join(root, ".acceptance", `agent-smoke-invocation-${phase}-receipt.json`),
    manifestRelative: `.acceptance/agent-smoke-invocation-${phase}.json`,
    receiptRelative: `.acceptance/agent-smoke-invocation-${phase}-receipt.json`,
  };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function wrapperBindingMatches(actual, expected) {
  return ["path", "digest", "dev", "ino", "mode", "uid", "size", "identity"]
    .every((field) => actual?.[field] === expected?.[field]);
}

async function checkedWrapper(root, expected) {
  try {
    const actual = await inspectBoundFile(root, expected.path);
    if (!wrapperBindingMatches(actual, expected)) throw new Error("binding changed");
    return actual;
  } catch {
    throw new Error("wspec wrapper identity 无效或发生漂移");
  }
}

async function wrapperCommandCounts(root) {
  let text;
  try {
    text = await readFile(path.join(root, ".acceptance", "wspec-wrapper-audit.jsonl"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { inspect: 0, acquire: 0, submit: 0 };
    throw error;
  }
  const counts = { inspect: 0, acquire: 0, submit: 0 };
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const command = JSON.parse(line)?.command;
    if (Object.hasOwn(counts, command)) counts[command] += 1;
  }
  return counts;
}

async function controlCheckpoint(root, workItemId) {
  if (!/^WSS-[0-9A-HJKMNP-TV-Z]{26}$/u.test(workItemId)) throw new Error("Work Item ID 无效");
  const controlPlane = path.join(root, ".git", "wsspec", "work-items", workItemId, "control-plane");
  const [projectionText, eventsText] = await Promise.all([
    readFile(path.join(controlPlane, "runtime.json"), "utf8"),
    readFile(path.join(controlPlane, "events.jsonl"), "utf8"),
  ]);
  const projection = object(JSON.parse(projectionText));
  const events = eventsText.split("\n").filter(Boolean).map((line) => object(JSON.parse(line)));
  if (projection?.workItemId !== workItemId || events.some((event) => event === undefined)) {
    throw new Error("控制面 checkpoint 结构无效");
  }
  let previousHash = null;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || !/^sha256:[a-f0-9]{64}$/u.test(event.eventHash ?? "")) {
      throw new Error("控制面 checkpoint event chain 无效");
    }
    previousHash = event.eventHash;
  }
  if (projection.lastSequence !== events.length || projection.lastEventHash !== previousHash) {
    throw new Error("控制面 checkpoint projection/event 未对齐");
  }
  const successfulAcquireCount = events.filter((event) => {
    const value = object(object(event.result)?.value);
    return object(value?.action)?.action === "execute";
  }).length;
  return {
    eventCount: events.length,
    lastEventHash: events.at(-1)?.eventHash ?? null,
    projectionDigest: sha256(projection),
    acquireCount: events.filter(({ eventType }) => eventType === "attempt.acquired").length,
    successfulAcquireCount,
    submitCount: events.filter(({ eventType }) => eventType === "attempt.submitted").length,
    wrapperCommands: await wrapperCommandCounts(root),
  };
}

async function persistInvocation(context, phase, record) {
  const files = invocationPaths(context.prepared.root, phase);
  const kind = `wsspeckit-agent-smoke-invocation-${phase}-receipt`;
  const signed = await writeSignedJson(files.manifest, files.receipt, kind, record, context.authority, context.prepared.authorityIdentity);
  const reference = {
    phase,
    manifest: files.manifestRelative,
    receipt: files.receiptRelative,
    manifestDigest: signed.manifestDigest,
    receiptDigest: sha256(signed.receipt),
  };
  context.runManifest = {
    ...context.runManifest,
    updatedAt: new Date().toISOString(),
    hostInvocationStatus: context.references.length === 2 ? "recorded" : "incomplete",
    hostInvocations: [...context.references, reference],
  };
  context.references.push(reference);
  await writeSignedJson(
    path.join(context.prepared.root, ".acceptance", "agent-smoke-run.json"),
    path.join(context.prepared.root, ".acceptance", "agent-smoke-run-receipt.json"),
    "wsspeckit-agent-smoke-run-receipt",
    context.runManifest,
    context.authority,
    context.prepared.authorityIdentity,
  );
}

export async function runAgentSmoke(input) {
  const executable = await inspectExecutable(input.client, input.executable);
  const prepared = await prepareSmoke({ client: input.client, directory: input.directory });
  const authority = await readAuthority(prepared.authorityFile, prepared.authorityIdentity);
  const fixture = await readSignedJson(
    path.join(prepared.root, ".acceptance", "agent-smoke.json"),
    path.join(prepared.root, ".acceptance", "agent-smoke-receipt.json"),
    "wsspeckit-agent-smoke-fixture-receipt",
    prepared.authorityFile,
    prepared.authorityIdentity,
  );
  const run = await readSignedJson(
    path.join(prepared.root, ".acceptance", "agent-smoke-run.json"),
    path.join(prepared.root, ".acceptance", "agent-smoke-run-receipt.json"),
    "wsspeckit-agent-smoke-run-receipt",
    prepared.authorityFile,
    prepared.authorityIdentity,
  );
  const expectedWrapper = object(fixture.value.wspecWrapper);
  if (expectedWrapper === undefined || expectedWrapper.wsspeckitCommit !== fixture.value.wsspeckitCommit) {
    throw new Error("signed fixture 缺少 wspec wrapper binding");
  }
  await checkedWrapper(prepared.root, expectedWrapper);
  const canonicalRoot = await realpath(prepared.root);
  const runtime = await cleanEnvironment(canonicalRoot, [path.join(canonicalRoot, "bin")], { home: process.env.HOME ?? canonicalRoot });
  const context = { prepared, authority, fixtureDigest: fixture.manifestDigest, runManifest: run.value, references: [] };
  const workItemToken = sha256(prepared.workItemId);

  for (const phase of phases) {
    const before = await inspectExecutable(input.client, input.executable);
    if (before.identity !== executable.identity || before.digest !== executable.digest || before.filename !== executable.filename) {
      throw new Error("client executable 在 observer 启动前发生漂移");
    }
    await checkedWrapper(prepared.root, expectedWrapper);
    const beforeCheckpoint = await controlCheckpoint(prepared.root, prepared.workItemId);
    const args = phaseArguments(input.client, phase, workItemToken);
    const result = await runHost(executable.filename, args, prepared.root, runtime.environment);
    const after = await inspectExecutable(input.client, input.executable);
    if (after.identity !== executable.identity || after.digest !== executable.digest || after.filename !== executable.filename) {
      throw new Error("client executable 在 observer 调用期间发生漂移");
    }
    await checkedWrapper(prepared.root, expectedWrapper);
    const afterCheckpoint = await controlCheckpoint(prepared.root, prepared.workItemId);
    const output = outputSummary(result.stdout);
    const sessionId = output.sessionId;
    const record = {
      version: 1,
      kind: "wsspeckit-agent-smoke-invocation",
      phase,
      client: input.client,
      runIdHash: run.value.runIdHash,
      workItemIdHash: run.value.workItemIdHash,
      fixtureManifestDigest: context.fixtureDigest,
      authorityIdentity: prepared.authorityIdentity,
      executableName: executable.requestedName,
      executableDigest: executable.digest,
      executableIdentity: executable.identity,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      exitCode: result.exitCode,
      sessionIdHash: sessionId === undefined ? null : sha256(sessionId),
      resumedFromSessionIdHash: null,
      argvTemplateHash: sha256(args),
      stdoutDigest: sha256(result.stdout),
      stderrDigest: sha256(result.stderr),
      stdoutEventSummary: output.summary,
      environmentKeys: Object.keys(runtime.environment).sort(),
      beforeCheckpoint,
      afterCheckpoint,
    };
    await persistInvocation(context, phase, record);
  }

  if (context.references.length !== 3) throw new Error("observer 未形成 auto/explicit/recovery 完整 session chain");
  return { ...prepared, hostInvocationStatus: context.runManifest.hostInvocationStatus };
}

async function main() {
  process.stdout.write(`${JSON.stringify(await runAgentSmoke(parseArguments(process.argv.slice(2))))}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
