import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { computeWorkspaceTreeDigest } from "../../src/domain/digests.js";
import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { claimStage, buildStageContext, releaseClaim, renewClaim } from "../../src/engine/claims.js";
import { completeStage, invalidateFromArtifact, StageResultError } from "../../src/engine/results.js";
import { initializeControlPlane, readControlPlane, recoverControlPlane, writeProjection } from "../../src/storage/control-plane.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { transitionRuntime } from "../../src/engine/scheduler.js";
import { createGitRepository, git } from "./helpers/git.js";

const workflow = `version: 1
workflow:
  id: stage-execution
stages:
  - id: build
    kind: implement
    owner: agent
    uses: engineering.implement
    output: [implementation-result]
  - id: review
    kind: review
    owner: agent
    uses: engineering.review
    needs: [build]
    input: [implementation-result]
    output: [review-result]
`;

const config = `version: 1
trigger: { mode: suggest }
git:
  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }
runtime: { claimTtlSeconds: 60, maxStageRetries: 3 }
quality:
  gates:
    test: { command: [npm, test], cwd: worktree, timeoutSeconds: 900, required: true, evidence: trusted }
`;

async function prepare(): Promise<{ root: string; worktree: string; workItemId: string }> {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "workflow.yaml"), workflow);
  await writeFile(path.join(root, ".wsspec", "config.yaml"), config);
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "chore: configure stage fixture");
  const workItemId = "WSS-20260816-STAGE";
  const item = await createWorkItem({ root, workItemId, title: "阶段执行", source: { type: "prompt", content: "实现功能" } });
  const worktree = path.join(root, item.execution.worktree);
  await initializeControlPlane({ cwd: root, workItemId, stages: ["build", "review"] });
  await transitionRuntime({ cwd: root, workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" });
  await transitionRuntime({ cwd: root, workItemId, scope: "stage", stageId: "build", to: "ready", idempotencyKey: "ready" });
  return { root, worktree, workItemId };
}

test("only one concurrent Agent can claim a ready Stage", async () => {
  const fixture = await prepare();
  const results = await Promise.allSettled([
    claimStage({ ...fixture, cwd: fixture.root, stageId: "build", actor: "codex-a", now: "2026-08-16T04:00:00.000Z" }),
    claimStage({ ...fixture, cwd: fixture.worktree, stageId: "build", actor: "codex-b", now: "2026-08-16T04:00:00.000Z" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("an expired Claim can be replaced with a new Attempt and token", async () => {
  const fixture = await prepare();
  const first = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", actor: "codex-a", now: "2026-08-16T04:00:00.000Z" });
  const second = await claimStage({ cwd: fixture.worktree, workItemId: fixture.workItemId, stageId: "build", actor: "codex-b", now: "2026-08-16T04:02:00.000Z" });
  assert.notEqual(second.attemptId, first.attemptId);
  assert.notEqual(second.claimToken, first.claimToken);
});

test("a Claim can be renewed and explicitly released without reusing its token", async () => {
  const fixture = await prepare();
  const claim = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", actor: "codex", now: "2026-08-16T04:00:00.000Z" });
  const renewed = await renewClaim({ cwd: fixture.worktree, workItemId: fixture.workItemId, stageId: "build", attemptId: claim.attemptId, claimToken: claim.claimToken, now: "2026-08-16T04:00:30.000Z" });
  assert.equal(renewed.expiresAt, "2026-08-16T04:01:30.000Z");
  await releaseClaim({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", attemptId: claim.attemptId, claimToken: claim.claimToken });
  const replacement = await claimStage({ cwd: fixture.worktree, workItemId: fixture.workItemId, stageId: "build", actor: "other", now: "2026-08-16T04:00:31.000Z" });
  assert.notEqual(replacement.claimToken, claim.claimToken);
  await assert.rejects(buildStageContext(claim), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_ATTEMPT_NOT_ACTIVE");
});

test("recovery cancels active Claim and Context while preserving their audit events", async () => {
  const fixture = await prepare();
  const claim = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", actor: "codex" });
  await buildStageContext(claim);
  const before = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(before.controlPlane, "runtime.json"), "not-json\n");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.equal(recovered.stages.build?.status, "ready");
  assert.equal(recovered.claims.build, undefined);
  assert.equal(recovered.contexts.build, undefined);
  assert.ok(recovered.lastSequence > before.lastSequence);
});

test("Context binds the input digest and completion accepts a changed output digest", async () => {
  const fixture = await prepare();
  const claim = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", actor: "codex", allowedPaths: ["src/", "artifacts/"], now: "2026-08-16T04:00:00.000Z" });
  const context = await buildStageContext(claim);
  assert.equal(context.inputWorkspaceTreeDigest, await computeWorkspaceTreeDigest(fixture.worktree));
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "build", to: "running", idempotencyKey: "start" });
  await writeFile(path.join(fixture.worktree, "src", "feature.ts"), "export const feature = true;\n", { flag: "w" }).catch(async () => {
    const { mkdir } = await import("node:fs/promises"); await mkdir(path.join(fixture.worktree, "src")); await writeFile(path.join(fixture.worktree, "src", "feature.ts"), "export const feature = true;\n");
  });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(fixture.worktree, "artifacts"));
  const body = ["# 实现结果", "", "## 实际改动", "完成", "## 修改文件", "src/feature.ts", "## 计划偏差", "无", "## 验证摘要", "通过", "## 未完成项", "无", "## 残余风险", "无", ""].join("\n");
  const metadata = { artifactType: "implementation-result", schemaVersion: 1 as const, workItemId: fixture.workItemId, stageId: "build", attemptId: claim.attemptId, revision: 1 };
  const contentHash = computeArtifactContentHash(metadata, body);
  const artifactPath = "artifacts/implementation-result.md";
  await writeFile(path.join(fixture.worktree, artifactPath), `---\nartifactType: implementation-result\nschemaVersion: 1\nworkItemId: ${fixture.workItemId}\nstageId: build\nattemptId: ${claim.attemptId}\nrevision: 1\ncontentHash: ${contentHash}\n---\n${body}`);
  const outputDigest = await computeWorkspaceTreeDigest(fixture.worktree);
  assert.notEqual(outputDigest, context.inputWorkspaceTreeDigest);
  const projection = await completeStage({
    cwd: fixture.root,
    context,
    result: { version: 1, workItemId: fixture.workItemId, stageId: "build", attemptId: claim.attemptId, workflowDigest: context.workflowDigest, contextDigest: context.contextDigest, baselineTreeDigest: context.baselineTreeDigest, inputWorkspaceTreeDigest: context.inputWorkspaceTreeDigest, outputWorkspaceTreeDigest: outputDigest, status: "completed", summary: "实现完成", modifiedFiles: ["src/feature.ts", artifactPath], artifacts: [{ artifactType: "implementation-result", schemaVersion: 1, path: artifactPath, revision: 1, contentHash, mediaType: "text/markdown" }], commands: [], evidence: [], externalWrites: [], remainingRisks: [] },
  });
  assert.equal(projection.stages.build?.status, "validating");
});

test("completion rejects a missing required Artifact", async () => {
  const fixture = await prepare();
  const claim = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", actor: "codex" });
  const context = await buildStageContext(claim);
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "build", to: "running", idempotencyKey: "start" });
  await assert.rejects(completeStage({ cwd: fixture.root, context, result: { version: 1, workItemId: fixture.workItemId, stageId: "build", attemptId: claim.attemptId, workflowDigest: context.workflowDigest, contextDigest: context.contextDigest, baselineTreeDigest: context.baselineTreeDigest, inputWorkspaceTreeDigest: context.inputWorkspaceTreeDigest, outputWorkspaceTreeDigest: await computeWorkspaceTreeDigest(fixture.worktree), status: "completed", summary: "无工件", modifiedFiles: [], artifacts: [], commands: [], evidence: [], externalWrites: [], remainingRisks: [] } }), (error: unknown) => error instanceof StageResultError && error.code === "WSSPEC_REQUIRED_ARTIFACT_MISSING");
});

test("completion rejects forged output digests and actual changes outside allowedPaths", async () => {
  const fixture = await prepare();
  const claim = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", actor: "codex", allowedPaths: ["src/"], now: "2026-08-16T04:00:00.000Z" });
  const context = await buildStageContext(claim);
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "build", to: "running", idempotencyKey: "start" });
  await writeFile(path.join(fixture.worktree, "README.md"), "outside\n");
  const base = { version: 1 as const, workItemId: fixture.workItemId, stageId: "build", attemptId: claim.attemptId, workflowDigest: context.workflowDigest, contextDigest: context.contextDigest, baselineTreeDigest: context.baselineTreeDigest, inputWorkspaceTreeDigest: context.inputWorkspaceTreeDigest, status: "completed" as const, summary: "伪造", modifiedFiles: ["README.md"], artifacts: [], commands: [], evidence: [], externalWrites: [], remainingRisks: [] };
  await assert.rejects(completeStage({ cwd: fixture.root, context, result: { ...base, outputWorkspaceTreeDigest: "sha256:fake" } }), (error: unknown) => error instanceof StageResultError && error.code === "WSSPEC_OUTPUT_DIGEST_MISMATCH");
  await assert.rejects(completeStage({ cwd: fixture.root, context, result: { ...base, outputWorkspaceTreeDigest: await computeWorkspaceTreeDigest(fixture.worktree) } }), (error: unknown) => error instanceof StageResultError && error.code === "WSSPEC_ALLOWED_PATHS_VIOLATION");
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).stages.build?.status, "running");
});

test("artifact invalidation cancels the active Claim and invalidates its Context", async () => {
  const fixture = await prepare();
  const claim = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "build", actor: "codex" });
  await buildStageContext(claim);
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "review", to: "ready", idempotencyKey: "review-ready" });
  const downstream = await claimStage({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "review", actor: "reviewer" });
  await buildStageContext(downstream);
  const before = await readControlPlane(fixture.root, fixture.workItemId);
  before.approvals = { approval: { requestId: "approval", stageId: "review", attemptId: downstream.attemptId, artifactPath: "review.md", contentHash: "sha256:test", workspaceTreeDigest: downstream.inputWorkspaceTreeDigest, status: "pending", createdAt: new Date().toISOString() } };
  before.evidence = { evidence: { stageId: "review", result: "passed" } };
  await writeProjection(before);
  const projection = await invalidateFromArtifact({ cwd: fixture.worktree, workItemId: fixture.workItemId, stageId: "build" });
  assert.equal(projection.stages.build?.status, "invalidated");
  assert.equal(projection.stages.review?.status, "invalidated");
  assert.equal(projection.claims.build, undefined);
  assert.equal(projection.contexts.build, undefined);
  assert.equal(projection.claims.review, undefined);
  assert.equal(projection.contexts.review, undefined);
  assert.deepEqual(projection.approvals, {});
  assert.deepEqual(projection.evidence, {});
});
