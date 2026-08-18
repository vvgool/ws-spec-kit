import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import {
  controlRuntimeFixture,
  failedResult,
  requireExecute,
  retainOnlyReadyStage,
  rewriteSelectedSnapshot,
  submitPackage,
} from "./helpers/control-runtime.js";

test("Agent 伪造永久 failureCode 会被拒绝且默认 Executor 仍按暂时失败重试", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证失败分类信任边界" }, profile: "quick" });
  const first = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  const forged = { ...failedResult(first), failureCode: "WSSPEC_STEP_INPUT_INVALID" };

  await assert.rejects(
    submitPackage(fixture, first, forged as never),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SCHEMA_UNKNOWN_FIELD",
  );

  const blocked = await submitPackage(fixture, first, failedResult(first));
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") throw new Error("expected blocked action");
  assert.equal(blocked.problems[0]?.code, "WSSPEC_STEP_FAILED");
  assert.equal(blocked.problems[0]?.retryable, true);
});

test("重试投影不会把原型属性当成已有 Step 实例", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证原型命名 Step" }, profile: "quick" });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const intake = profile.steps.find(({ id }) => id === "intake");
    assert.ok(intake);
    intake.id = "constructor";
    intake.needs = [];
    profile.steps = [intake];
    profile.order = ["constructor"];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, "constructor");

  const first = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  assert.equal(first.stepId, "constructor");
});

test("非重试失败由 Executor 校验后立即稳定阻塞且不消耗重试预算", async () => {
  const fixture = await controlRuntimeFixture({ validatedFailureCode: "WSSPEC_STEP_INPUT_INVALID" });
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证稳定失败分类" }, profile: "quick" });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const intake = profile.steps.find(({ id }) => id === "intake");
    assert.ok(intake);
    intake.uses = "command.execute";
    intake.action = "quality.verify";
    intake.securityClass = "local-write";
    intake.retry = { maxAttempts: 3 };
  });

  const first = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex-a" }));
  const blocked = await submitPackage(fixture, first, failedResult(first));
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") throw new Error("expected blocked action");
  assert.deepEqual(blocked.problems[0], {
    code: "WSSPEC_STEP_INPUT_INVALID",
    message: "intake 执行失败",
    retryable: false,
  });

  const projection = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(projection.retries.intake, undefined);
  fixture.restart();
  const stillBlocked = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex-b" });
  assert.deepEqual(stillBlocked, blocked);
});

test("retry.maxAttempts 持久计数，恢复不重置预算且穷尽错误稳定不可重试", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证持久重试预算" }, profile: "quick" });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const intake = profile.steps.find(({ id }) => id === "intake");
    assert.ok(intake);
    intake.retry = { maxAttempts: 2 };
  });

  const first = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex-a" }));
  assert.deepEqual((await readControlPlane(fixture.root, started.workItemId)).retries.intake, {
    stepInstanceId: "intake",
    attemptsUsed: 1,
    maxAttempts: 2,
    status: "running",
  });

  const failed = await submitPackage(fixture, first, failedResult(first));
  assert.equal(failed.action, "blocked");
  if (failed.action !== "blocked") throw new Error("expected blocked action");
  assert.deepEqual(failed.problems[0], {
    code: "WSSPEC_STEP_FAILED",
    message: "intake 执行失败",
    retryable: true,
  });

  const durable = await readControlPlane(fixture.root, started.workItemId);
  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.deepEqual(recovered.retries.intake, {
    stepInstanceId: "intake",
    attemptsUsed: 1,
    maxAttempts: 2,
    status: "ready",
  });

  fixture.restart();
  const second = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex-b" }));
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal((await readControlPlane(fixture.root, started.workItemId)).retries.intake?.attemptsUsed, 2);

  const exhausted = await submitPackage(fixture, second, failedResult(second));
  assert.equal(exhausted.action, "blocked");
  if (exhausted.action !== "blocked") throw new Error("expected blocked action");
  assert.deepEqual(exhausted.problems[0], {
    code: "WSSPEC_STEP_RETRY_EXHAUSTED",
    message: "步骤 intake 已耗尽重试次数。",
    retryable: false,
  });

  fixture.restart();
  const stillExhausted = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex-c" });
  assert.equal(stillExhausted.action, "blocked");
  if (stillExhausted.action !== "blocked") throw new Error("expected blocked action");
  assert.equal(stillExhausted.problems[0]?.code, "WSSPEC_STEP_RETRY_EXHAUSTED");
  assert.equal(stillExhausted.problems[0]?.retryable, false);
});
