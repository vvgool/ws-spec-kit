import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { applyProfileDecision } from "../../src/application/profile.js";
import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import type { SubmitResult } from "../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../src/protocol/work-package.js";
import { readControlPlane, recoverControlPlane, replayEvents, type RuntimeProjection } from "../../src/storage/control-plane.js";
import { readEvents, type StoredEvent } from "../../src/storage/events.js";
import {
  completedResult,
  controlRuntimeFixture,
  failedResult,
  requireExecute,
  retainOnlyReadyStage,
  submitPackage,
  worktreeFor,
  writeReviewArtifact,
} from "./helpers/control-runtime.js";

async function writeArtifact(input: {
  worktree: string;
  workItemId: string;
  workPackage: WorkPackage;
  artifactType: string;
  filename?: string;
}): Promise<ArtifactReference> {
  const body = "# Exploration\n\nRepository facts.\n";
  const metadata = {
    artifactType: input.artifactType,
    schemaVersion: 1 as const,
    workItemId: input.workItemId,
    stageId: input.workPackage.stepId,
    attemptId: input.workPackage.attemptId,
    revision: 1,
  };
  const contentHash = computeArtifactContentHash(metadata, body);
  const relative = `.wsspec/work-items/${input.workItemId}/artifacts/${input.filename ?? `${input.artifactType}.md`}`;
  await mkdir(path.dirname(path.join(input.worktree, relative)), { recursive: true });
  await writeFile(
    path.join(input.worktree, relative),
    `---\nartifactType: ${input.artifactType}\nschemaVersion: 1\nworkItemId: ${input.workItemId}\nstageId: ${input.workPackage.stepId}\nattemptId: ${input.workPackage.attemptId}\nrevision: 1\ncontentHash: ${contentHash}\n---\n${body}`,
    "utf8",
  );
  return { artifactType: input.artifactType, schemaVersion: 1, path: relative, revision: 1, contentHash, mediaType: "text/markdown" };
}

test("旧事件投影恢复时补齐累计风险信号", () => {
  const legacyProfile = { mode: "quick", selected: "quick", provisional: false, reasonRuleIds: [] };
  const event = {
    eventType: "projection.invalidated",
    repositoryId: "repository",
    workItemId: "work-item",
    sequence: 1,
    eventHash: "event-hash",
    idempotencyKey: "legacy-profile",
    result: { projection: { profile: legacyProfile } },
  } as unknown as StoredEvent;

  const recovered = replayEvents({
    repositoryId: "repository",
    workItemId: "work-item",
    stageIds: [],
    controlPlane: "/control-plane",
    events: [event],
  });

  assert.deepEqual(recovered.profile.riskSignals, {
    levels: [],
    affectedPaths: [],
    modifiedPaths: [],
    issueLabels: [],
    fileTypes: [],
    plannedActions: [],
  });
});

async function submitExplore(
  profile: "auto" | "quick" | "standard" | "governed",
  remainingRisks: Array<Record<string, unknown>>,
) {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "验证 Profile 运行时选择" },
    profile,
  });
  const initial = await readControlPlane(fixture.root, started.workItemId);
  const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "intake-agent" }));
  const explore = requireExecute(await submitPackage(fixture, intake));
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  const artifact = await writeArtifact({ worktree, workItemId: started.workItemId, workPackage: explore, artifactType: "exploration-report" });
  const result: SubmitResult = { ...completedResult(explore, [artifact]), remainingRisks };
  const action = await submitPackage(fixture, explore, result);
  return { fixture, started, initial, explore, result, action, projection: await readControlPlane(fixture.root, started.workItemId) };
}

test("auto 在 intake/explore 期间保持 provisional quick，且初始选择写入事件", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证 provisional quick" }, profile: "auto" });
  const projection = await readControlPlane(fixture.root, started.workItemId);

  assert.deepEqual(projection.profile, {
    mode: "auto",
    selected: "quick",
    provisional: true,
    reasonRuleIds: [],
    riskSignals: { levels: [], affectedPaths: [], modifiedPaths: [], issueLabels: [], fileTypes: [], plannedActions: [] },
  });
  assert.deepEqual(
    Object.entries(projection.stages).filter(([, stage]) => stage.status === "ready").map(([stepId]) => stepId),
    ["intake"],
  );
  assert.equal((await readEvents(projection.controlPlane)).at(-1)?.eventType, "profile.selected");
});

test("auto 在 Explore 后将 low/unknown/high 分别选择为 quick/standard/governed", async () => {
  const cases = [
    { label: "low", risks: [{ risk: "low" }], expected: "quick" },
    { label: "unknown", risks: [], expected: "standard" },
    { label: "high", risks: [{ risk: "high" }], expected: "governed" },
  ] as const;

  for (const current of cases) {
    const completed = await submitExplore("auto", [...current.risks]);
    assert.equal(completed.projection.profile.selected, current.expected, current.label);
    assert.equal(completed.projection.profile.provisional, false, current.label);
  }
});

test("explicit Profile 不因较低风险降级，但仍服从更高风险下限", async () => {
  const standard = await submitExplore("standard", [{ risk: "low" }]);
  assert.equal(standard.projection.profile.selected, "standard");

  const quick = await submitExplore("quick", [{ risk: "high" }]);
  assert.equal(quick.projection.profile.selected, "governed");
});

test("敏感路径规则升级 governed 并记录命中的规则", async () => {
  const completed = await submitExplore("auto", [{ risk: "low", affectedPaths: ["src/auth/session.ts"] }]);
  assert.equal(completed.projection.profile.selected, "governed");
  assert.ok(completed.projection.profile.reasonRuleIds.includes("sensitive-path"));
});

test("applyProfileDecision 禁止降级并一次性失效受影响结果、Claim、Approval、Evidence、Loop 与 Retry", () => {
  const projection = {
    version: 1,
    repositoryId: "repository-1",
    workItemId: "WSS-1",
    workItem: { status: "awaiting_approval" },
    stages: {
      intake: { status: "succeeded" },
      design: { status: "skipped" },
      plan: { status: "succeeded" },
      "review-fix": { status: "claimed" },
      "verify-green": { status: "awaiting_approval" },
    },
    lastSequence: 4,
    lastEventHash: "hash",
    idempotency: {},
    profile: {
      mode: "auto",
      selected: "standard",
      provisional: false,
      reasonRuleIds: [],
      riskSignals: { levels: [], affectedPaths: [], modifiedPaths: [], issueLabels: [], fileTypes: [], plannedActions: [] },
    },
    claims: {
      "review-fix": { stageId: "review-fix:1:review", attemptId: "attempt-review", claimToken: "token", actor: "reviewer", claimedAt: "2026-08-18T04:00:00.000Z", expiresAt: "2026-08-18T05:00:00.000Z", inputWorkspaceTreeDigest: "sha256:test", allowedPaths: [], workspaceSnapshot: [] },
    },
    contexts: {
      intake: { result: { status: "completed" } },
      plan: { result: { status: "completed" } },
      "review-fix": { workPackage: { stepId: "review-fix:1:review" } },
      "review-fix:1:review": { result: { status: "completed" } },
      "verify-green": { result: { status: "completed" } },
    },
    approvals: {
      "approval-verify": { requestId: "approval-verify", stageId: "verify-green", attemptId: "attempt-verify", artifactPath: "artifact", contentHash: "sha256:test", workspaceTreeDigest: "sha256:test", status: "pending", createdAt: "2026-08-18T04:00:00.000Z" },
    },
    evidence: {
      test: { gateId: "test", stageId: "verify-green" },
      intake: { gateId: "intake", stageId: "intake" },
    },
    loops: { "review-fix": { loopId: "review-fix", iteration: 1, maxIterations: 5, status: "running" } },
    retries: { "review-fix:1:review": { stepInstanceId: "review-fix:1:review", attemptsUsed: 1, maxAttempts: 3, status: "running" } },
    readOnly: false,
    controlPlane: "/tmp/control-plane",
  } as RuntimeProjection;

  const upgraded = applyProfileDecision(projection, {
    previous: "standard",
    selected: "governed",
    reasonRuleIds: ["sensitive-path"],
    invalidatedStepIds: ["design", "plan", "review-fix", "verify-green"],
  });

  assert.equal(upgraded.profile.selected, "governed");
  assert.equal(upgraded.stages.intake?.status, "succeeded");
  assert.equal(upgraded.stages.design?.status, "invalidated");
  assert.equal(upgraded.stages.plan?.status, "succeeded");
  assert.deepEqual(upgraded.contexts.intake, projection.contexts.intake);
  assert.equal(upgraded.contexts.plan, undefined);
  assert.equal(upgraded.contexts["review-fix:1:review"], undefined);
  assert.deepEqual(upgraded.evidence.intake, projection.evidence.intake);
  assert.equal(upgraded.evidence.test, undefined);
  assert.deepEqual(upgraded.claims, {});
  assert.deepEqual(upgraded.approvals, {});
  assert.equal(upgraded.workItem.status, "active");
  assert.deepEqual(upgraded.loops, {});
  assert.deepEqual(upgraded.retries, {});

  assert.throws(() => applyProfileDecision(upgraded, {
    previous: "governed",
    selected: "quick",
    reasonRuleIds: [],
    invalidatedStepIds: [],
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "WSSPEC_PROFILE_DOWNGRADE_FORBIDDEN");
});

test("Profile 升级与重复 Submit 原子幂等，恢复后不丢失 profile/loop/retry 投影", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证 Profile 原子恢复" }, profile: "auto" });
  const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  const explore = requireExecute(await submitPackage(fixture, intake));
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:seed-loop-retry",
    operationInput: {},
    mutate: (current) => ({
      projection: {
        ...current,
        loops: { ...current.loops, unrelated: { loopId: "unrelated", iteration: 1, maxIterations: 2, status: "running" } },
        retries: { ...current.retries, unrelated: { stepInstanceId: "unrelated", attemptsUsed: 1, maxAttempts: 2, status: "ready" } },
      },
      value: null,
    }),
  });
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  const artifact = await writeArtifact({ worktree, workItemId: started.workItemId, workPackage: explore, artifactType: "exploration-report" });
  const result = { ...completedResult(explore, [artifact]), remainingRisks: [{ risk: "high" }] };

  const [first, second] = await Promise.all([
    submitPackage(fixture, explore, result),
    submitPackage(fixture, explore, result),
  ]);
  assert.deepEqual(second, first);

  const durable = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(durable.profile.selected, "governed");
  assert.deepEqual(durable.loops.unrelated, { loopId: "unrelated", iteration: 1, maxIterations: 2, status: "running" });
  assert.deepEqual(durable.retries.unrelated, { stepInstanceId: "unrelated", attemptsUsed: 1, maxAttempts: 2, status: "ready" });
  assert.equal((await readEvents(durable.controlPlane)).filter(({ eventType }) => eventType === "profile.upgraded").length, 1);

  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.deepEqual(recovered.profile, durable.profile);
  assert.deepEqual(recovered.loops, durable.loops);
  assert.deepEqual(recovered.retries.unrelated, durable.retries.unrelated);
  assert.equal(recovered.retries.clarify?.status, "ready");
});

test("Governed Review 要求 reviewActor 与 implementationActor 不同", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证独立 Review Actor" }, profile: "governed" });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:seed-implementation-actor",
    operationInput: { actor: "codex" },
    mutate: (current) => ({ projection: { ...current, contexts: { ...current.contexts, implement: { actor: "codex", result: { status: "completed" } } } }, value: null }),
  });

  await assert.rejects(
    fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WSSPEC_INDEPENDENT_REVIEW_REQUIRED",
  );
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  assert.equal(review.stepId, "review-fix:1:review");
});

test("Governed 后续 Review 不能由上一轮 Fix Actor 执行", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证 Fix 后独立 Review Actor" }, profile: "governed" });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:seed-latest-fix-actor",
    operationInput: { actor: "codex", iteration: 2 },
    mutate: (current) => ({
      projection: {
        ...current,
        contexts: {
          ...current.contexts,
          implement: { actor: "implementer", result: { status: "completed" } },
          "review-fix:1:fix": { actor: "codex", result: { status: "completed" } },
        },
        loops: {
          ...current.loops,
          "review-fix": { loopId: "review-fix", iteration: 2, maxIterations: 5, status: "running" },
        },
      },
      value: null,
    }),
  });

  await assert.rejects(
    fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WSSPEC_INDEPENDENT_REVIEW_REQUIRED",
  );
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  assert.equal(review.stepId, "review-fix:2:review");
});

test("失败 Attempt 的敏感实际改动与 Retry 状态原子升档，并在无新 diff 的重试和恢复后保持 Governed", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证失败 Attempt 风险" }, profile: "quick" });
  const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "intake" }));
  const explore = requireExecute(await submitPackage(fixture, intake));
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  await mkdir(path.join(worktree, "src/auth"), { recursive: true });
  await writeFile(path.join(worktree, "src/auth/session.ts"), "export const session = true;\n", "utf8");
  const failed = { ...failedResult(explore), modifiedFiles: ["src/auth/session.ts"] };

  const [first, duplicate] = await Promise.all([
    submitPackage(fixture, explore, failed),
    submitPackage(fixture, explore, failed),
  ]);
  assert.deepEqual(duplicate, first);
  const failedProjection = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(failedProjection.profile.selected, "governed");
  assert.equal(failedProjection.retries.explore?.status, "ready");
  assert.equal((await readEvents(failedProjection.controlPlane)).filter(({ eventType }) => eventType === "profile.upgraded").length, 1);

  const retry = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "explorer" }));
  const artifact = await writeArtifact({ worktree, workItemId: started.workItemId, workPackage: retry, artifactType: "exploration-report" });
  await submitPackage(fixture, retry, completedResult(retry, [artifact]));
  const durable = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(durable.profile.selected, "governed");

  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.equal(recovered.profile.selected, "governed");
});

test("当前 Review 属于升档失效集合时，可重试失败原子保留最终状态并支持幂等重试恢复", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证当前 Review 失败升档" }, profile: "quick" });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:seed-current-review-upgrade",
    operationInput: {},
    mutate: (current) => ({
      projection: {
        ...current,
        contexts: { ...current.contexts, implement: { actor: "implementer", result: { status: "completed" } } },
      },
      value: null,
    }),
  });
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  await mkdir(path.join(worktree, "src/auth"), { recursive: true });
  await writeFile(path.join(worktree, "src/auth/session.ts"), "export const session = true;\n", "utf8");
  const failed = { ...failedResult(review), modifiedFiles: ["src/auth/session.ts"] };

  const [first, duplicate] = await Promise.all([
    submitPackage(fixture, review, failed),
    submitPackage(fixture, review, failed),
  ]);
  assert.deepEqual(duplicate, first);
  await assert.rejects(
    submitPackage(fixture, review, { ...failed, summary: "conflicting failure" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WSSPEC_IDEMPOTENCY_CONFLICT",
  );
  const durable = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(durable.profile.selected, "governed");
  assert.deepEqual(durable.profile.riskSignals.modifiedPaths, ["src/auth/session.ts"]);
  assert.equal(durable.stages["review-fix"]?.status, "failed");
  assert.equal(durable.retries[review.stepId]?.status, "ready");
  assert.equal(durable.claims["review-fix"], undefined);
  assert.equal((durable.contexts[review.stepId] as { result?: { status?: string } } | undefined)?.result?.status, "failed");
  assert.equal((await readEvents(durable.controlPlane)).filter(({ eventType }) => eventType === "profile.upgraded").length, 1);

  const retry = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "retry-reviewer" }));
  assert.equal(retry.stepId, review.stepId);
  await submitPackage(fixture, retry, failedResult(retry));
  const retried = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(retried.profile.selected, "governed");
  assert.equal(retried.retries[review.stepId]?.status, "ready");

  await writeFile(path.join(retried.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.equal(recovered.profile.selected, "governed");
  assert.equal(recovered.stages["review-fix"]?.status, "failed");
  assert.equal(recovered.retries[review.stepId]?.status, "ready");
  assert.equal(recovered.claims["review-fix"], undefined);
});

test("当前 Review 属于升档失效集合时，永久失败原子持久化 Profile 与阻塞终态", async () => {
  const fixture = await controlRuntimeFixture({ validatedFailureCode: "WSSPEC_STEP_INPUT_INVALID" });
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证当前 Review 永久失败升档" }, profile: "quick" });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:seed-current-review-permanent-failure",
    operationInput: {},
    mutate: (current) => ({
      projection: {
        ...current,
        contexts: { ...current.contexts, implement: { actor: "implementer", result: { status: "completed" } } },
      },
      value: null,
    }),
  });
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "reviewer" }));
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  const reviewArtifact = await writeReviewArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: review,
    approved: false,
    filename: "permanent-failure-review.md",
  });
  const fix = requireExecute(await submitPackage(fixture, review, completedResult(review, [reviewArtifact])));
  const verify = requireExecute(await submitPackage(fixture, fix));
  await mkdir(path.join(worktree, "src/auth"), { recursive: true });
  await writeFile(path.join(worktree, "src/auth/session.ts"), "export const session = true;\n", "utf8");

  const action = await submitPackage(fixture, verify, { ...failedResult(verify), modifiedFiles: ["src/auth/session.ts"] });
  assert.equal(action.action, "blocked");
  const durable = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(durable.profile.selected, "governed");
  assert.deepEqual(durable.profile.riskSignals.modifiedPaths, ["src/auth/session.ts"]);
  assert.equal(durable.stages["review-fix"]?.status, "failed");
  assert.equal(durable.retries[verify.stepId], undefined);
  assert.equal(durable.claims["review-fix"], undefined);
  assert.equal((durable.contexts[verify.stepId] as { result?: { failureCode?: string } } | undefined)?.result?.failureCode, "WSSPEC_STEP_INPUT_INVALID");

  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.equal(recovered.profile.selected, "governed");
  assert.equal(recovered.stages["review-fix"]?.status, "failed");
  assert.equal(recovered.retries[verify.stepId], undefined);
  assert.equal(recovered.claims["review-fix"], undefined);
});

test("Auto 在 Intake low/high 后保持 provisional，并由 Explore 合并累计 high 后首次选档", async () => {
  for (const intakeRisk of ["low", "high"] as const) {
    const fixture = await controlRuntimeFixture();
    const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: `验证 Intake ${intakeRisk} 累计` }, profile: "auto" });
    const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "intake" }));
    requireExecute(await submitPackage(fixture, intake, {
      ...completedResult(intake),
      remainingRisks: [{ risk: intakeRisk }],
    }));
    const beforeExplore = await readControlPlane(fixture.root, started.workItemId);
    assert.equal(beforeExplore.profile.selected, "quick", intakeRisk);
    assert.equal(beforeExplore.profile.provisional, true, intakeRisk);

    await writeFile(path.join(beforeExplore.controlPlane, "runtime.json"), "not-json\n", "utf8");
    const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
    assert.equal(recovered.profile.provisional, true, intakeRisk);
    const resumedExplore = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "explorer" }));
    const worktree = await worktreeFor(fixture.root, started.workItemId);
    const artifact = await writeArtifact({ worktree, workItemId: started.workItemId, workPackage: resumedExplore, artifactType: "exploration-report" });
    await submitPackage(fixture, resumedExplore, {
      ...completedResult(resumedExplore, [artifact]),
      remainingRisks: [{ risk: "low" }],
    });
    const selected = await readControlPlane(fixture.root, started.workItemId);
    assert.equal(selected.profile.selected, intakeRisk === "high" ? "governed" : "quick", intakeRisk);
    assert.equal(selected.profile.provisional, false, intakeRisk);
  }
});

test("显式 Profile 不受 provisional 边界限制，Intake high 立即单向升级", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证显式 Profile Intake 升档" }, profile: "quick" });
  const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "intake" }));
  await submitPackage(fixture, intake, { ...completedResult(intake), remainingRisks: [{ risk: "high" }] });
  const projection = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(projection.profile.selected, "governed");
  assert.equal(projection.profile.provisional, false);
});

test("Governed Review 拒绝原实现者和所有历史 completed Fix Actor，并在恢复后保持完整集合", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证完整 Review Actor 集合" }, profile: "governed" });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:seed-all-implementation-actors",
    operationInput: { iteration: 3 },
    mutate: (current) => ({
      projection: {
        ...current,
        contexts: {
          ...current.contexts,
          implement: { actor: "original-implementer", result: { status: "completed" } },
          "review-fix:1:fix": { actor: "old-fixer", result: { status: "completed" } },
          "review-fix:2:fix": { actor: "latest-fixer", result: { status: "completed" } },
        },
        loops: { ...current.loops, "review-fix": { loopId: "review-fix", iteration: 3, maxIterations: 5, status: "running" } },
      },
      value: null,
    }),
  });
  const durable = await readControlPlane(fixture.root, started.workItemId);
  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");
  await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });

  for (const actor of ["original-implementer", "old-fixer", "latest-fixer"]) {
    await assert.rejects(
      fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "WSSPEC_INDEPENDENT_REVIEW_REQUIRED",
      actor,
    );
  }
  const review = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "independent-reviewer" }));
  assert.equal(review.stepId, "review-fix:3:review");
});

test("Governed Review 在已完成实现记录缺少 actor 时 fail closed", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证缺失实现 Actor" }, profile: "governed" });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:seed-missing-implementation-actor",
    operationInput: {},
    mutate: (current) => ({
      projection: {
        ...current,
        contexts: {
          ...current.contexts,
          implement: { actor: "original-implementer", result: { status: "completed" } },
          "review-fix:1:fix": { result: { status: "completed" } },
        },
        loops: { ...current.loops, "review-fix": { loopId: "review-fix", iteration: 2, maxIterations: 5, status: "running" } },
      },
      value: null,
    }),
  });

  await assert.rejects(
    fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "independent-reviewer" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WSSPEC_INDEPENDENT_REVIEW_REQUIRED",
  );
});
