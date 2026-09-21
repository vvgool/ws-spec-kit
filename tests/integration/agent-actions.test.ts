import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAgentActions } from "../../src/application/agent-actions.js";
import { loadApplicationState } from "../../src/application/state.js";
import { readEvents } from "../../src/storage/events.js";
import { controlRuntimeFixture, requireExecute } from "./helpers/control-runtime.js";

async function fixture() {
  let now = new Date();
  const runtime = await controlRuntimeFixture({ now: () => now });
  const actions = createAgentActions({ provider: "codex", now: runtime.now });
  const started = await runtime.app.start({ root: runtime.root, source: { type: "prompt", text: "高层操作验收" }, profile: "quick" });
  const input = { root: runtime.root, workItemId: started.workItemId, actor: "codex" };
  const first = await actions.continue(input);
  assert.ok(first.action !== "guidance");
  const workPackage = requireExecute(first);
  const result = { version: 1 as const, status: "completed" as const, summary: "完成", modifiedFiles: [], commands: [], evidence: [], externalWrites: [], remainingRisks: [] };
  return { runtime, actions, input, workPackage, result, expire: () => { now = new Date(now.getTime() + 86_400_000); } };
}

test("continue returns the same active grant without rotating its lease", async () => {
  const f = await fixture();
  const before = await loadApplicationState(f.input.root, f.input.workItemId);
  const action = await f.actions.continue(f.input);
  assert.equal(action.action, "execute");
  if (action.action === "execute") assert.deepEqual(action.workPackage, f.workPackage);
  const after = await loadApplicationState(f.input.root, f.input.workItemId);
  assert.equal(after.projection.lastSequence, before.projection.lastSequence);
});

test("continue rejects other actors and expired claims without spending retry budget", async () => {
  const f = await fixture();
  await assert.rejects(f.actions.continue({ ...f.input, actor: "other" }), { code: "WSSPEC_STAGE_ALREADY_CLAIMED" });
  const before = await loadApplicationState(f.input.root, f.input.workItemId);
  f.expire();
  await assert.rejects(f.actions.continue(f.input), { code: "WSSPEC_ATTEMPT_NOT_ACTIVE" });
  const after = await loadApplicationState(f.input.root, f.input.workItemId);
  assert.deepEqual(after.projection.retries, before.projection.retries);
});

test("complete reuses required input artifacts and replays identical submissions", async () => {
  const f = await fixture();
  const request = { ...f.input, workPackage: f.workPackage, outputs: [], result: f.result };
  const next = await f.actions.complete(request);
  assert.equal(next.action, "execute");
  assert.deepEqual(await f.actions.complete(request), next);
  await assert.rejects(f.actions.complete({ ...request, result: { ...f.result, summary: "不同提交" } }), { code: "WSSPEC_IDEMPOTENCY_CONFLICT" });
});

test("complete authors output files, replays them and rejects modified retry content", async () => {
  const f = await fixture();
  const explore = requireExecute(await f.actions.complete({ ...f.input, workPackage: f.workPackage, outputs: [], result: f.result }));
  const state = await loadApplicationState(f.input.root, f.input.workItemId);
  const draftRoot = explore.artifactAuthoring!.draftRoots.find(root => root !== ".acceptance")!;
  await mkdir(path.join(state.worktree, draftRoot), { recursive: true });
  const outputs = explore.requiredOutputs.map((output, i) => ({ outputId: output.outputId!, contentFile: `${draftRoot}/output-${i}.md` }));
  for (const output of outputs) await writeFile(path.join(state.worktree, output.contentFile), "# 调研\n\n范围与验证结果。\n");
  const request = { ...f.input, workPackage: explore, outputs, result: f.result };
  await assert.rejects(f.actions.complete({ ...request, result: { ...f.result, modifiedFiles: ["not-an-actual-change.ts"] } }), { code: "WSSPEC_MODIFIED_FILES_MISMATCH" });
  const next = await f.actions.complete(request);
  assert.deepEqual(await f.actions.complete(request), next);
  const events = await readEvents((await loadApplicationState(f.input.root, f.input.workItemId)).projection.controlPlane);
  assert.equal(events.filter(event => event.eventType === "artifact.authored" && event.attemptId === explore.attemptId).length, outputs.length);
  await writeFile(path.join(state.worktree, outputs[0]!.contentFile), "修改后的内容");
  await assert.rejects(f.actions.complete(request), { code: "WSSPEC_ARTIFACT_CONFLICT" });
});

test("complete rejects foreign actors, cross-task, modified and expired grants", async () => {
  const f = await fixture();
  const request = { ...f.input, workPackage: f.workPackage, outputs: [], result: f.result };
  await assert.rejects(f.actions.complete({ ...request, actor: "other" }), { code: "WSSPEC_STAGE_ALREADY_CLAIMED" });
  await assert.rejects(f.actions.complete({ ...request, workItemId: "WSS-other" }), { code: "WSSPEC_ATTEMPT_NOT_ACTIVE" });
  await assert.rejects(f.actions.complete({ ...request, workPackage: { ...f.workPackage, objective: "扩大任务" } }), { code: "WSSPEC_ACTIVE_CLAIM_INVALID" });
  f.expire();
  await assert.rejects(f.actions.complete(request), { code: "WSSPEC_ATTEMPT_NOT_ACTIVE" });
});

test("continue does not let inspect recover a wall-clock expired grant implicitly", async () => {
  const runtime = await controlRuntimeFixture({ now: () => new Date("2020-01-01T00:00:00Z") });
  const started = await runtime.app.start({ root: runtime.root, source: { type: "prompt", text: "过期租约" }, profile: "quick" });
  const input = { root: runtime.root, workItemId: started.workItemId, actor: "codex" };
  await runtime.app.acquire(input);
  const before = await loadApplicationState(input.root, input.workItemId);
  const actions = createAgentActions({ provider: "codex" });
  await assert.rejects(actions.continue(input), { code: "WSSPEC_ATTEMPT_NOT_ACTIVE" });
  const after = await loadApplicationState(input.root, input.workItemId);
  assert.equal(after.projection.lastSequence, before.projection.lastSequence);
  assert.deepEqual(after.projection.claims, before.projection.claims);
});

test("complete executes engine-owned Red and Green gates without authored evidence", async () => {
  const { git } = await import("./helpers/git.js");
  const { retainOnlyReadyStage, worktreeFor } = await import("./helpers/control-runtime.js");
  const { mutateControlPlane } = await import("../../src/engine/scheduler.js");
  const { tddRedEvidenceKey } = await import("../../src/engine/verification.js");
  const runtime = await controlRuntimeFixture({ now: () => new Date() });
  await mkdir(path.join(runtime.root, "tests"), { recursive: true });
  await mkdir(path.join(runtime.root, "src"), { recursive: true });
  await writeFile(path.join(runtime.root, "src/feature.mjs"), "export const value = 0;\n");
  await writeFile(path.join(runtime.root, "tests/feature.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('feature', () => assert.match(readFileSync('src/feature.mjs', 'utf8'), /value = 1/));\n");
  await writeFile(path.join(runtime.root, ".wsspec/config.yaml"), JSON.stringify({ version: 1,
    testing: { pathRules: ["node"], testAssetPaths: ["tests/**"], productPaths: ["src/**"] },
    quality: { gates: { test: { command: [process.execPath, "--test", "tests/feature.test.mjs"], cwd: "worktree", timeoutSeconds: 5, required: true, evidence: "trusted", inheritEnv: [], env: {}, reporter: { type: "node-test", version: 1 } } } } }));
  await git(runtime.root, "add", ".");
  await git(runtime.root, "commit", "-m", "seed real gates");
  const started = await runtime.app.start({ root: runtime.root, source: { type: "prompt", text: "真实门禁" }, profile: "quick" });
  await retainOnlyReadyStage(runtime, started.workItemId, "verify-red");
  await mutateControlPlane({ cwd: runtime.root, workItemId: started.workItemId, eventType: "projection.invalidated", idempotencyKey: "test:engine-context", operationInput: {}, mutate: projection => ({ projection: { ...projection, contexts: { ...projection.contexts, "write-tests": { result: { modifiedFiles: ["tests/feature.test.mjs"] } } } }, value: null }) });
  const actions = createAgentActions({ provider: "codex", now: runtime.now });
  const input = { root: runtime.root, workItemId: started.workItemId, actor: "codex" };
  const red = requireExecute(await runtime.app.acquire(input));
  const result = { version: 1 as const, status: "completed" as const, summary: "执行真实门禁", modifiedFiles: [], commands: [], evidence: [], externalWrites: [], remainingRisks: [] };
  const redRequest = { ...input, workPackage: red, outputs: [], result };
  const redNext = await actions.complete(redRequest);
  assert.deepEqual(await actions.complete(redRequest), redNext);
  let state = await loadApplicationState(input.root, input.workItemId);
  const evidence = state.projection.evidence[tddRedEvidenceKey(started.workItemId)] as { level: string; exitCode: number };
  assert.equal(evidence.level, "trusted");
  assert.equal(evidence.exitCode, 1);
  await writeFile(path.join(await worktreeFor(runtime.root, started.workItemId), "src/feature.mjs"), "export const value = 1;\n");
  await retainOnlyReadyStage(runtime, started.workItemId, "verify-green");
  const green = requireExecute(await runtime.app.acquire(input));
  await assert.rejects(actions.complete({ ...input, workPackage: green, outputs: [{ outputId: "tdd-evidence", contentFile: "untrusted.md" }], result }), { code: "WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED" });
  const greenRequest = { ...input, workPackage: green, outputs: [], result };
  const next = await actions.complete(greenRequest);
  assert.deepEqual(await actions.complete(greenRequest), next);
  state = await loadApplicationState(input.root, input.workItemId);
  assert.equal(state.projection.stages["verify-green"]?.status, "succeeded");
  assert.equal((state.projection.contexts["verify-green"] as { result: { artifacts: unknown[] } }).result.artifacts.length, 0);
});

test("complete replay reads an original read-only draft after materialization", async () => {
  const { materializeWorkItem } = await import("../../src/storage/work-items.js");
  const f = await fixture();
  const explore = requireExecute(await f.actions.complete({ ...f.input, workPackage: f.workPackage, outputs: [], result: f.result }));
  assert.equal(explore.workspace.materialized, false);
  const state = await loadApplicationState(f.input.root, f.input.workItemId);
  const draftRoot = explore.artifactAuthoring!.draftRoots.find(root => root !== ".acceptance")!;
  await mkdir(path.join(state.worktree, draftRoot), { recursive: true });
  const outputs = explore.requiredOutputs.map((output, i) => ({ outputId: output.outputId!, contentFile: `${draftRoot}/replay-${i}.md` }));
  for (const output of outputs) await writeFile(path.join(state.worktree, output.contentFile), "# 原调研\n");
  const request = { ...f.input, workPackage: explore, outputs, result: f.result };
  const next = await f.actions.complete(request);
  await materializeWorkItem({ root: f.input.root, item: (await loadApplicationState(f.input.root, f.input.workItemId)).item });
  assert.deepEqual(await f.actions.complete(request), next);
});
