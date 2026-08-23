import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadApplicationState } from "../../src/application/state.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import {
  authorArtifact,
  completedResult,
  controlRuntimeFixture,
  requireExecute,
  retainOnlyReadyStage,
  rewriteSelectedSnapshot,
  submitPackage,
  worktreeFor,
} from "./helpers/control-runtime.js";

const specificationBody = [
  "# 规格",
  "",
  "## 目标与背景",
  "目标",
  "## 范围",
  "范围",
  "## 需求",
  "需求",
  "## 验收条件",
  "条件",
  "## 约束",
  "约束",
  "## 排除项",
  "无",
  "## 开放问题",
  "无",
  "",
].join("\n");

test("Profile 快照声明 Artifact 审批矩阵，而不是依赖固定阶段规则", async () => {
  const expected = {
    quick: [],
    standard: ["clarify", "design"],
    governed: ["clarify", "design", "plan"],
  } as const;

  for (const profileId of ["quick", "standard", "governed"] as const) {
    const fixture = await controlRuntimeFixture({ knowledgeTarget: profileId === "governed" });
    const started = await fixture.app.start({
      root: fixture.root,
      source: { type: "prompt", text: `${profileId} 审批矩阵` },
      profile: profileId,
    });
    const state = await loadApplicationState(fixture.root, started.workItemId);
    const profile = state.snapshot.profiles[profileId];
    const artifactApprovals = profile.steps
      .filter((step) => step.enabled && step.approval && step.outputs.length > 0)
      .map(({ id }) => id);
    assert.deepEqual(artifactApprovals, expected[profileId]);
  }
});

test("无 Artifact 的 Profile-required 动作仍形成绑定 workspace、digest 和 requester actor 的审批", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "无 Artifact 动作审批" },
    profile: "quick",
  });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const action = profile.steps.find(({ id }) => id === "clarify")!;
    Object.assign(action, { id: "publish-change", needs: [], inputs: [], outputs: [], approval: true, enabled: true });
    profile.steps = [action];
    profile.order = ["publish-change"];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, "publish-change");

  const workPackage = requireExecute(await fixture.app.acquire({
    root: fixture.root,
    workItemId: started.workItemId,
    actor: "release-author",
  }));
  const action = await submitPackage(fixture, workPackage, completedResult(workPackage, []));

  assert.equal(action.action, "await_approval");
  if (action.action !== "await_approval") throw new Error("expected approval");
  const projection = await readControlPlane(fixture.root, started.workItemId);
  const approval = projection.approvals[action.approval.requestId];
  assert.equal(approval?.stageId, "publish-change");
  assert.equal(approval?.requestedBy, "release-author");
  assert.match(approval?.contentHash ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(approval?.workspaceTreeDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(approval?.artifacts, []);
});

test("审批 decision actor 与精确绑定在事件恢复后保持不变", async () => {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "审批 Actor 恢复" },
    profile: "standard",
  });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    const clarify = profile.steps.find(({ id }) => id === "clarify")!;
    clarify.needs = [];
    clarify.inputs = [];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, "clarify");
  const workPackage = requireExecute(await fixture.app.acquire({
    root: fixture.root,
    workItemId: started.workItemId,
    actor: "spec-author",
  }));
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  const specification = await authorArtifact({
    fixture,
    worktree,
    workPackage,
    artifactType: "specification",
    body: specificationBody,
  });
  const awaiting = await submitPackage(fixture, workPackage, completedResult(workPackage, [specification]));
  assert.equal(awaiting.action, "await_approval");
  if (awaiting.action !== "await_approval") throw new Error("expected approval");

  await fixture.app.decide({
    kind: "approval",
    root: fixture.root,
    workItemId: started.workItemId,
    requestId: awaiting.approval.requestId,
    decision: "approved",
    expectedDigest: awaiting.approval.digest,
    actor: "product-owner",
  });
  const durable = await readControlPlane(fixture.root, started.workItemId);
  const decided = durable.approvals[awaiting.approval.requestId];
  assert.equal(decided?.requestedBy, "spec-author");
  assert.equal(decided?.decidedBy, "product-owner");
  assert.equal(decided?.status, "approved");
  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.deepEqual(recovered.approvals[awaiting.approval.requestId], decided);
  const events = await readFile(path.join(recovered.controlPlane, "events.jsonl"), "utf8");
  assert.match(events, /"actor":"product-owner"/u);
});
