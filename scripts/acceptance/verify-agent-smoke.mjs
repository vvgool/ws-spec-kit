#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import {
  cleanEnvironment,
  cleanEnvironmentKeys,
  inspectBoundFile,
  readSignedJson,
  sha256,
  sha256File,
  writeSignedJson,
} from "./lib/evidence.mjs";

const runtimeDirectory = process.env.WSSPECKIT_ACCEPTANCE_RUNTIME === "source" ? "../../src" : "../../dist";
const [{ loadApplicationState }, { computeArtifactContentHash, readArtifact }, { parseTddCycleEvidence, parseTrustedEvidence }, { readEvents }] = await Promise.all([
  import(`${runtimeDirectory}/application/state.js`),
  import(`${runtimeDirectory}/domain/artifacts.js`),
  import(`${runtimeDirectory}/engine/tdd/red-gate.js`),
  import(`${runtimeDirectory}/storage/events.js`),
]);

const execFileAsync = promisify(execFile);
const clients = new Set(["codex", "claude", "cursor"]);
const hostPhases = ["auto", "explicit", "recovery"];
const hostExecutableNames = {
  codex: new Set(["codex"]),
  claude: new Set(["claude"]),
  cursor: new Set(["agent", "cursor-agent"]),
};
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsxLoader = path.join(sourceRoot, "node_modules", "tsx", "dist", "loader.mjs");
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--client", "--repo", "--authority", "--authority-identity"].includes(name) || value === undefined || value.startsWith("--")) {
      throw new Error("用法：verify-agent-smoke.mjs --client <codex|claude|cursor> --repo <目录> --authority <文件> --authority-identity <sha256>");
    }
    if (values[name] !== undefined) throw new Error(`重复参数：${name}`);
    values[name] = value;
  }
  if (!clients.has(values["--client"]) || values["--repo"] === undefined || values["--authority"] === undefined
    || !/^sha256:[a-f0-9]{64}$/u.test(values["--authority-identity"] ?? "")) {
    throw new Error("必须提供有效的 --client、--repo、--authority 和 --authority-identity");
  }
  return {
    client: values["--client"],
    repo: path.resolve(values["--repo"]),
    authority: path.resolve(values["--authority"]),
    authorityIdentity: values["--authority-identity"],
  };
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function wrapperBindingMatches(actual, expected) {
  return ["path", "digest", "dev", "ino", "mode", "uid", "size", "identity"]
    .every((field) => actual?.[field] === expected?.[field]);
}

function workflowCheckpoint(value, label) {
  const checkpoint = record(value);
  const commands = record(checkpoint?.wrapperCommands);
  const activeClaim = checkpoint?.activeClaim === null ? null : record(checkpoint?.activeClaim);
  const lastReacquire = checkpoint?.lastReacquire === null ? null : record(checkpoint?.lastReacquire);
  const integer = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0;
  const activeClaimValid = activeClaim === null || (typeof activeClaim?.stageId === "string"
    && typeof activeClaim.attemptId === "string" && digestPattern.test(activeClaim.leaseDigest ?? ""));
  const reacquireValid = lastReacquire === null || (Number.isSafeInteger(lastReacquire?.eventSequence)
    && lastReacquire.eventSequence > 0 && typeof lastReacquire.stageId === "string"
    && typeof lastReacquire.attemptId === "string" && digestPattern.test(lastReacquire.previousLeaseDigest ?? "")
    && digestPattern.test(lastReacquire.leaseDigest ?? "") && lastReacquire.previousLeaseDigest !== lastReacquire.leaseDigest);
  const valid = checkpoint !== undefined && integer(checkpoint.eventCount)
    && (checkpoint.lastEventHash === null || digestPattern.test(checkpoint.lastEventHash))
    && (checkpoint.eventCount === 0) === (checkpoint.lastEventHash === null)
    && digestPattern.test(checkpoint.projectionDigest ?? "")
    && integer(checkpoint.acquireCount) && integer(checkpoint.acquiredCount) && integer(checkpoint.reacquiredCount)
    && checkpoint.acquireCount === checkpoint.acquiredCount + checkpoint.reacquiredCount
    && integer(checkpoint.successfulAcquireCount) && activeClaimValid && reacquireValid
    && integer(checkpoint.submitCount) && commands !== undefined
    && integer(commands.inspect) && integer(commands.acquire) && integer(commands.submit);
  if (!valid) throw new Error(`${label} checkpoint 字段无效`);
  return checkpoint;
}

export function validateHostWorkflowPhases(invocations) {
  if (!Array.isArray(invocations) || invocations.length !== hostPhases.length) {
    throw new Error("Host 阶段证据必须包含 auto/explicit/recovery");
  }
  const sessions = new Set();
  const checkpoints = invocations.map((invocation, index) => {
    const phase = hostPhases[index];
    if (record(invocation)?.phase !== phase || !digestPattern.test(invocation.sessionIdHash ?? "")) {
      throw new Error(`${phase} 阶段或 session binding 无效`);
    }
    sessions.add(invocation.sessionIdHash);
    return {
      phase,
      before: workflowCheckpoint(invocation.beforeCheckpoint, `${phase}.before`),
      after: workflowCheckpoint(invocation.afterCheckpoint, `${phase}.after`),
    };
  });
  if (sessions.size !== hostPhases.length) throw new Error("auto/explicit/recovery 必须是三个 fresh client sessions");

  for (let index = 1; index < checkpoints.length; index += 1) {
    if (sha256(checkpoints[index - 1].after) !== sha256(checkpoints[index].before)) {
      throw new Error(`${checkpoints[index].phase} before checkpoint 未与上一阶段严格串联`);
    }
  }

  const countPaths = [
    ["eventCount"],
    ["acquireCount"],
    ["acquiredCount"],
    ["reacquiredCount"],
    ["successfulAcquireCount"],
    ["submitCount"],
    ["wrapperCommands", "inspect"],
    ["wrapperCommands", "acquire"],
    ["wrapperCommands", "submit"],
  ];
  const count = (checkpoint, segments) => segments.reduce((value, segment) => value[segment], checkpoint);
  for (const { phase, before, after } of checkpoints) {
    for (const segments of countPaths) {
      if (count(after, segments) < count(before, segments)) throw new Error(`${phase} 阶段 checkpoint 计数回退`);
    }
    const eventDelta = after.eventCount - before.eventCount;
    const inspectDelta = after.wrapperCommands.inspect - before.wrapperCommands.inspect;
    const acquireDelta = after.acquireCount - before.acquireCount;
    const acquiredDelta = after.acquiredCount - before.acquiredCount;
    const reacquiredDelta = after.reacquiredCount - before.reacquiredCount;
    const successfulAcquireDelta = after.successfulAcquireCount - before.successfulAcquireCount;
    const submitDelta = after.submitCount - before.submitCount;
    const wrapperAcquireDelta = after.wrapperCommands.acquire - before.wrapperCommands.acquire;
    const wrapperSubmitDelta = after.wrapperCommands.submit - before.wrapperCommands.submit;
    if (inspectDelta < 1) throw new Error(`${phase} 阶段缺少 bound wspec inspect delta`);
    if (eventDelta < 1 || after.lastEventHash === before.lastEventHash || after.projectionDigest === before.projectionDigest) {
      throw new Error(`${phase} 阶段缺少控制面 event/projection delta`);
    }
    if (phase === "auto") {
      if (wrapperAcquireDelta < 1 || acquiredDelta < 1 || reacquiredDelta !== 0 || successfulAcquireDelta < 1
        || after.activeClaim === null) {
        throw new Error("auto 阶段必须通过 inspect + acquire 获得 Work Package");
      }
      if (wrapperSubmitDelta !== 0 || submitDelta !== 0) throw new Error("auto 阶段必须在 acquire 后停止");
      continue;
    }
    const previous = record(before.activeClaim);
    const rotation = record(after.lastReacquire);
    const retainedAttempt = previous !== undefined && rotation !== undefined
      && rotation.eventSequence > before.eventCount
      && rotation.stageId === previous.stageId && rotation.attemptId === previous.attemptId
      && rotation.previousLeaseDigest === previous.leaseDigest && rotation.leaseDigest !== previous.leaseDigest;
    if (wrapperAcquireDelta < 1 || acquireDelta < 1 || reacquiredDelta !== 1
      || successfulAcquireDelta < 1 || !retainedAttempt) {
      throw new Error(`${phase} 阶段必须对 before-checkpoint 的同一 Attempt 执行一次 reacquire 并轮换 Lease`);
    }
    if (phase === "explicit") {
      if (wrapperSubmitDelta !== 1 || submitDelta !== 1) throw new Error("explicit 阶段必须只 submit 一个 Stage 后停止");
    } else if (wrapperSubmitDelta < 1 || submitDelta < 1) {
      throw new Error("recovery 阶段必须在 reacquire 后消费 action 至终态");
    }
  }
  return `observer-signed ${hostPhases.join("/")} phase deltas`;
}

function artifactReferences(projection) {
  const references = [];
  for (const context of Object.values(projection.contexts)) {
    const result = record(record(context)?.result);
    if (!Array.isArray(result?.artifacts)) continue;
    for (const artifact of result.artifacts) {
      const candidate = record(artifact);
      if (typeof candidate?.artifactType === "string" && typeof candidate.path === "string") references.push(candidate);
    }
  }
  return references;
}

function structuredYaml(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const section = new RegExp(`^#{1,6}\\s+${escaped}\\s*$([\\s\\S]*?)(?=^#{1,6}\\s+|(?![\\s\\S]))`, "mu").exec(body)?.[1] ?? "";
  const fenced = /```yaml\s*\n([\s\S]*?)\n```/u.exec(section)?.[1];
  return fenced === undefined ? undefined : parseYaml(fenced);
}

export async function checkedArtifact(worktree, reference) {
  const root = await realpath(worktree);
  const filename = await realpath(path.resolve(worktree, reference.path));
  if (path.relative(root, filename).startsWith("..") || path.isAbsolute(path.relative(root, filename))) {
    throw new Error("Artifact 越出 Worktree");
  }
  const artifact = await readArtifact(filename);
  const { contentHash, ...unsignedMetadata } = artifact.metadata;
  if (artifact.metadata.artifactType !== reference.artifactType
    || artifact.metadata.revision !== reference.revision && reference.revision !== undefined
    || contentHash !== reference.contentHash
    || computeArtifactContentHash(unsignedMetadata, artifact.body) !== contentHash) {
    throw new Error("Artifact 引用与正文不匹配");
  }
  return artifact;
}

async function git(runtime, repo, ...args) {
  return execFileAsync(runtime.gitExecutable, [
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd: repo, env: runtime.environment, maxBuffer: 2 * 1024 * 1024 });
}

async function runResult(executable, args, options) {
  try {
    const result = await execFileAsync(executable, args, { ...options, maxBuffer: 2 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error;
    return { code: typeof failure?.code === "number" ? failure.code : 1, stdout: failure?.stdout ?? "", stderr: failure?.stderr ?? "" };
  }
}

async function runBehaviorChallenges(checkout, runtime) {
  const token = randomBytes(12).toString("hex");
  const cases = [
    [],
    ["", "   ", "\t\n"],
    [`  READY-${token.toUpperCase()}  `, "", ` Next-${token.slice(0, 8)} `],
    [` Alpha-${token.slice(0, 4)} `, ` BETA-${token.slice(4, 8)} `, `gamma-${token.slice(8, 12)}`, ` DELTA-${token.slice(12, 16)} `],
    [`  Café-${token.slice(0, 6)}!  `, `你好，${token.slice(6, 12)}。`, ` déjà-vu-${token.slice(12, 18)}? `],
  ];
  const probe = [
    `import { formatLabelParts } from ${JSON.stringify(pathToFileURL(path.join(checkout, "src", "labels.ts")).href)};`,
    `const cases = ${JSON.stringify(cases)};`,
    "const oracle = (parts) => parts.map((value) => value.trim().toLowerCase()).filter(Boolean).join(' / ');",
    "if (typeof formatLabelParts !== 'function') process.exit(21);",
    "for (const parts of cases) {",
    "  const before = JSON.stringify(parts);",
    "  const expected = oracle(parts);",
    "  for (let repeat = 0; repeat < 3; repeat += 1) {",
    "    if (formatLabelParts(parts) !== expected) process.exit(23);",
    "    if (JSON.stringify(parts) !== before) process.exit(24);",
    "  }",
    "}",
  ].join("\n");
  return runResult(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", probe], {
    cwd: checkout,
    env: runtime.environment,
  });
}

async function behaviorProbe(state, runtime) {
  const temporary = await mkdtemp(path.join(runtime.environment.TMPDIR, "behavior-probe-"));
  const checkout = path.join(temporary, "checkout");
  try {
    await git(runtime, inputSafeCwd(state.worktree), "clone", "--quiet", "--no-local", "--no-hardlinks", state.worktree, checkout);
    const exported = await runBehaviorChallenges(checkout, runtime);
    if (exported.code !== 0) throw new Error("formatLabelParts 未通过 verifier-private runtime challenges");
    const originalTests = await runResult(process.execPath, ["--import", tsxLoader, "--test", "tests/labels.test.ts"], { cwd: checkout, env: runtime.environment });
    if (originalTests.code !== 0) throw new Error("目标测试未通过");
    const mutants = [
      [
        "export function normalizeLabel(value: string): string { return value.trim().toLowerCase(); }",
        "export function formatLabelParts(): string { return '__WSSPEC_VERIFIER_CONSTANT_MUTANT__'; }",
        "",
      ].join("\n"),
      [
        "export function normalizeLabel(value: string): string { return value.toLowerCase(); }",
        "export function formatLabelParts(parts: readonly string[]): string { return parts.map(normalizeLabel).join(' / '); }",
        "",
      ].join("\n"),
    ];
    for (const [index, mutantSource] of mutants.entries()) {
      await writeFile(path.join(checkout, "src", "labels.ts"), mutantSource, "utf8");
      const mutantBehavior = await runBehaviorChallenges(checkout, runtime);
      if (mutantBehavior.code === 0) throw new Error(`行为 oracle 未捕获 verifier-owned mutant ${index + 1}`);
      const mutantTest = await runResult(process.execPath, ["--import", tsxLoader, "--test", "tests/labels.test.ts"], { cwd: checkout, env: runtime.environment });
      if (mutantTest.code === 0) throw new Error(`目标测试未捕获 verifier-owned mutant ${index + 1}`);
    }
    return "private multi-challenge 与双 mutation probe 通过";
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function inputSafeCwd(worktree) {
  return path.dirname(worktree);
}

async function checkedHostInvocations(input, metadata, runManifest) {
  if (runManifest.hostInvocationStatus !== "recorded" || !Array.isArray(runManifest.hostInvocations)
    || runManifest.hostInvocations.length !== hostPhases.length) {
    throw new Error("缺少 observer-signed auto/explicit/recovery invocation receipts");
  }
  const invocations = [];
  for (const [index, phase] of hostPhases.entries()) {
    const reference = record(runManifest.hostInvocations[index]);
    const expectedManifest = `.acceptance/agent-smoke-invocation-${phase}.json`;
    const expectedReceipt = `.acceptance/agent-smoke-invocation-${phase}-receipt.json`;
    if (reference?.phase !== phase || reference.manifest !== expectedManifest || reference.receipt !== expectedReceipt) {
      throw new Error(`${phase} invocation reference 无效`);
    }
    const signed = await readSignedJson(
      path.join(input.repo, expectedManifest),
      path.join(input.repo, expectedReceipt),
      `wsspeckit-agent-smoke-invocation-${phase}-receipt`,
      input.authority,
      input.authorityIdentity,
    );
    if (reference.manifestDigest !== signed.manifestDigest || reference.receiptDigest !== sha256(signed.receipt)) {
      throw new Error(`${phase} invocation receipt digest 不匹配`);
    }
    const invocation = record(signed.value);
    const summary = record(invocation?.stdoutEventSummary);
    const typeCounts = record(summary?.typeCounts);
    const started = Date.parse(invocation?.startedAt ?? "");
    const ended = Date.parse(invocation?.endedAt ?? "");
    const fieldsValid = invocation?.version === 1 && invocation.kind === "wsspeckit-agent-smoke-invocation"
      && invocation.phase === phase && invocation.client === input.client && invocation.client === metadata.client
      && invocation.runIdHash === metadata.runIdHash && invocation.workItemIdHash === sha256(metadata.workItemId)
      && invocation.fixtureManifestDigest === runManifest.fixtureManifestDigest
      && invocation.authorityIdentity === input.authorityIdentity
      && hostExecutableNames[input.client].has(invocation.executableName)
      && typeof invocation.executableDigest === "string" && digestPattern.test(invocation.executableDigest)
      && typeof invocation.executableIdentity === "string" && digestPattern.test(invocation.executableIdentity)
      && Number.isFinite(started) && Number.isFinite(ended) && ended >= started && invocation.exitCode === 0
      && typeof invocation.sessionIdHash === "string" && digestPattern.test(invocation.sessionIdHash)
      && invocation.resumedFromSessionIdHash === null
      && typeof invocation.argvTemplateHash === "string" && digestPattern.test(invocation.argvTemplateHash)
      && typeof invocation.stdoutDigest === "string" && digestPattern.test(invocation.stdoutDigest)
      && typeof invocation.stderrDigest === "string" && digestPattern.test(invocation.stderrDigest)
      && Number.isInteger(summary?.parsedJsonCount) && summary.parsedJsonCount > 0 && typeCounts !== undefined
      && Array.isArray(invocation.environmentKeys) && JSON.stringify(invocation.environmentKeys) === JSON.stringify(cleanEnvironmentKeys);
    if (!fieldsValid) throw new Error(`${phase} invocation 字段或 executable binding 无效`);
    invocations.push(invocation);
  }
  if (new Set(invocations.map(({ sessionIdHash }) => sessionIdHash)).size !== hostPhases.length) {
    throw new Error("auto/explicit/recovery 必须是三个 fresh client sessions");
  }
  const executableBindings = new Set(invocations.map(({ executableDigest, executableIdentity }) => `${executableDigest}:${executableIdentity}`));
  if (executableBindings.size !== 1) throw new Error("三阶段 client executable binding 不一致");
  return invocations;
}

async function verifySmoke(input) {
  const runtime = await cleanEnvironment(input.repo);
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok, detail });
  let metadata;
  let authority;
  let runManifest;
  let fixtureManifestDigest;
  try {
    const fixture = await readSignedJson(
      path.join(input.repo, ".acceptance", "agent-smoke.json"),
      path.join(input.repo, ".acceptance", "agent-smoke-receipt.json"),
      "wsspeckit-agent-smoke-fixture-receipt",
      input.authority,
      input.authorityIdentity,
    );
    const run = await readSignedJson(
      path.join(input.repo, ".acceptance", "agent-smoke-run.json"),
      path.join(input.repo, ".acceptance", "agent-smoke-run-receipt.json"),
      "wsspeckit-agent-smoke-run-receipt",
      input.authority,
      input.authorityIdentity,
    );
    metadata = fixture.value;
    authority = fixture.authority;
    runManifest = run.value;
    fixtureManifestDigest = fixture.manifestDigest;
    check("fixture.authority", true, fixture.manifestDigest);
    check("run.manifest", true, run.manifestDigest);
  } catch (error) {
    check("fixture.authority", false, error instanceof Error ? error.message : "authority 不可验证");
    return { version: 1, ok: false, client: input.client, workItemId: "unknown", checks };
  }
  const workItemId = typeof metadata.workItemId === "string" ? metadata.workItemId : "unknown";
  check("fixture.client", metadata.kind === "wsspeckit-agent-smoke" && metadata.client === input.client, metadata.client === input.client ? "匹配" : "客户端不匹配");
  let requirementValid = false;
  try {
    requirementValid = await sha256File(path.join(input.repo, "SMOKE_REQUIREMENT.md")) === metadata.requirementDigest;
  } catch {}
  check("fixture.requirement", requirementValid, "固定 Smoke requirement 必须匹配 signed digest");
  const runBindingValid = runManifest.kind === "wsspeckit-agent-smoke-run"
    && runManifest.client === metadata.client
    && runManifest.runIdHash === metadata.runIdHash
    && runManifest.workItemIdHash === sha256(metadata.workItemId)
    && runManifest.requirementDigest === metadata.requirementDigest
    && runManifest.baselineCommit === metadata.baselineCommit
    && runManifest.baselineTree === metadata.baselineTree
    && runManifest.driverDigest === metadata.driverDigest
    && runManifest.authorityIdentity === input.authorityIdentity
    && runManifest.workflowRef === metadata.workflowRef
    && runManifest.wsspeckitCommit === metadata.wsspeckitCommit
    && runManifest.wspecWrapperDigest === record(metadata.wspecWrapper)?.digest
    && runManifest.wspecWrapperIdentity === record(metadata.wspecWrapper)?.identity
    && runManifest.userIndexDigest === record(metadata.userIndex)?.digest
    && runManifest.userIndexIdentity === record(metadata.userIndex)?.identity
    && ["not-run", "no-go", "verified"].includes(runManifest.hostPhaseEvidenceStatus)
    && runManifest.fixtureManifestDigest === fixtureManifestDigest;
  check("run.binding", runBindingValid, "run manifest 必须绑定 signed fixture、Work Item hash 与 seed baseline");
  let wrapperValid = false;
  try {
    const expected = record(metadata.wspecWrapper);
    const actual = expected?.path === "bin/wspec" ? await inspectBoundFile(input.repo, expected.path) : undefined;
    wrapperValid = actual !== undefined && expected.wsspeckitCommit === metadata.wsspeckitCommit
      && wrapperBindingMatches(actual, expected);
  } catch {}
  check("fixture.wspec-wrapper", wrapperValid, "bin/wspec 必须匹配 signed path/digest/device/inode/mode/uid/size/identity/WSSpecKit commit");
  let userIndexValid = false;
  try {
    const expected = record(metadata.userIndex);
    const actual = typeof expected?.path === "string" ? await inspectBoundFile(input.repo, expected.path) : undefined;
    userIndexValid = actual !== undefined && wrapperBindingMatches(actual, expected);
  } catch {}
  check("git.user-index", userIndexValid, "Work Item 真实 index 必须保持 signed path/digest/device/inode/mode/uid/size/identity");
  let hostInvocations;
  try {
    hostInvocations = await checkedHostInvocations(input, metadata, runManifest);
    check("host.invocations", true, `observer-signed ${hostPhases.join("/")} fresh sessions`);
  } catch (error) {
    check("host.invocations", false, error instanceof Error ? error.message : "Host invocation receipts 无效");
  }
  try {
    check("host.workflow-phases", true, validateHostWorkflowPhases(hostInvocations));
  } catch (error) {
    check("host.workflow-phases", false, error instanceof Error ? error.message : "Host workflow phase deltas 无效");
  }

  let state;
  let events = [];
  try {
    state = await loadApplicationState(input.repo, workItemId);
    events = await readEvents(state.projection.controlPlane);
    check("state.integrity", true, `事件链 ${events.length} 条`);
  } catch (error) {
    check("state.integrity", false, error instanceof Error ? error.message : "状态不可读");
  }

  if (state !== undefined) {
    check(
      "fixture.workflow",
      metadata.workflowRef === "builtin://workflows/feature-delivery" && metadata.profile === "quick"
        && state.snapshot.workflowRef === metadata.workflowRef && state.snapshot.selectedProfile === metadata.profile,
      "signed fixture 与 Application snapshot 必须绑定内置 Quick 功能 Workflow",
    );
    check(
      "fixture.provider",
      state.snapshot.skillResolution.provider === metadata.client && state.snapshot.skillResolution.provider === input.client,
      `snapshotProvider=${state.snapshot.skillResolution.provider}`,
    );
    let baselineValid = false;
    try {
      const tree = (await git(runtime, input.repo, "rev-parse", `${metadata.baselineCommit}^{tree}`)).stdout.trim();
      await git(runtime, state.worktree, "merge-base", "--is-ancestor", metadata.baselineCommit, "HEAD");
      baselineValid = tree === metadata.baselineTree;
    } catch {}
    check("fixture.baseline", baselineValid, "baseline commit/tree 必须存在且为 Work Item HEAD ancestor");
    let driverValid = false;
    try {
      driverValid = await sha256File(path.join(input.repo, metadata.driver)) === metadata.driverDigest;
    } catch {}
    check("fixture.driver", driverValid, "Driver 安装目标必须匹配 signed digest");
    let wsspeckitValid = false;
    try {
      wsspeckitValid = (await git(runtime, sourceRoot, "rev-parse", "HEAD")).stdout.trim() === metadata.wsspeckitCommit;
    } catch {}
    check("fixture.wsspeckit", wsspeckitValid, "verifier checkout 必须匹配 signed WSSpecKit commit");

    const acquired = events.filter(({ eventType }) => eventType === "attempt.acquired" || eventType === "attempt.reacquired").length;
    const submitted = events.filter(({ idempotencyKey }) => typeof idempotencyKey === "string" && idempotencyKey.startsWith("submit:")).length;
    check("protocol.acquire-submit", acquired >= 1 && submitted >= 1, `acquire=${acquired}, submit=${submitted}`);

    const references = artifactReferences(state.projection);
    const taskReference = references.find(({ artifactType }) => artifactType === "tasks");
    let compactPlan = false;
    if (taskReference !== undefined) {
      try {
        const artifact = await checkedArtifact(state.worktree, taskReference);
        const value = record(structuredYaml(artifact.body, "任务"));
        compactPlan = artifact.metadata.stageId === "plan"
          && Array.isArray(value?.tasks) && value.tasks.length > 0 && value.tasks.length <= 3;
      } catch {}
    }
    check("artifact.compact-plan", compactPlan, taskReference === undefined ? "缺少 tasks Artifact" : "计划必须包含 1-3 个任务");

    const trusted = [];
    for (const value of Object.values(state.projection.evidence)) {
      const candidate = record(value);
      if (candidate?.level !== "trusted" || !["red", "green"].includes(candidate.phase)) continue;
      try { trusted.push(parseTrustedEvidence(candidate)); } catch {}
    }
    const cycle = parseTddCycleEvidence(state.projection.evidence[`tdd:${state.projection.workItemId}:cycle`]);
    const red = cycle === undefined ? undefined : trusted.find(({ phase, evidenceId, commandId, taskId }) => (
      phase === "red" && evidenceId === cycle.redEvidenceId && commandId === cycle.commandId && taskId === cycle.taskId
    ));
    const green = cycle === undefined ? undefined : trusted.find(({ phase, evidenceId, commandId, taskId }) => (
      phase === "green" && evidenceId === cycle.greenEvidenceId && commandId === cycle.commandId && taskId === cycle.taskId
    ));
    check(
      "tdd.trusted-red-green",
      red !== undefined && green !== undefined && red.exitCode !== 0 && green.exitCode === 0,
      red === undefined || green === undefined ? "缺少同 commandId 的可信 Red/Green" : `commandId=${red.commandId}`,
    );

    const reviewContext = Object.entries(state.projection.contexts).find(([id, context]) => (
      /^review-fix:\d+:review$/u.test(id) && record(context)?.result !== undefined
    ));
    const reviewReference = references.find(({ artifactType }) => artifactType === "review-result");
    let approvedReview = false;
    if (state.projection.stages["review-fix"]?.status === "succeeded" && reviewContext !== undefined && reviewReference !== undefined) {
      try {
        const artifact = await checkedArtifact(state.worktree, reviewReference);
        const value = record(structuredYaml(artifact.body, "Findings"));
        approvedReview = artifact.metadata.stageId === reviewContext[0]
          && Array.isArray(value?.findings) && value.findings.every((finding) => {
          const disposition = record(finding)?.disposition;
          return disposition !== "open";
        });
      } catch {}
    }
    check("workflow.review", approvedReview, approvedReview ? "Review 已完成" : "缺少已通过的 Review Artifact");

    const issueBinding = state.item.bindings.issue !== null || Object.entries(state.projection.evidence).some(([key, value]) => {
      if (key === "external-binding:issue") return true;
      const candidate = record(value);
      return record(candidate?.issue)?.exists === true;
    });
    const issueClose = Object.values(state.projection.externalActions).some((action) => action.request.action === "issue.close" && action.status === "verified");
    check("workflow.external-close", !issueBinding || issueClose, issueBinding ? "Issue Binding 必须有 verified close" : "无 Issue Binding，按合同跳过");

    const closedEvent = events.some(({ eventType }) => eventType === "work-item.closed");
    check("workflow.close", state.projection.workItem.status === "closed" && closedEvent, `status=${state.projection.workItem.status}`);

    let changed = [];
    let verifiedCommit = false;
    try {
      const gitAction = Object.values(state.projection.externalActions).find((action) => action.request.action === "git.commit" && action.status === "verified");
      const receipt = record(gitAction?.receipt);
      const head = (await git(runtime, state.worktree, "rev-parse", "HEAD")).stdout.trim();
      const ancestry = (await git(runtime, state.worktree, "rev-list", "--parents", "-n", "1", head)).stdout.trim().split(/\s+/u);
      changed = (await git(runtime, state.worktree, "diff", "--name-only", `${metadata.baselineCommit}..${head}`, "--")).stdout.trim().split("\n").filter(Boolean).sort();
      const diff = (await git(runtime, state.worktree,
        "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames",
        "--src-prefix=a/", "--dst-prefix=b/", metadata.baselineCommit, head, "--")).stdout;
      await git(runtime, state.worktree, "diff", "--check", metadata.baselineCommit, head, "--");
      verifiedCommit = ancestry.length === 2 && ancestry[0] === head && ancestry[1] === metadata.baselineCommit
        && receipt?.expectedContentDigest === sha256(diff)
        && receipt.readBackContentDigest === receipt.expectedContentDigest;
    } catch {}
    check("git.expected-diff", verifiedCommit && changed.join("\n") === "src/labels.ts\ntests/labels.test.ts", `changed=${changed.join(",")}`);
    try {
      check("smoke.behavior-probe", true, await behaviorProbe(state, runtime));
    } catch (error) {
      check("smoke.behavior-probe", false, error instanceof Error ? error.message : "行为探针失败");
    }
  } else {
    for (const id of ["fixture.workflow", "fixture.provider", "fixture.baseline", "fixture.driver", "fixture.wsspeckit", "protocol.acquire-submit", "artifact.compact-plan", "tdd.trusted-red-green", "workflow.review", "workflow.external-close", "workflow.close", "git.expected-diff", "smoke.behavior-probe"]) {
      check(id, false, "控制面不可验证");
    }
  }
  const summary = { version: 1, ok: checks.every(({ ok }) => ok), client: input.client, workItemId, checks };
  const references = state === undefined ? [] : artifactReferences(state.projection);
  const evidence = state === undefined ? [] : Object.values(state.projection.evidence);
  const failed = checks.filter(({ ok }) => !ok).map(({ id }) => id);
  const updatedRunManifest = {
    ...runManifest,
    updatedAt: new Date().toISOString(),
    invocations: [...runManifest.invocations, {
      sequence: runManifest.invocations.length + 1,
      operation: "verifier",
      exitCode: summary.ok ? 0 : 1,
      timestamp: new Date().toISOString(),
      environmentKeys: cleanEnvironmentKeys,
    }],
    verifier: Object.fromEntries(checks.map(({ id, ok }) => [id, ok])),
    verifierDigest: sha256(checks),
    eventDigest: sha256(events),
    eventReferences: events.map(({ sequence, eventType, eventId, eventHash }) => ({
      sequence,
      eventType,
      eventIdHash: sha256(eventId),
      eventHash,
    })),
    artifactDigests: references.map(({ contentHash }) => contentHash).filter((value) => typeof value === "string").sort(),
    evidenceDigests: evidence.map((value) => sha256(value)).sort(),
    status: summary.ok ? "pass" : "no-go",
    hostPhaseEvidenceStatus: summary.ok ? "verified" : "no-go",
    reason: summary.ok ? "verified" : failed.join(","),
  };
  await writeSignedJson(
    path.join(input.repo, ".acceptance", "agent-smoke-run.json"),
    path.join(input.repo, ".acceptance", "agent-smoke-run-receipt.json"),
    "wsspeckit-agent-smoke-run-receipt",
    updatedRunManifest,
    authority,
    input.authorityIdentity,
  );
  return summary;
}

async function main() {
  const summary = await verifySmoke(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const summary = { version: 1, ok: false, client: "unknown", workItemId: "unknown", checks: [{ id: "verifier.error", ok: false, detail: error instanceof Error ? error.message : String(error) }] };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  });
}
