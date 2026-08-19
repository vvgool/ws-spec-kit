import assert from "node:assert/strict";
import test from "node:test";

import { SchemaValidationError, validate, type SchemaId } from "../../src/schemas/index.js";

const workPackage = {
  version: 1,
  workItemId: "WSS-20260817-001",
  stepId: "implement",
  attemptId: "attempt-01",
  lease: {
    token: "lease-token",
    expiresAt: "2026-08-17T12:00:00+08:00",
  },
  objective: "按照批准的计划实现登录功能",
  skills: [
    {
      ref: "builtin://skills/tdd-implementation",
      version: "1.0.0",
      digest: "sha256:skill",
      description: "使用测试驱动开发实现当前任务",
    },
  ],
  artifacts: [
    {
      artifactType: "implementation-plan",
      schemaVersion: 1,
      path: ".wsspec/work-items/WSS-20260817-001/artifacts/plan.md",
      revision: 1,
      contentHash: "sha256:plan",
      mediaType: "text/markdown",
    },
  ],
  constraints: {
    allowedPaths: ["src/**", "tests/**"],
    forbiddenActions: ["push", "external-write"],
  },
  requiredOutputs: [
    {
      artifactType: "implementation-result",
      schemaVersion: 1,
    },
  ],
  gates: [
    {
      id: "unit-test",
      evidence: "trusted",
      required: true,
    },
  ],
  resultSchema: "builtin.submit-result.v1",
} as const;

function assertSchemaError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SchemaValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("AgentAction 只接受四种公开动作", () => {
  const actions = [
    { action: "execute", workPackage },
    {
      action: "await_approval",
      approval: {
        kind: "step",
        requestId: "approval-01",
        workItemId: "WSS-20260817-001",
        title: "批准方案设计",
        digest: "sha256:approval",
      },
    },
    {
      action: "blocked",
      problems: [{ code: "WSSPEC_SKILL_NOT_FOUND", message: "找不到绑定的 Skill", retryable: false }],
    },
    {
      action: "completed",
      summary: { workItemId: "WSS-20260817-001", status: "closed", message: "工作流已完成" },
    },
  ];

  for (const action of actions) {
    assert.deepEqual(validate("builtin.agent-action.v1" as SchemaId, action), action);
  }
  assertSchemaError(
    () => validate("builtin.agent-action.v1" as SchemaId, { action: "continue", workPackage }),
    "WSSPEC_SCHEMA_INVALID_VALUE",
  );
});

test("await_approval 的 step 与 workflow_trust variant 禁止外部动作字段", () => {
  const base = {
    action: "await_approval",
    approval: {
      kind: "step",
      requestId: "approval-01",
      workItemId: "WSS-20260817-001",
      title: "批准方案设计",
      digest: "sha256:approval",
    },
  } as const;
  const externalFields = {
    provider: "github",
    action: "issue.update",
    target: { kind: "issue", stableId: "github:example/project#42" },
    sideEffects: ["更新 Issue 正文"],
  };

  for (const kind of ["step", "workflow_trust"] as const) {
    assert.throws(
      () => validate("builtin.agent-action.v1" as SchemaId, {
        ...base,
        approval: { ...base.approval, kind, ...externalFields },
      }),
      (error: unknown) => error instanceof SchemaValidationError,
    );
  }

  const external = {
    ...base,
    approval: { ...base.approval, kind: "external_action", ...externalFields },
  };
  assert.deepEqual(validate("builtin.agent-action.v1" as SchemaId, external), external);
});

test("Work Package 只携带执行引用和约束", () => {
  assert.deepEqual(validate("builtin.work-package.v1" as SchemaId, workPackage), workPackage);

  for (const forbidden of ["conversationHistory", "prompt", "model"] as const) {
    assertSchemaError(
      () => validate("builtin.work-package.v1" as SchemaId, { ...workPackage, [forbidden]: [] }),
      "WSSPEC_SCHEMA_UNKNOWN_FIELD",
    );
  }
});

test("失败 SubmitResult 不接受 Agent 自报失败分类或 retryable", () => {
  const base = {
    version: 1,
    summary: "步骤执行失败",
    modifiedFiles: [],
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  };
  const failed = { ...base, status: "failed" };
  assert.deepEqual(validate("builtin.submit-result.v1" as SchemaId, failed), failed);

  const invalid = [
    [{ ...base, status: "failed", failureCode: "WSSPEC_STEP_INPUT_INVALID" }, "WSSPEC_SCHEMA_UNKNOWN_FIELD"],
    [{ ...base, status: "failed", failureCode: "WSSPEC_AGENT_DECIDES_RETRY" }, "WSSPEC_SCHEMA_UNKNOWN_FIELD"],
    [{ ...base, status: "failed", failureCode: "WSSPEC_STEP_FAILED", retryable: true }, "WSSPEC_SCHEMA_UNKNOWN_FIELD"],
    [{ ...base, status: "completed", failureCode: "WSSPEC_STEP_FAILED" }, "WSSPEC_SCHEMA_UNKNOWN_FIELD"],
  ] as const;
  for (const [value, code] of invalid) {
    assertSchemaError(() => validate("builtin.submit-result.v1" as SchemaId, value), code);
  }
});

test("StartInput 支持显式 Workflow，也允许交给项目 activeWorkflow", () => {
  const source = { type: "prompt", text: "增加登录功能" };
  const implicit = { root: "/workspace", source, profile: "auto" };
  const explicit = {
    ...implicit,
    workflowRef: "builtin://workflows/feature-delivery",
    profile: "standard",
  };

  assert.deepEqual(validate("builtin.application-start-input.v1" as SchemaId, implicit), implicit);
  assert.deepEqual(validate("builtin.application-start-input.v1" as SchemaId, explicit), explicit);
});

test("DecisionInput 只接受执行审批、Workflow Package 信任决定或外部只读协调", () => {
  const approval = {
    kind: "approval",
    root: "/workspace",
    workItemId: "WSS-20260817-001",
    requestId: "approval-01",
    decision: "approved",
    expectedDigest: "sha256:approval",
    actor: "user@example.com",
  };
  const workflowTrust = {
    kind: "workflow_trust",
    root: "/workspace",
    requestId: "trust-01",
    decision: "trusted",
    expectedPackageDigest: "sha256:package",
    expectedCapabilityDigest: "sha256:capability",
    actor: "user@example.com",
  };
  const externalReconciliation = {
    kind: "external_reconciliation",
    root: "/workspace",
    workItemId: "WSS-20260817-001",
    requestId: "external-request-01",
    actor: "user@example.com",
  };

  assert.deepEqual(validate("builtin.application-decision-input.v1" as SchemaId, approval), approval);
  assert.deepEqual(validate("builtin.application-decision-input.v1" as SchemaId, workflowTrust), workflowTrust);
  assert.deepEqual(validate("builtin.application-decision-input.v1" as SchemaId, externalReconciliation), externalReconciliation);
  assertSchemaError(
    () => validate("builtin.application-decision-input.v1" as SchemaId, { ...approval, kind: "profile_override" }),
    "WSSPEC_SCHEMA_INVALID_VALUE",
  );
});
