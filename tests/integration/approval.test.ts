import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { ApprovalError, decideArtifactApproval, requestArtifactApproval } from "../../src/engine/approvals.js";
import { transitionRuntime } from "../../src/engine/scheduler.js";
import { initializeControlPlane, readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

async function prepare() {
  const root = await createGitRepository();
  await initRepository(root);
  const workflow = `version: 1\nworkflow: { id: approval }\nstages:\n  - id: define\n    kind: define\n    owner: agent\n    uses: artifact.generate\n    output: [specification]\n    approval: { required: true, provider: interactive }\n`;
  const config = `version: 1\ntrigger: { mode: suggest }\ngit:\n  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }\nruntime: { claimTtlSeconds: 60, maxStageRetries: 3 }\nquality:\n  gates:\n    test: { command: [npm, test], cwd: worktree, timeoutSeconds: 60, required: true, evidence: trusted }\n`;
  await mkdir(path.join(root, ".wsspec"), { recursive: true });
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), workflow); await writeFile(path.join(root, ".wsspec/config.yaml"), config);
  await git(root, "add", "."); await git(root, "commit", "-m", "approval fixture");
  const workItemId = "WSS-APPROVAL"; const item = await createWorkItem({ root, workItemId, title: "审批", source: { type: "prompt", content: "审批" } });
  const worktree = path.join(root, item.execution.worktree); await initializeControlPlane({ cwd: root, workItemId, stages: ["define"] });
  for (const [scope, to, key] of [["work-item", "active", "active"], ["stage", "ready", "ready"], ["stage", "running", "run"], ["stage", "validating", "validate"]] as const) await transitionRuntime({ cwd: root, workItemId, scope, ...(scope === "stage" ? { stageId: "define" } : {}), to: to as never, idempotencyKey: key } as never);
  const body = ["# 规格", "", "## 目标与背景", "目标", "## 范围", "范围", "## 需求", "需求", "## 验收条件", "条件", "## 约束", "约束", "## 排除项", "无", "## 开放问题", "无", ""].join("\n");
  const metadata = { artifactType: "specification", schemaVersion: 1 as const, workItemId, stageId: "define", attemptId: "attempt-approval", revision: 1 };
  const contentHash = computeArtifactContentHash(metadata, body); const artifactPath = "artifacts/specification.md";
  await mkdir(path.join(worktree, "artifacts")); await writeFile(path.join(worktree, artifactPath), `---\nartifactType: specification\nschemaVersion: 1\nworkItemId: ${workItemId}\nstageId: define\nattemptId: attempt-approval\nrevision: 1\ncontentHash: ${contentHash}\n---\n${body}`);
  return { root, worktree, workItemId, artifactPath, contentHash };
}

test("non-TTY input cannot approve an Artifact", async () => {
  const fixture = await prepare(); const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "define", attemptId: "attempt-approval", artifactPath: fixture.artifactPath });
  await assert.rejects(decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: false } }), (error: unknown) => error instanceof ApprovalError && error.code === "WSSPEC_INTERACTIVE_TTY_REQUIRED");
});

test("approval expires when the bound workspace changes", async () => {
  const fixture = await prepare(); const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "define", attemptId: "attempt-approval", artifactPath: fixture.artifactPath });
  await writeFile(path.join(fixture.worktree, "changed.txt"), "changed\n");
  await assert.rejects(decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } }), (error: unknown) => error instanceof ApprovalError && error.code === "WSSPEC_APPROVAL_EXPIRED");
});

test("TTY decisions approve or reject the exact pending request", async () => {
  const approvedFixture = await prepare(); const approvedRequest = await requestArtifactApproval({ cwd: approvedFixture.root, workItemId: approvedFixture.workItemId, stageId: "define", attemptId: "attempt-approval", artifactPath: approvedFixture.artifactPath });
  const approved = await decideArtifactApproval({ cwd: approvedFixture.root, workItemId: approvedFixture.workItemId, requestId: approvedRequest.requestId, decision: "approve", terminal: { isTTY: true } }); assert.equal(approved.status, "approved");
  const rejectedFixture = await prepare(); const rejectedRequest = await requestArtifactApproval({ cwd: rejectedFixture.root, workItemId: rejectedFixture.workItemId, stageId: "define", attemptId: "attempt-approval", artifactPath: rejectedFixture.artifactPath });
  const rejected = await decideArtifactApproval({ cwd: rejectedFixture.root, workItemId: rejectedFixture.workItemId, requestId: rejectedRequest.requestId, decision: "reject", terminal: { isTTY: true }, reason: "需要修订" }); assert.equal(rejected.status, "rejected");
});

test("approval persistence excludes environment preauthorization and terminal secrets", async () => {
  const fixture = await prepare(); const secret = `secret-${crypto.randomUUID()}`; process.env.WSSPEC_APPROVAL = secret;
  try {
    const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "define", attemptId: "attempt-approval", artifactPath: fixture.artifactPath });
    await decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } });
    const projection = await readControlPlane(fixture.root, fixture.workItemId); const persisted = `${await readFile(path.join(projection.controlPlane, "runtime.json"), "utf8")}\n${await readFile(path.join(projection.controlPlane, "events.jsonl"), "utf8")}`;
    assert.doesNotMatch(persisted, new RegExp(secret));
  } finally { delete process.env.WSSPEC_APPROVAL; }
});

test("recovery preserves completed approval history after projection corruption", async () => {
  const fixture = await prepare();
  const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "define", attemptId: "attempt-approval", artifactPath: fixture.artifactPath });
  await decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.equal(recovered.approvals[request.requestId]?.status, "approved");
  assert.equal(recovered.stages.define?.status, "succeeded");
});

test("recovery expires a pending approval and preserves its audit record", async () => {
  const fixture = await prepare();
  const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "define", attemptId: "attempt-approval", artifactPath: fixture.artifactPath });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.equal(recovered.approvals[request.requestId]?.status, "expired");
  assert.equal(recovered.workItem.status, "active");
  assert.equal(recovered.stages.define?.status, "ready");
});
