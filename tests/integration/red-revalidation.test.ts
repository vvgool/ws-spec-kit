import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { computeWorkspaceTreeDigest } from "../../src/domain/digests.js";
import { recordRedEvidence, evidenceId, parseTrustedEvidence, commandMismatchMessage, fixedGateCommandIdentity } from "../../src/engine/tdd/red-gate.js";
import { fixedTestGateFromConfig, tddRedEvidenceKey } from "../../src/engine/verification.js";
import { defaultProjectConfig } from "../../src/storage/repository.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { loadApplicationState } from "../../src/application/state.js";
import { runCommand } from "../../src/cli/commands/core.js";
import { git } from "./helpers/git.js";
import { controlRuntimeFixture, requireExecute, rewriteSelectedSnapshot, worktreeFor, completedResult, submitPackage } from "./helpers/control-runtime.js";
import { withRedBaseline } from "../../src/application/red-baseline.js";
import type { TrustedEvidence } from "../../src/engine/tdd/types.js";

async function fixture(legacy = false, greenAfterEnvironmentChange = false) {
  const current = await controlRuntimeFixture();
  const config = defaultProjectConfig() as any;
  config.quality.gates.test.command = [process.execPath, "--test", "tests/feature.test.mjs"];
  config.quality.gates.test.inheritEnv = ["WSPEC_RECOVERY_TEST_ENV"];
  config.testing.testAssetPaths = ["tests/**"];
  const gate = fixedTestGateFromConfig(config);
  await writeFile(path.join(current.root, ".wsspec/config.yaml"), stringify(config));
  await mkdir(path.join(current.root, "tests"));
  await mkdir(path.join(current.root, "src"));
  const source = `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('expected feature',()=>assert.equal(${greenAfterEnvironmentChange ? "process.env.WSPEC_RECOVERY_TEST_ENV" : "readFileSync('src/value.txt','utf8')"},'green'));`;
  await writeFile(path.join(current.root, "tests/feature.test.mjs"), source);
  await writeFile(path.join(current.root, "src/value.txt"), "red");
  await git(current.root, "add", "."); await git(current.root, "commit", "-m", "seed red recovery");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "recover environment" }, profile: "standard" });
  await rewriteSelectedSnapshot(current, started.workItemId, profile => { profile.steps.find(s => s.id === "implement")!.inputs = []; });
  const state = await loadApplicationState(current.root, started.workItemId);
  const tree = await worktreeFor(current.root, started.workItemId);
  let red = await recordRedEvidence({ taskId: started.workItemId, gate, worktree: tree, workspaceDigest: await computeWorkspaceTreeDigest(tree), testPaths: ["tests/feature.test.mjs"], modifiedFiles: ["tests/feature.test.mjs"], step: { id: "verify-red", uses: "command.execute", action: "quality.test", expectedOutcome: "test-failure" } });
  if (legacy) { const { evidenceId: _id, commandFingerprint: _fp, ...unsigned } = red; red = { ...unsigned, evidenceId: evidenceId(unsigned) }; }
  const order = state.snapshot.profiles[state.projection.profile.selected].order;
  const index = order.indexOf("implement");
  await mutateControlPlane({ cwd: current.root, workItemId: started.workItemId, eventType: "evidence.recorded", idempotencyKey: "test:red", operationInput: {}, mutate: projection => ({ projection: { ...projection, claims: {}, contexts: {}, approvals: {}, stages: Object.fromEntries(order.map((id, i) => [id, { status: i < index ? "succeeded" : i === index ? "ready" : "pending" }])), evidence: { ...projection.evidence, [tddRedEvidenceKey(started.workItemId)]: red } }, value: null }) });
  const first = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "agent" }));
  const original = (await readControlPlane(current.root, started.workItemId)).claims.implement!;
  await writeFile(path.join(tree, "src/value.txt"), "green");
  const args = ["revalidate-red", started.workItemId, "--expected-evidence", red.evidenceId, "--actor", "operator", "--reason", "environment repaired"];
  return { current, started, tree, red, gate, args, first, original, source };
}

test("legacy Red is revalidated on isolated baseline while implementation and submission baseline survive", async () => {
  const previous = process.env.WSPEC_RECOVERY_TEST_ENV;
  try {
    process.env.WSPEC_RECOVERY_TEST_ENV = "red";
    const f = await fixture(true);
    process.env.WSPEC_RECOVERY_TEST_ENV = "green";
    const before = await computeWorkspaceTreeDigest(f.tree);
    await assert.rejects(runCommand(f.current.root, f.args.map(s => s === f.red.evidenceId ? "stale" : s)), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
    await writeFile(path.join(f.tree, "tests/feature.test.mjs"), f.source + "\n// changed");
    await assert.rejects(runCommand(f.current.root, f.args), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
    await writeFile(path.join(f.tree, "tests/feature.test.mjs"), f.source);
    const result = await runCommand(f.current.root, f.args) as { redEvidenceId: string };
    assert.notEqual(result.redEvidenceId, f.red.evidenceId);
    assert.deepEqual(await runCommand(f.current.root, f.args), result);
    assert.equal(await computeWorkspaceTreeDigest(f.tree), before);
    assert.equal(await readFile(path.join(f.tree, "src/value.txt"), "utf8"), "green");
    const recovered = await recoverControlPlane({ cwd: f.current.root, workItemId: f.started.workItemId });
    const red = recovered.evidence[tddRedEvidenceKey(f.started.workItemId)] as TrustedEvidence;
    assert.ok(parseTrustedEvidence(red)); assert.ok(red.commandFingerprint);
    assert.ok(recovered.evidence[`testing.red-revalidation:${f.red.evidenceId}`]);
    const next = requireExecute(await f.current.app.acquire({ root: f.current.root, workItemId: f.started.workItemId, actor: "agent" }));
    const claim = (await readControlPlane(f.current.root, f.started.workItemId)).claims.implement!;
    assert.deepEqual(claim.workspaceSnapshot, f.original.workspaceSnapshot);
    await assert.rejects(submitPackage(f.current, next, completedResult(next, [])), { code: "WSSPEC_MODIFIED_FILES_MISMATCH" });
  } finally { if (previous === undefined) delete process.env.WSPEC_RECOVERY_TEST_ENV; else process.env.WSPEC_RECOVERY_TEST_ENV = previous; }
});

test("environment making the old baseline Green cannot renew Red; diagnostics identify environment without leaking values", async () => {
  const previous = process.env.WSPEC_RECOVERY_TEST_ENV;
  try {
    process.env.WSPEC_RECOVERY_TEST_ENV = "red";
    const f = await fixture(false, true);
    process.env.WSPEC_RECOVERY_TEST_ENV = "green";
    const identity = await fixedGateCommandIdentity(f.gate, f.tree);
    const message = commandMismatchMessage(f.red, identity.commandFingerprint);
    assert.match(message, /执行环境/u); assert.doesNotMatch(message, /green|WSPEC_RECOVERY_TEST_ENV/u);
    const before = (await readControlPlane(f.current.root, f.started.workItemId)).lastEventHash;
    await assert.rejects(runCommand(f.current.root, f.args), { code: "WSSPEC_TDD_RED_NOT_OBSERVED" });
    assert.equal((await readControlPlane(f.current.root, f.started.workItemId)).lastEventHash, before);
    assert.equal(await readFile(path.join(f.tree, "src/value.txt"), "utf8"), "green");
  } finally { if (previous === undefined) delete process.env.WSPEC_RECOVERY_TEST_ENV; else process.env.WSPEC_RECOVERY_TEST_ENV = previous; }
});


test("isolated baseline rebases pnpm and workspace links without sharing mutable dependency bytes", async () => {
  const f = await fixture();
  const packageRoot = path.join(f.tree, "node_modules/.pnpm/demo/node_modules/demo");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "value.txt"), "dependency");
  await symlink(".pnpm/demo/node_modules/demo", path.join(f.tree, "node_modules/demo"));
  await symlink(path.join(f.tree, "src"), path.join(f.tree, "node_modules/workspace-source"));
  const state = await loadApplicationState(f.current.root, f.started.workItemId);
  await withRedBaseline({ worktree: f.tree, revision: state.item.execution.baselineRevision,
    snapshot: f.original.workspaceSnapshot, digest: f.red.workspaceDigest }, async directory => {
    assert.equal(await realpath(path.join(directory, "node_modules/workspace-source")), path.join(directory, "src"));
    assert.equal(await readFile(path.join(directory, "node_modules/workspace-source/value.txt"), "utf8"), "red");
    await writeFile(path.join(directory, "node_modules/demo/value.txt"), "isolated mutation");
    assert.equal(await readFile(path.join(packageRoot, "value.txt"), "utf8"), "dependency");
  });
  await symlink("/", path.join(f.tree, "node_modules/outside"));
  await assert.rejects(withRedBaseline({ worktree: f.tree, revision: state.item.execution.baselineRevision,
    snapshot: f.original.workspaceSnapshot, digest: f.red.workspaceDigest }, async () => assert.fail("escaped isolation")),
    { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
});

test("live implementation claims and later evidence cannot be replaced by Red recovery", async () => {
  const f = await fixture();
  await mutateControlPlane({ cwd: f.current.root, workItemId: f.started.workItemId, eventType: "evidence.recorded",
    idempotencyKey: "test:live-claim", operationInput: {}, mutate: projection => ({ projection: { ...projection,
      claims: { ...projection.claims, implement: { ...f.original, expiresAt: new Date(Date.now() + 60_000).toISOString() } } }, value: null }) });
  await assert.rejects(runCommand(f.current.root, f.args), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
  await mutateControlPlane({ cwd: f.current.root, workItemId: f.started.workItemId, eventType: "evidence.recorded",
    idempotencyKey: "test:later-evidence", operationInput: {}, mutate: projection => ({ projection: { ...projection,
      claims: {}, evidence: { ...projection.evidence, [`tdd:${f.started.workItemId}:green`]: {} } }, value: null }) });
  const before = (await readControlPlane(f.current.root, f.started.workItemId)).lastEventHash;
  await assert.rejects(runCommand(f.current.root, f.args), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
  assert.equal((await readControlPlane(f.current.root, f.started.workItemId)).lastEventHash, before);
});

test("missing historical bytes fail before any isolated command runs", async () => {
  const f = await fixture();
  const state = await loadApplicationState(f.current.root, f.started.workItemId);
  const snapshot = f.original.workspaceSnapshot.map(entry => entry.path === "src/value.txt"
    ? { ...entry, digest: "sha256:" + "0".repeat(64) } : entry);
  await assert.rejects(withRedBaseline({ worktree: f.tree, revision: state.item.execution.baselineRevision,
    snapshot, digest: f.red.workspaceDigest }, async () => assert.fail("unverified bytes executed")),
    /原 Red 文件无法按摘要重建/u);
  assert.equal(await readFile(path.join(f.tree, "src/value.txt"), "utf8"), "green");
});

test("recover selects environment revalidation and returns an actionable inspect view", async () => {
  const previous = process.env.WSPEC_RECOVERY_TEST_ENV;
  try {
    process.env.WSPEC_RECOVERY_TEST_ENV = "red";
    const f = await fixture(true);
    process.env.WSPEC_RECOVERY_TEST_ENV = "green";
    const { inspectApplication } = await import("../../src/application/inspect.js");
    const input = { root: f.current.root, workItemId: f.started.workItemId };
    const view = await inspectApplication(input);
    assert.equal(view.currentStep, "implement");
    assert.equal(view.nextAction.kind, "revalidate-red");
    assert.equal(view.retry?.attemptsUsed, 0);
    assert.equal(view.retry?.interruptions, 1);
    const args = ["recover", f.started.workItemId, "--actor", "operator", "--reason", "environment repaired"];
    const recovered = await runCommand(f.current.root, args) as typeof view;
    assert.equal(recovered.nextAction.kind, "acquire");
    assert.notEqual(recovered.redEvidenceId, view.redEvidenceId);
    assert.equal(await readFile(path.join(f.tree, "src/value.txt"), "utf8"), "green");
    assert.deepEqual(await runCommand(f.current.root, args), recovered);
  } finally { if (previous === undefined) delete process.env.WSPEC_RECOVERY_TEST_ENV; else process.env.WSPEC_RECOVERY_TEST_ENV = previous; }
});

test("recover reports exhausted budgets without resetting them", async () => {
  const f = await fixture();
  await mutateControlPlane({ cwd: f.current.root, workItemId: f.started.workItemId, eventType: "evidence.recorded",
    idempotencyKey: "test:exhausted", operationInput: {}, mutate: projection => ({ projection: { ...projection,
      claims: {}, stages: { ...projection.stages, implement: { status: "failed" } },
      retries: { ...projection.retries, implement: { stepInstanceId: "implement", attemptsUsed: 4, maxAttempts: 4, status: "exhausted" } } }, value: null }) });
  const result = await runCommand(f.current.root, ["recover", f.started.workItemId, "--actor", "operator", "--reason", "resume"]) as { nextAction: { kind: string }; retry: { attemptsRemaining: number } };
  assert.equal(result.nextAction.kind, "blocked");
  assert.equal(result.retry.attemptsRemaining, 0);
  assert.equal((await readControlPlane(f.current.root, f.started.workItemId)).retries.implement!.attemptsUsed, 4);
});

test("recovery guidance respects paused and completed tasks and retryable failures", async () => {
  const f = await fixture();
  const { recoveryGuidance } = await import("../../src/application/recovery-guidance.js");
  const state = await loadApplicationState(f.current.root, f.started.workItemId);
  for (const status of ["paused", "blocked", "cancelled", "closed"] as const) {
    const view = await recoveryGuidance({ ...state, projection: { ...state.projection, workItem: { status } } });
    assert.equal(view.nextAction.kind, status === "cancelled" || status === "closed" ? "completed" : "blocked");
  }
  const view = await recoveryGuidance({ ...state, projection: { ...state.projection, claims: {},
    stages: { ...state.projection.stages, implement: { status: "failed" } },
    retries: { ...state.projection.retries, implement: { stepInstanceId: "implement", attemptsUsed: 1, maxAttempts: 2, status: "ready" } } } });
  assert.equal(view.nextAction.kind, "acquire");
  assert.equal(view.retry?.attemptsRemaining, 1);
});
