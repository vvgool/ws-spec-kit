import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { readEvents } from "../../src/storage/events.js";
import {
  completedResult,
  controlRuntimeFixture,
  requireExecute,
  retainOnlyReadyStage,
  rewriteSelectedSnapshot,
  submitPackage,
  worktreeFor,
  writeReviewArtifact,
} from "./helpers/control-runtime.js";

async function prepareLoop(profile: "quick" | "standard") {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证 Review-Fix 循环" }, profile });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  return { fixture, started, worktree: await worktreeFor(fixture.root, started.workItemId) };
}

test("循环投影不会把原型属性当成已有 Loop 实例", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证原型命名 Loop" }, profile: "standard" });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const loop = profile.steps.find(({ id }) => id === "review-fix");
    assert.ok(loop);
    loop.id = "constructor";
    loop.needs = [];
    profile.steps = [loop];
    profile.order = ["constructor"];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, "constructor");

  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  assert.equal(review.stepId, "constructor:1:review");
});

test("循环内部 Step 仅在 needs 成功或跳过后可调度", async () => {
  const { fixture, started } = await prepareLoop("standard");
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const loop = profile.steps.find(({ id }) => id === "review-fix");
    assert.ok(loop);
    const children = loop.steps as Array<Record<string, unknown>>;
    const verify = children.find(({ id }) => id === "verify");
    const review = children.find(({ id }) => id === "review");
    const fix = children.find(({ id }) => id === "fix");
    assert.ok(verify && review && fix);
    verify.needs = ["review"];
    loop.steps = [verify, review, fix];
  });

  const first = requireExecute(await fixture.app.acquire({
    root: fixture.root,
    workItemId: started.workItemId,
    actor: "reviewer",
  }));
  assert.equal(first.stepId, "review-fix:1:review");
});

test("循环内部 Step 的 needs 被跳过后仍在当前轮调度", async () => {
  const { fixture, started } = await prepareLoop("standard");
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const loop = profile.steps.find(({ id }) => id === "review-fix");
    assert.ok(loop);
    const children = loop.steps as Array<Record<string, unknown>>;
    const review = children.find(({ id }) => id === "review");
    const fix = children.find(({ id }) => id === "fix");
    assert.ok(review && fix);
    review.when = "false";
    fix.needs = ["review"];
    delete fix.when;
    loop.until = "false";
    loop.steps = [fix, review];
  });

  const first = requireExecute(await fixture.app.acquire({
    root: fixture.root,
    workItemId: started.workItemId,
    actor: "fixer",
  }));
  assert.equal(first.stepId, "review-fix:1:fix");
});

test("Review 通过时立即结束外层循环并可从事件恢复相同投影", async () => {
  const { fixture, started, worktree } = await prepareLoop("standard");
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  assert.equal(review.stepId, "review-fix:1:review");
  const artifact = await writeReviewArtifact({ worktree, workItemId: started.workItemId, workPackage: review, approved: true, filename: "review-1.md" });

  const completed = await submitPackage(fixture, review, completedResult(review, [artifact]));
  assert.equal(completed.action, "completed");
  const projection = await readControlPlane(fixture.root, started.workItemId);
  assert.deepEqual(projection.loops["review-fix"], {
    loopId: "review-fix",
    iteration: 1,
    maxIterations: 5,
    status: "succeeded",
  });
  assert.equal(projection.stages["review-fix"]?.status, "succeeded");

  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.deepEqual(recovered.loops, projection.loops);
  assert.equal(recovered.stages["review-fix"]?.status, "succeeded");
});

test("Fix 与 Verify 后进入新轮次，轮次隔离且旧 Submit 保持幂等", async () => {
  const { fixture, started, worktree } = await prepareLoop("standard");
  const review1 = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer-1" }));
  const rejected = await writeReviewArtifact({ worktree, workItemId: started.workItemId, workPackage: review1, approved: false, filename: "review-1.md" });
  const fix1 = requireExecute(await submitPackage(fixture, review1, completedResult(review1, [rejected])));
  assert.equal(fix1.stepId, "review-fix:1:fix");
  const verify1 = requireExecute(await submitPackage(fixture, fix1));
  assert.equal(verify1.stepId, "review-fix:1:verify");
  const review2 = requireExecute(await submitPackage(fixture, verify1));
  assert.equal(review2.stepId, "review-fix:2:review");
  assert.equal(new Set([review1.attemptId, fix1.attemptId, verify1.attemptId, review2.attemptId]).size, 4);

  const running = await readControlPlane(fixture.root, started.workItemId);
  assert.deepEqual(running.loops["review-fix"], {
    loopId: "review-fix",
    iteration: 2,
    maxIterations: 5,
    status: "running",
  });
  assert.ok(running.contexts["review-fix:1:review"]);
  assert.ok(running.contexts["review-fix:1:fix"]);
  assert.ok(running.contexts["review-fix:1:verify"]);

  const eventCount = (await readEvents(running.controlPlane)).length;
  const replayed = await submitPackage(fixture, review1, completedResult(review1, [rejected]));
  assert.deepEqual(replayed, { action: "execute", workPackage: fix1 });
  assert.equal((await readEvents(running.controlPlane)).length, eventCount);

  await assert.rejects(
    submitPackage(fixture, review1, { ...completedResult(review1, [rejected]), summary: "旧轮次重复提交" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_IDEMPOTENCY_CONFLICT",
  );

  const accepted = await writeReviewArtifact({ worktree, workItemId: started.workItemId, workPackage: review2, approved: true, filename: "review-2.md" });
  await submitPackage(fixture, review2, completedResult(review2, [accepted]));
  const finished = await readControlPlane(fixture.root, started.workItemId);
  const firstResult = finished.contexts["review-fix:1:review"] as { result: { artifacts: Array<{ path?: string }> } };
  const secondResult = finished.contexts["review-fix:2:review"] as { result: { artifacts: Array<{ path?: string }> } };
  assert.equal(firstResult.result.artifacts[0]?.path?.endsWith("review-1.md"), true);
  assert.equal(secondResult.result.artifacts[0]?.path?.endsWith("review-2.md"), true);
});

test("until 始终为 false 时达到 maxIterations 后稳定阻塞并保持恢复一致", async () => {
  const { fixture, started, worktree } = await prepareLoop("quick");
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  const rejected = await writeReviewArtifact({ worktree, workItemId: started.workItemId, workPackage: review, approved: false, filename: "review-blocked.md" });
  const fix = requireExecute(await submitPackage(fixture, review, completedResult(review, [rejected])));
  const verify = requireExecute(await submitPackage(fixture, fix));
  const blocked = await submitPackage(fixture, verify);
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") throw new Error("expected blocked action");
  assert.deepEqual(blocked.problems[0], {
    code: "WSSPEC_LOOP_MAX_ITERATIONS_REACHED",
    message: "循环 review-fix 已达到最大轮数 1，仍未满足退出条件。",
    retryable: false,
  });

  const projection = await readControlPlane(fixture.root, started.workItemId);
  assert.deepEqual(projection.loops["review-fix"], {
    loopId: "review-fix",
    iteration: 1,
    maxIterations: 1,
    status: "blocked",
  });
  assert.equal(projection.stages["review-fix"]?.status, "failed");
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.deepEqual(recovered.loops, projection.loops);
  assert.equal(recovered.stages["review-fix"]?.status, "failed");
});

test("循环内部 Step 的最后一次 Attempt 中断后恢复为稳定的重试耗尽阻塞", async () => {
  const { fixture, started } = await prepareLoop("standard");
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const loop = profile.steps.find(({ id }) => id === "review-fix");
    assert.ok(loop);
    const review = (loop.steps as Array<Record<string, unknown>>).find(({ id }) => id === "review");
    assert.ok(review);
    review.retry = { maxAttempts: 1 };
  });
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  assert.equal(review.stepId, "review-fix:1:review");

  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:expire-loop-attempt",
    operationInput: { stepId: review.stepId },
    mutate: (projection) => {
      const claim = projection.claims["review-fix"];
      assert.ok(claim);
      return {
        projection: {
          ...projection,
          claims: {
            ...projection.claims,
            "review-fix": { ...claim, expiresAt: "2026-08-18T03:59:59.000Z" },
          },
        },
        value: null,
      };
    },
  });
  const durable = await readControlPlane(fixture.root, started.workItemId);
  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.equal(recovered.retries[review.stepId]?.status, "exhausted");

  const exhausted = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer-2" });
  assert.equal(exhausted.action, "blocked");
  if (exhausted.action !== "blocked") throw new Error("expected blocked action");
  assert.deepEqual(exhausted.problems[0], {
    code: "WSSPEC_STEP_RETRY_EXHAUSTED",
    message: `步骤 ${review.stepId} 已耗尽重试次数。`,
    retryable: false,
  });
});

test("循环快照缺少 until 时拒绝把首个完成的内部 Step 当作退出条件", async () => {
  const { fixture, started } = await prepareLoop("standard");
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const loop = profile.steps.find(({ id }) => id === "review-fix");
    assert.ok(loop);
    delete loop.until;
  });

  await assert.rejects(
    fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_LOOP_CONFIGURATION_INVALID",
  );
});

test("Review 退出条件使用最高 revision，不受提交数组顺序影响", async () => {
  const { fixture, started, worktree } = await prepareLoop("standard");
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  const openV2 = await writeReviewArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: review,
    approved: false,
    filename: "review-v2.md",
    revision: 2,
  });
  const fixedV1 = await writeReviewArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: review,
    approved: true,
    filename: "review-v1.md",
    revision: 1,
  });

  const fix = requireExecute(await submitPackage(fixture, review, completedResult(review, [openV2, fixedV1])));
  assert.equal(fix.stepId, "review-fix:1:fix");
  assert.deepEqual(fix.artifacts, [openV2]);
});
