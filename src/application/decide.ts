import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { ApprovalError, decideArtifactApproval } from "../engine/approvals.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import type { AgentAction, DecisionInput } from "../protocol/application.js";
import { validate } from "../schemas/index.js";
import { readWorkflowTrustRequest } from "../storage/workflow-trust.js";
import { loadWorkflowPackage } from "../workflow-package/loader.js";
import { recordWorkflowTrust } from "../workflow-package/trust.js";
import { acquireApplication, type AcquireDependencies } from "./acquire.js";
import { adoptVerifiedExternalAction, approveExternalAction, markExternalActionFailed, reconcileExternalAction, rejectExternalAction } from "./external-action.js";
import { readControlPlane } from "../storage/control-plane.js";

export interface DecideDependencies extends AcquireDependencies {
  terminal: { isTTY?: boolean };
}

export class ApplicationDecisionError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ApplicationDecisionError";
  }
}

async function resetExpiredApproval(input: Extract<DecisionInput, { kind: "approval" }>): Promise<void> {
  await mutateControlPlane({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: `approval-reset:${input.requestId}`,
    actor: input.actor,
    operationInput: { requestId: input.requestId, reason: "expired" },
    mutate: (current) => {
      const approval = current.approvals[input.requestId];
      if (approval?.status !== "expired") throw new ApplicationDecisionError("WSSPEC_APPROVAL_NOT_PENDING", "审批请求未处于 expired 状态。 ");
      const stage = current.stages[approval.stageId];
      if (stage?.status !== "awaiting_approval") throw new ApplicationDecisionError("WSSPEC_APPROVAL_NOT_PENDING", "审批 Step 状态不一致。 ");
      const revision = transitionStage(stage, { type: "transition", to: "revision_required" });
      return {
        projection: {
          ...current,
          workItem: transitionWorkItem(current.workItem, { type: "transition", to: "active" }),
          stages: { ...current.stages, [approval.stageId]: transitionStage(revision, { type: "transition", to: "ready" }) },
        },
        value: undefined,
      };
    },
  });
}

export async function decideApplication(input: DecisionInput, dependencies: DecideDependencies): Promise<AgentAction> {
  validate("builtin.application-decision-input.v1", input);
  if (input.kind === "workflow_trust") {
    if (dependencies.terminal.isTTY !== true) {
      throw new ApplicationDecisionError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "Workflow Package 信任决定必须来自真实交互式 TTY。 ");
    }
    const request = await readWorkflowTrustRequest(input.root, input.requestId);
    if (request === undefined) throw new ApplicationDecisionError("WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID", "Workflow 信任请求不存在。 ");
    const pkg = await loadWorkflowPackage({ root: input.root, ref: request.packageRef });
    await recordWorkflowTrust({
      root: input.root,
      pkg,
      decision: input.decision,
      actor: input.actor,
      requestId: input.requestId,
      expectedPackageDigest: input.expectedPackageDigest,
      expectedCapabilityDigest: input.expectedCapabilityDigest,
    });
    return input.decision === "trusted"
      ? { action: "blocked", problems: [{ code: "WSSPEC_WORKFLOW_TRUST_RECORDED", message: "已记录 Workflow 信任决定，请重新执行 start。", retryable: true }] }
      : { action: "blocked", problems: [{ code: "WSSPEC_WORKFLOW_TRUST_REJECTED", message: "Workflow Package 已被拒绝。", retryable: false }] };
  }

  if (input.kind === "external_reconciliation") {
    const projection = await readControlPlane(input.root, input.workItemId);
    const state = projection.externalActions[input.requestId];
    if (state === undefined) throw new ApplicationDecisionError("WSSPEC_EXTERNAL_REQUEST_NOT_FOUND", "外部动作请求不存在。 ");
    if (state.request.requestDigest !== input.expectedDigest) {
      throw new ApplicationDecisionError("WSSPEC_EXTERNAL_REQUEST_DIGEST_MISMATCH", "协调恢复决定未绑定当前 Request 摘要。 ");
    }
    if (input.decision === "mark_failed") {
      await markExternalActionFailed({
        root: input.root,
        workItemId: input.workItemId,
        requestId: input.requestId,
        expectedRequestDigest: input.expectedDigest,
        evidence: input.evidence,
        actor: input.actor,
        now: dependencies.now().toISOString(),
        terminal: dependencies.terminal,
      });
    } else if (input.decision === "adopt_verified") {
      await adoptVerifiedExternalAction({
        root: input.root,
        workItemId: input.workItemId,
        requestId: input.requestId,
        expectedRequestDigest: input.expectedDigest,
        externalStableId: input.externalStableId,
        contentDigest: input.contentDigest,
        evidence: input.evidence,
        actor: input.actor,
        now: dependencies.now().toISOString(),
        terminal: dependencies.terminal,
        executor: dependencies.externalExecutor(state.request.provider, state.request.action),
      });
    } else {
      await reconcileExternalAction({
        root: input.root,
        workItemId: input.workItemId,
        requestId: input.requestId,
        executor: dependencies.externalExecutor(state.request.provider, state.request.action),
        now: dependencies.now().toISOString(),
      });
    }
    return acquireApplication({ root: input.root, workItemId: input.workItemId, actor: input.actor }, dependencies);
  }

  if (input.kind === "external_action") {
    if (input.decision === "rejected") {
      await rejectExternalAction({
        root: input.root,
        workItemId: input.workItemId,
        requestId: input.requestId,
        expectedRequestDigest: input.expectedDigest,
        actor: input.actor,
        rejectedAt: dependencies.now().toISOString(),
        terminal: dependencies.terminal,
      });
      return acquireApplication({ root: input.root, workItemId: input.workItemId, actor: input.actor }, dependencies);
    }
    const projection = await readControlPlane(input.root, input.workItemId);
    const state = projection.externalActions[input.requestId];
    if (state === undefined) throw new ApplicationDecisionError("WSSPEC_EXTERNAL_REQUEST_NOT_FOUND", "外部动作请求不存在。 ");
    const decidedAt = dependencies.now().toISOString();
    await approveExternalAction({
      root: input.root,
      workItemId: input.workItemId,
      requestId: input.requestId,
      expectedRequestDigest: input.expectedDigest,
      actor: input.actor,
      approvalDigest: input.expectedDigest as `sha256:${string}`,
      profile: state.request.profile,
      profileDigest: state.request.profileDigest,
      workspaceDigest: state.request.workspaceDigest,
      configDigest: state.request.configDigest,
      decidedAt,
      expiresAt: state.request.expiresAt,
      terminal: dependencies.terminal,
    });
    return acquireApplication({ root: input.root, workItemId: input.workItemId, actor: input.actor }, dependencies);
  }

  try {
    await decideArtifactApproval({
      cwd: input.root,
      workItemId: input.workItemId,
      requestId: input.requestId,
      decision: input.decision === "approved" ? "approve" : "reject",
      terminal: dependencies.terminal,
      actor: input.actor,
      expectedDigest: input.expectedDigest,
    });
  } catch (error) {
    if (!(error instanceof ApprovalError) || error.code !== "WSSPEC_APPROVAL_EXPIRED") throw error;
    await resetExpiredApproval(input);
  }
  return acquireApplication({ root: input.root, workItemId: input.workItemId, actor: input.actor }, dependencies);
}
