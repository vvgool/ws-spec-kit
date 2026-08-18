import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadApplicationState, type SnapshotProfile } from "../../src/application/state.js";
import { sha256 } from "../../src/domain/digests.js";
import { closeChecklist } from "../../src/engine/archive.js";
import type { TrustedEvidence } from "../../src/engine/tdd/types.js";
import {
  evidenceProjectionKey,
  evidenceRecordHash,
  recordGateEvidence,
  type GateEvidence,
} from "../../src/engine/verification.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import type { RuntimeProjection } from "../../src/storage/control-plane.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { readEvents, withControlPlaneLock } from "../../src/storage/events.js";
import {
  controlRuntimeFixture,
  rewriteSelectedSnapshot,
  worktreeFor,
} from "./helpers/control-runtime.js";
import { git } from "./helpers/git.js";

function trustedTddEvidence(phase: "red" | "green", overrides: Partial<TrustedEvidence> = {}): TrustedEvidence {
  const unsigned: Omit<TrustedEvidence, "evidenceId"> = {
    level: "trusted" as const,
    phase,
    taskId: "WSS-CLOSE",
    stepId: phase === "red" ? "verify-red" : "verify-green",
    commandId: "test",
    commandDigest: "sha256:command",
    exitCode: phase === "red" ? 1 : 0,
    failedTests: phase === "red" ? ["feature is red"] : [],
    testPaths: ["tests/feature.test.mjs"],
    testFiles: [{ path: "tests/feature.test.mjs", digest: "sha256:test" }],
    testPathsDigest: "sha256:test-paths",
    testPathRules: ["node"],
    workspaceDigest: phase === "red" ? "sha256:red-workspace" : "sha256:workspace",
    summary: phase === "red" ? "feature is red" : "all tests passed",
    ...overrides,
  };
  return {
    evidenceId: `evidence-${sha256(`${JSON.stringify(unsigned)}\n`).slice("sha256:".length)}`,
    ...unsigned,
  };
}

function evidence(input: Partial<GateEvidence> = {}): GateEvidence {
  const unsigned = {
    evidenceId: input.evidenceId ?? "evidence-test",
    level: input.level ?? "trusted",
    gateId: input.gateId ?? "test",
    codeRevision: input.codeRevision ?? "revision-1",
    baselineTreeDigest: input.baselineTreeDigest ?? "sha256:baseline",
    workspaceTreeDigest: input.workspaceTreeDigest ?? "sha256:workspace",
    configDigest: input.configDigest ?? "sha256:config",
    attemptId: input.attemptId ?? "attempt-check",
    result: input.result ?? "passed",
  } as const;
  return { ...unsigned, recordHash: evidenceRecordHash(unsigned) };
}

function projection(overrides: Partial<RuntimeProjection> = {}): RuntimeProjection {
  return {
    version: 1,
    repositoryId: "repo-test",
    workItemId: "WSS-CLOSE",
    workItem: { status: "active" },
    stages: {},
    lastSequence: 0,
    lastEventHash: null,
    idempotency: {},
    profile: {
      mode: "quick",
      selected: "quick",
      provisional: false,
      reasonRuleIds: [],
      riskSignals: { levels: [], affectedPaths: [], modifiedPaths: [], issueLabels: [], fileTypes: [], plannedActions: [] },
    },
    claims: {},
    contexts: {},
    approvals: {},
    evidence: {},
    loops: {},
    retries: {},
    readOnly: false,
    controlPlane: "/tmp/wsspec-close",
    ...overrides,
  };
}

function profile(id: "quick" | "standard" | "governed", gates: string[]): SnapshotProfile {
  return {
    id,
    order: ["author-proposal", "quality-check", "publish-result", "seal-work"],
    steps: [
      {
        id: "author-proposal", uses: "agent.execute", securityClass: "agent", needs: [], enabled: true,
        skills: [], inputs: [], outputs: [{ artifact: "proposal", required: true }], gates: [], approval: true,
        authorizationRequired: false, steps: [],
      },
      {
        id: "quality-check", uses: "command.execute", securityClass: "local-write", needs: ["author-proposal"], enabled: true,
        skills: [], inputs: [], outputs: [], gates, approval: false, authorizationRequired: false, steps: [],
      },
      {
        id: "publish-result", uses: "connector.execute", securityClass: "external-write", needs: ["quality-check"], enabled: true,
        skills: [], inputs: [], outputs: [], gates: [], approval: false, authorizationRequired: true, steps: [],
      },
      {
        id: "seal-work", uses: "control.close", securityClass: "control", needs: ["publish-result"], enabled: true,
        skills: [], inputs: [], outputs: [], gates: [], approval: false, authorizationRequired: false, steps: [],
      },
    ],
    publishing: { issueRequired: id === "governed", knowledgeRequired: id === "governed", readBackRequired: id === "governed" },
    audit: { level: id === "governed" ? "complete" : "standard" },
    changePolicy: { kind: "feature", allowedPaths: ["**"], digest: "sha256:policy" },
  };
}

const proposalArtifact = {
  artifactType: "proposal",
  schemaVersion: 1,
  path: "proposal.md",
  revision: 1,
  contentHash: "sha256:proposal",
  mediaType: "text/markdown",
};

function approvalReadyProjection(approval: Record<string, unknown>): RuntimeProjection {
  return projection({
    stages: {
      "author-proposal": { status: "succeeded" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
    contexts: {
      "author-proposal": {
        workPackage: { attemptId: "attempt-author" },
        actor: "author",
        result: { status: "completed", artifacts: [proposalArtifact] },
      },
    },
    approvals: {
      approval: {
        requestId: "approval",
        stageId: "author-proposal",
        attemptId: "attempt-author",
        contentHash: "sha256:proposal",
        artifacts: [proposalArtifact],
        artifactPath: "proposal.md",
        workspaceTreeDigest: "sha256:approved",
        status: "approved",
        requestedBy: "author",
        decidedBy: "owner",
        createdAt: "2026-08-18T00:00:00.000Z",
        decidedAt: "2026-08-18T00:01:00.000Z",
        ...approval,
      },
    },
  });
}

test("Close 逐项分类 step、artifact、approval、evidence 和 external receipt", () => {
  const selected = profile("governed", ["test", "lint"]);
  const current = projection({
    profile: { ...projection().profile, mode: "governed", selected: "governed" },
    stages: {
      "author-proposal": { status: "succeeded" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "pending" },
      "seal-work": { status: "ready" },
    },
  });

  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: ["test"], configuredGateIds: ["test", "lint"] },
    gates: [
      { id: "test", evidence: "trusted" },
      { id: "lint", evidence: "trusted" },
    ],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.missing, [
    { category: "step", id: "publish-result" },
    { category: "artifact", id: "proposal" },
    { category: "approval", id: "author-proposal" },
    { category: "evidence", id: "lint" },
    { category: "evidence", id: "test" },
    { category: "external-receipt", id: "issue" },
    { category: "external-receipt", id: "knowledge" },
  ]);
});

test("Close requires a schema-valid linked Red and Green TDD evidence chain", () => {
  const selected = profile("quick", []);
  selected.order = ["verify-red", "verify-green", "close"];
  selected.steps = [
    {
      id: "verify-red", uses: "command.execute", securityClass: "local-write", needs: [], enabled: true,
      skills: [], inputs: [], outputs: [{ artifact: "red-evidence", required: true }], gates: [], approval: false,
      authorizationRequired: false, action: "quality.test", expectedOutcome: "test-failure", steps: [],
    },
    {
      id: "verify-green", uses: "command.execute", securityClass: "local-write", needs: ["verify-red"], enabled: true,
      skills: [], inputs: [{ artifact: "red-evidence", required: true }], outputs: [{ artifact: "tdd-evidence", required: true }],
      gates: [], approval: false, authorizationRequired: false, action: "quality.test", expectedOutcome: "success", steps: [],
    },
    {
      id: "close", uses: "control.close", securityClass: "control", needs: ["verify-green"], enabled: true,
      skills: [], inputs: [], outputs: [], gates: [], approval: false, authorizationRequired: false, steps: [],
    },
  ];
  const current = projection({
    stages: { "verify-red": { status: "succeeded" }, "verify-green": { status: "succeeded" }, close: { status: "ready" } },
    contexts: {
      "verify-red": { workPackage: { attemptId: "attempt-red" }, result: { status: "completed", artifacts: [] } },
      "verify-green": { workPackage: { attemptId: "attempt-green" }, result: { status: "completed", artifacts: [] } },
    },
    evidence: { "tdd:WSS-CLOSE:red": {}, "tdd:WSS-CLOSE:cycle": {} },
  });
  const input = {
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  };

  assert.deepEqual(closeChecklist(input).missing.filter(({ category }) => category === "artifact"), [
    { category: "artifact", id: "red-evidence" },
    { category: "artifact", id: "tdd-evidence" },
  ]);

  const red = trustedTddEvidence("red");
  const green = trustedTddEvidence("green");
  const cycle = {
    taskId: "WSS-CLOSE",
    testPaths: [...red.testPaths],
    testPathRules: [...red.testPathRules],
    commandId: red.commandId,
    redEvidenceId: red.evidenceId,
    greenEvidenceId: green.evidenceId,
  };
  current.evidence = {
    "tdd:WSS-CLOSE:red": red,
    "tdd:WSS-CLOSE:cycle": cycle,
    [`tdd:WSS-CLOSE:green:${green.evidenceId}`]: green,
  };
  assert.equal(closeChecklist(input).allowed, true);

  current.evidence[`tdd:WSS-CLOSE:green:${green.evidenceId}`] = trustedTddEvidence("green", { commandDigest: "sha256:other" });
  assert.deepEqual(closeChecklist(input).missing.filter(({ category }) => category === "artifact"), [
    { category: "artifact", id: "tdd-evidence" },
  ]);
});

test("Gate 集合随 Profile 增强，且只接受当前 workspace/config 的 passed Evidence", () => {
  const base = projection({
    stages: {
      "author-proposal": { status: "succeeded" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
    contexts: {
      "author-proposal": {
        workPackage: { attemptId: "attempt-author" },
        actor: "author",
        result: { status: "completed", artifacts: [{ artifactType: "proposal", contentHash: "sha256:proposal" }] },
      },
      "quality-check": {
        workPackage: { attemptId: "attempt-check" },
        actor: "gate-service",
        result: { status: "completed", artifacts: [] },
      },
    },
    approvals: {
      approval: {
        requestId: "approval", stageId: "author-proposal", attemptId: "attempt-author", contentHash: "sha256:proposal",
        artifacts: [{ artifactType: "proposal", schemaVersion: 1, path: "proposal.md", revision: 1, contentHash: "sha256:proposal" }],
        artifactPath: "proposal.md", workspaceTreeDigest: "sha256:approved", status: "approved",
        requestedBy: "author", decidedBy: "owner", createdAt: "2026-08-18T00:00:00.000Z", decidedAt: "2026-08-18T00:01:00.000Z",
      },
    },
  });
  const policy = { requiredGateIds: ["test"], configuredGateIds: ["test", "lint"] };
  const freshTest = evidence();
  const staleLint = evidence({ evidenceId: "evidence-lint", gateId: "lint", workspaceTreeDigest: "sha256:old" });

  const quick = closeChecklist({
    profile: profile("quick", []), projection: base, gatePolicy: policy,
    gates: [{ id: "test", evidence: "trusted" }, { id: "lint", evidence: "trusted" }],
    workspaceTreeDigest: "sha256:workspace", configDigest: "sha256:config",
  });
  assert.deepEqual(quick.missing.filter(({ category }) => category === "evidence"), []);

  const standard = closeChecklist({
    profile: profile("standard", ["test"]),
    projection: { ...base, evidence: { [evidenceProjectionKey("quality-check", "test")]: freshTest } },
    gates: [{ id: "test", evidence: "trusted" }, { id: "lint", evidence: "trusted" }],
    gatePolicy: policy, workspaceTreeDigest: "sha256:workspace", configDigest: "sha256:config",
  });
  assert.deepEqual(standard.missing.filter(({ category }) => category === "evidence"), []);

  const governed = closeChecklist({
    profile: profile("governed", ["test", "lint"]),
    projection: {
      ...base,
      evidence: {
        bindings: { issue: { exists: true }, knowledge: { exists: true } },
        [evidenceProjectionKey("quality-check", "test")]: freshTest,
        [evidenceProjectionKey("quality-check", "lint")]: staleLint,
        "external-receipt:issue": { kind: "external-receipt", target: "issue", status: "confirmed", readBack: true },
        "external-receipt:knowledge": { kind: "external-receipt", target: "knowledge", status: "confirmed", readBack: true },
      },
    },
    gates: [{ id: "test", evidence: "trusted" }, { id: "lint", evidence: "trusted" }],
    gatePolicy: policy, workspaceTreeDigest: "sha256:workspace", configDigest: "sha256:config",
  });
  assert.deepEqual(governed.missing.filter(({ category }) => category === "evidence"), [{ category: "evidence", id: "lint" }]);
});

test("Close 要求 approved Approval 同时保留 requester 和 decider actor", () => {
  const current = approvalReadyProjection({ requestedBy: undefined });
  const decision = closeChecklist({
    profile: profile("quick", []),
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing.filter(({ category }) => category === "approval"), [
    { category: "approval", id: "author-proposal" },
  ]);
});

test("Close 比较 Approval 与 Attempt 的完整 Artifact 数组而不是单 Artifact digest", () => {
  const current = approvalReadyProjection({
    artifacts: [{ ...proposalArtifact, path: "approved-proposal.md" }],
    artifactPath: "approved-proposal.md",
  });
  const decision = closeChecklist({
    profile: profile("quick", []),
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing.filter(({ category }) => category === "approval"), [
    { category: "approval", id: "author-proposal" },
  ]);
});

test("Close 对 Approval 已规范化的多 Artifact 顺序不产生伪差异", () => {
  const supportingArtifact = {
    artifactType: "supporting",
    schemaVersion: 1,
    path: "supporting.md",
    revision: 1,
    contentHash: "sha256:supporting",
    mediaType: "text/markdown",
  };
  const current = approvalReadyProjection({
    artifacts: [proposalArtifact, supportingArtifact],
    contentHash: "sha256:6d4832a91e74c61f26159fbe69d51852a15e9c2f1af4346aa36204a521170667",
  });
  const attempt = current.contexts["author-proposal"] as { result: { artifacts: unknown[] } };
  attempt.result.artifacts = [supportingArtifact, proposalArtifact];
  const decision = closeChecklist({
    profile: profile("quick", []),
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing.filter(({ category }) => category === "approval"), []);
});

test("Close 不要求已跳过条件 Step 的 Artifact 或 Approval", () => {
  const selected = profile("quick", []);
  selected.steps[0]!.when = "${bindings.issue.exists}";
  const current = projection({
    stages: {
      "author-proposal": { status: "skipped" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
  });
  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing, []);
});

test("Close 不要求循环内已跳过条件 Step 的 Artifact 或 Approval", () => {
  const selected = profile("quick", []);
  selected.steps[0]!.outputs = [];
  selected.steps[0]!.approval = false;
  selected.steps[1]!.steps = [{
    id: "conditional-output",
    uses: "agent.execute",
    securityClass: "agent",
    needs: [],
    enabled: true,
    skills: [],
    inputs: [],
    outputs: [{ artifact: "conditional-result", required: true }],
    gates: [],
    approval: true,
    authorizationRequired: false,
    when: "${artifacts.review-result.approved == false}",
    steps: [],
  }];
  const current = projection({
    stages: {
      "author-proposal": { status: "succeeded" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
    contexts: {
      "quality-check:1:conditional-output": {
        stepInstanceId: "quality-check:1:conditional-output",
        skipped: true,
      },
    },
  });
  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing, []);
});

test("PARENT_SKIP: Close 不要求已跳过父循环的子 Artifact、Approval 或 Gate", () => {
  const selected = profile("quick", []);
  const parent = {
    ...selected.steps[1]!,
    id: "optional-loop",
    uses: "control.loop",
    needs: [],
    gates: [],
    steps: [{
      id: "child-requirements",
      uses: "agent.execute",
      securityClass: "agent" as const,
      needs: [],
      enabled: true,
      skills: [],
      inputs: [],
      outputs: [{ artifact: "child-output", required: true }],
      gates: ["child-gate"],
      approval: true,
      authorizationRequired: false,
      steps: [],
    }],
  };
  const close = { ...selected.steps.at(-1)!, id: "close", needs: ["optional-loop"] };
  selected.steps = [parent, close];
  selected.order = ["optional-loop", "close"];
  const current = projection({
    stages: {
      "optional-loop": { status: "skipped" },
      close: { status: "ready" },
    },
  });

  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: ["child-gate"] },
    gates: [{ id: "child-gate", evidence: "trusted" }],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing, []);
});

test("STEP_GATE_SKIP: Close 不要求已跳过顶层 Step 的 Gate", () => {
  const selected = profile("quick", ["test"]);
  selected.steps[0]!.outputs = [];
  selected.steps[0]!.approval = false;
  const current = projection({
    stages: {
      "author-proposal": { status: "skipped" },
      "quality-check": { status: "skipped" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
  });

  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: ["test"] },
    gates: [{ id: "test", evidence: "trusted" }],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing, []);
});

test("OLD_ATTEMPT: Close 拒绝同一 Step 上不属于当前 Attempt 的 Gate Evidence", () => {
  const selected = profile("quick", ["test"]);
  selected.steps[0]!.outputs = [];
  selected.steps[0]!.approval = false;
  const current = projection({
    stages: {
      "author-proposal": { status: "succeeded" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
    contexts: {
      "quality-check": {
        workPackage: { attemptId: "attempt-current" },
        actor: "gate-service",
        result: { status: "completed", artifacts: [] },
      },
    },
    evidence: {
      [evidenceProjectionKey("quality-check", "test")]: evidence({ attemptId: "attempt-old" }),
    },
  });

  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: ["test"] },
    gates: [{ id: "test", evidence: "trusted" }],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing.filter(({ category }) => category === "evidence"), [
    { category: "evidence", id: "test" },
  ]);
});

test("Close 要求每个声明同名 Gate 的 Step instance 都有自身 Evidence", () => {
  const selected = profile("quick", ["test"]);
  const first = { ...selected.steps[1]!, id: "first-check", needs: [], gates: ["test"] };
  const second = { ...selected.steps[1]!, id: "second-check", needs: ["first-check"], gates: ["test"] };
  const close = { ...selected.steps.at(-1)!, id: "close", needs: ["second-check"] };
  selected.steps = [first, second, close];
  selected.order = ["first-check", "second-check", "close"];
  const current = projection({
    stages: {
      "first-check": { status: "succeeded" },
      "second-check": { status: "succeeded" },
      close: { status: "ready" },
    },
    contexts: {
      "first-check": {
        workPackage: { attemptId: "attempt-first" },
        actor: "gate-service",
        result: { status: "completed", artifacts: [] },
      },
      "second-check": {
        workPackage: { attemptId: "attempt-second" },
        actor: "gate-service",
        result: { status: "completed", artifacts: [] },
      },
    },
    evidence: {
      [evidenceProjectionKey("first-check", "test")]: evidence({ attemptId: "attempt-first" }),
    },
  });
  const input = {
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: ["test"] },
    gates: [{ id: "test", evidence: "trusted" as const }],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  };

  assert.deepEqual(closeChecklist(input).missing.filter(({ category }) => category === "evidence"), [
    { category: "evidence", id: "test" },
  ]);
  current.evidence[evidenceProjectionKey("second-check", "test")] = evidence({
    evidenceId: "evidence-second",
    attemptId: "attempt-second",
  });
  assert.deepEqual(closeChecklist(input).missing.filter(({ category }) => category === "evidence"), []);
});

test("RENAMED_REVIEW: Governed Close 按角色而不是固定 Step ID 校验独立 Review", () => {
  const selected = profile("governed", []);
  selected.publishing = { issueRequired: false, knowledgeRequired: false, readBackRequired: false };
  const implementation = {
    ...selected.steps[0]!,
    id: "build-feature",
    actorRole: "implementation" as const,
    outputs: [],
    approval: false,
  };
  const auditCycle = {
    ...selected.steps[1]!,
    id: "audit-cycle",
    uses: "control.loop",
    needs: ["build-feature"],
    independentReviewActor: true,
    steps: [{
      id: "audit-work",
      actorRole: "review" as const,
      uses: "agent.execute",
      securityClass: "agent" as const,
      needs: [],
      enabled: true,
      skills: [],
      inputs: [],
      outputs: [],
      gates: [],
      approval: false,
      authorizationRequired: false,
      steps: [],
    }],
  };
  const close = { ...selected.steps.at(-1)!, id: "close", needs: ["audit-cycle"] };
  selected.steps = [implementation, auditCycle, close];
  selected.order = ["build-feature", "audit-cycle", "close"];
  const current = projection({
    profile: { ...projection().profile, mode: "governed", selected: "governed" },
    stages: {
      "build-feature": { status: "succeeded" },
      "audit-cycle": { status: "succeeded" },
      close: { status: "ready" },
    },
    contexts: {
      "build-feature": {
        workPackage: { attemptId: "attempt-build" },
        actor: "author",
        result: { status: "completed", artifacts: [] },
      },
      "audit-cycle:1:audit-work": {
        workPackage: { attemptId: "attempt-audit" },
        actor: "independent-reviewer",
        result: { status: "completed", artifacts: [] },
      },
    },
    loops: { "audit-cycle": { loopId: "audit-cycle", iteration: 1, maxIterations: 5, status: "succeeded" } },
  });

  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.missing, []);
});

test("Close 对相同 category/id 的缺失项只报告一次", () => {
  const selected = profile("quick", []);
  selected.steps.splice(1, 0, {
    id: "duplicate-output",
    uses: "agent.execute",
    securityClass: "agent",
    needs: [],
    enabled: true,
    skills: [],
    inputs: [],
    outputs: [{ artifact: "proposal", required: true }],
    gates: [],
    approval: false,
    authorizationRequired: false,
    steps: [],
  });
  selected.order.splice(1, 0, "duplicate-output");
  const current = projection({
    stages: {
      "author-proposal": { status: "succeeded" },
      "duplicate-output": { status: "succeeded" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
  });
  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing.filter(({ category }) => category === "artifact"), [
    { category: "artifact", id: "proposal" },
  ]);
});

test("Close 按 Application Snapshot 的 Gate 信任级别接受 attested Evidence", () => {
  const selected = profile("quick", ["policy-check"]);
  selected.steps[0]!.outputs = [];
  selected.steps[0]!.approval = false;
  const current = projection({
    stages: {
      "author-proposal": { status: "succeeded" },
      "quality-check": { status: "succeeded" },
      "publish-result": { status: "succeeded" },
      "seal-work": { status: "ready" },
    },
    evidence: {
      [evidenceProjectionKey("quality-check", "policy-check")]: evidence({
        gateId: "policy-check",
        level: "attested",
      }),
    },
    contexts: {
      "quality-check": {
        workPackage: { attemptId: "attempt-check" },
        actor: "gate-service",
        result: { status: "completed", artifacts: [] },
      },
    },
  });
  const decision = closeChecklist({
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: ["policy-check"] },
    gates: [{ id: "policy-check", evidence: "attested" }],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  });

  assert.deepEqual(decision.missing.filter(({ category }) => category === "evidence"), []);
});

test("Governed Close 防御性拒绝由实现 Actor 完成的独立 Review", () => {
  const selected = profile("governed", []);
  selected.publishing = { issueRequired: false, knowledgeRequired: false, readBackRequired: false };
  const implement = { ...selected.steps[0]!, id: "implement", actorRole: "implementation" as const, outputs: [], approval: false };
  const reviewFix = {
    ...selected.steps[1]!,
    id: "review-fix",
    uses: "control.loop",
    needs: ["implement"],
    independentReviewActor: true,
    steps: [{
      id: "review",
      actorRole: "review" as const,
      uses: "agent.execute",
      securityClass: "agent" as const,
      needs: [],
      enabled: true,
      skills: [],
      inputs: [],
      outputs: [],
      gates: [],
      approval: false,
      authorizationRequired: false,
      steps: [],
    }],
  };
  const close = { ...selected.steps.at(-1)!, id: "close", needs: ["review-fix"] };
  selected.steps = [implement, reviewFix, close];
  selected.order = ["implement", "review-fix", "close"];
  const current = projection({
    profile: { ...projection().profile, mode: "governed", selected: "governed" },
    stages: {
      implement: { status: "succeeded" },
      "review-fix": { status: "succeeded" },
      close: { status: "ready" },
    },
    contexts: {
      implement: { workPackage: { attemptId: "attempt-implement" }, actor: "author", result: { status: "completed", artifacts: [] } },
      "review-fix:1:review": { workPackage: { attemptId: "attempt-review" }, actor: "author", result: { status: "completed", artifacts: [] } },
    },
    loops: { "review-fix": { loopId: "review-fix", iteration: 1, maxIterations: 5, status: "succeeded" } },
  });
  const input = {
    profile: selected,
    projection: current,
    gatePolicy: { requiredGateIds: [], configuredGateIds: [] },
    gates: [],
    workspaceTreeDigest: "sha256:workspace",
    configDigest: "sha256:config",
  };

  assert.deepEqual(closeChecklist(input).missing.filter(({ category }) => category === "step"), [
    { category: "step", id: "review-fix" },
  ]);
  (current.contexts["review-fix:1:review"] as { actor: string }).actor = "independent-reviewer";
  assert.equal(closeChecklist(input).allowed, true);
});

async function prepareCloseFixture() {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "Close Gate freshness" },
    workflowRef: "builtin://workflows/documentation-delivery",
    profile: "quick",
  });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (selected) => {
    const verify = selected.steps.find(({ id }) => id === "verify-document")!;
    const close = selected.steps.find(({ id }) => id === "close")!;
    Object.assign(verify, { id: "quality-check", needs: [], inputs: [], outputs: [], gates: ["docs.integrity"], approval: false, enabled: true });
    Object.assign(close, { id: "seal-work", needs: ["quality-check"], approval: false, enabled: true });
    selected.steps = [verify, close];
    selected.order = ["quality-check", "seal-work"];
  });
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:prepare-close",
    operationInput: {},
    mutate: (current) => ({
      projection: {
        ...current,
        stages: { "quality-check": { status: "succeeded" }, "seal-work": { status: "ready" } },
        contexts: {
          "quality-check": {
            workPackage: { attemptId: "attempt-quality-check" },
            actor: "gate-service",
            result: { status: "completed", artifacts: [] },
          },
        },
      },
      value: null,
    }),
  });
  return { fixture, started };
}

test("control.close 在必需 Gate 缺失时 blocked，Fresh Evidence 到齐后才关闭并可恢复归档", async () => {
  const { fixture, started } = await prepareCloseFixture();
  const blocked = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "closer" });
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") throw new Error("expected blocked close");
  assert.ok(blocked.problems.some(({ code }) => code === "WSSPEC_CLOSE_CHECKLIST_INCOMPLETE"));
  const blockedProjection = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(blockedProjection.workItem.status, "blocked");
  const blockedEvent = (await readEvents(blockedProjection.controlPlane)).at(-1);
  assert.equal(blockedEvent?.eventType, "evidence.recorded");
  assert.deepEqual((blockedEvent?.result as { closeDecision?: unknown }).closeDecision, {
    allowed: false,
    missing: [{ category: "evidence", id: "docs.integrity" }],
  });

  const state = await loadApplicationState(fixture.root, started.workItemId);
  const workspaceTreeDigest = await import("../../src/domain/digests.js").then(({ computeWorkspaceTreeDigest }) => computeWorkspaceTreeDigest(state.worktree));
  const record = evidence({
    evidenceId: "evidence-docs-integrity",
    gateId: "docs.integrity",
    codeRevision: await git(state.worktree, "rev-parse", "HEAD"),
    baselineTreeDigest: state.item.execution.baselineTreeDigest,
    workspaceTreeDigest,
    configDigest: state.item.execution.configDigest,
    attemptId: "attempt-quality-check",
  });
  await recordGateEvidence({
    cwd: fixture.root,
    workItemId: started.workItemId,
    stageId: "quality-check",
    actor: "gate-service",
    evidence: record,
  });

  const completed = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "closer" });
  assert.equal(completed.action, "completed");
  if (completed.action !== "completed") throw new Error("expected completed close");
  assert.equal(completed.summary.status, "closed");
  const durable = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(durable.workItem.status, "closed");
  assert.ok((await readEvents(durable.controlPlane)).some(({ eventType }) => eventType === "work-item.closed"));
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  await access(path.join(worktree, ".wsspec", "archive", started.workItemId, "audit.json"));
  await writeFile(path.join(durable.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: started.workItemId });
  assert.equal(recovered.workItem.status, "closed");
});

test("workspace 在 Gate 后变化会使 Evidence 失效并阻止 Close", async () => {
  const { fixture, started } = await prepareCloseFixture();
  const state = await loadApplicationState(fixture.root, started.workItemId);
  const { computeWorkspaceTreeDigest } = await import("../../src/domain/digests.js");
  const record = evidence({
    evidenceId: "evidence-before-change",
    gateId: "docs.integrity",
    codeRevision: await git(state.worktree, "rev-parse", "HEAD"),
    baselineTreeDigest: state.item.execution.baselineTreeDigest,
    workspaceTreeDigest: await computeWorkspaceTreeDigest(state.worktree),
    configDigest: state.item.execution.configDigest,
    attemptId: "attempt-quality-check",
  });
  await recordGateEvidence({
    cwd: fixture.root,
    workItemId: started.workItemId,
    stageId: "quality-check",
    actor: "gate-service",
    evidence: record,
  });
  await writeFile(path.join(state.worktree, "changed-after-gate.txt"), "changed\n", "utf8");

  const blocked = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "closer" });
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") throw new Error("expected blocked close");
  assert.ok(blocked.problems.some(({ message }) => message.includes("evidence:docs.integrity")));
  const persisted = await readFile(path.join((await readControlPlane(fixture.root, started.workItemId)).controlPlane, "events.jsonl"), "utf8");
  assert.match(persisted, /evidence-before-change/u);
});

test("recordGateEvidence 在取得控制面锁后重新校验 workspace freshness", async () => {
  const { fixture, started } = await prepareCloseFixture();
  const state = await loadApplicationState(fixture.root, started.workItemId);
  const { computeWorkspaceTreeDigest } = await import("../../src/domain/digests.js");
  const record = evidence({
    evidenceId: "evidence-lock-race",
    gateId: "docs.integrity",
    codeRevision: await git(state.worktree, "rev-parse", "HEAD"),
    baselineTreeDigest: state.item.execution.baselineTreeDigest,
    workspaceTreeDigest: await computeWorkspaceTreeDigest(state.worktree),
    configDigest: state.item.execution.configDigest,
    attemptId: "attempt-quality-check",
  });
  let recording: Promise<GateEvidence> | undefined;
  await withControlPlaneLock(state.projection.controlPlane, async () => {
    recording = recordGateEvidence({
      cwd: fixture.root,
      workItemId: started.workItemId,
      stageId: "quality-check",
      actor: "gate-service",
      evidence: record,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await writeFile(path.join(state.worktree, "changed-before-evidence-lock.txt"), "changed\n", "utf8");
  });
  assert.ok(recording);

  await assert.rejects(
    recording,
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WSSPEC_EVIDENCE_STALE",
  );
});
