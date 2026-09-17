import { transitionStage } from "../domain/states.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import { VerificationError } from "../engine/tdd/types.js";
import { loadApplicationState } from "./state.js";

/** Explicit recovery after a local runner/path repair, never a waiver of Red evidence. */
export async function retryTestGate(input: { root: string; workItemId: string; expectedAttempt: string; actor: string; reason: string }) {
  if (!input.actor.trim() || !input.reason.trim() || !input.expectedAttempt.trim()) {
    throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "恢复必须提供失败 Attempt、操作者和原因。");
  }
  return mutateControlPlane({
    cwd: input.root, workItemId: input.workItemId, actor: input.actor,
    eventType: "projection.invalidated", idempotencyKey: `test-gate-retry:${input.expectedAttempt}`,
    operationInput: { expectedAttempt: input.expectedAttempt, actor: input.actor, reason: input.reason },
    mutate: async (projection) => {
      const state = await loadApplicationState(input.root, input.workItemId);
      const profile = state.snapshot.profiles[projection.profile.selected];
      const index = profile.order.indexOf("verify-red");
      const step = profile.steps.find(step => step.id === "verify-red");
      const record = projection.contexts["verify-red"] as {
        actor?: string; stepInstanceId?: string; workPackage?: { attemptId?: string };
        result?: { status?: string; summary?: string; failureCode?: string };
      } | undefined;
      if (projection.workItem.status !== "active" || index < 0
        || step?.uses !== "command.execute" || step.action !== "quality.test"
        || projection.stages["verify-red"]?.status !== "failed"
        || projection.stages["write-tests"]?.status !== "succeeded"
        || record?.stepInstanceId !== "verify-red" || record.workPackage?.attemptId !== input.expectedAttempt
        || record.result?.status !== "failed" || record.result.failureCode !== "WSSPEC_STEP_INPUT_INVALID"
        || !record.result.summary?.startsWith("WSSPEC_TDD_TEST_PATH_INVALID:")
        || Object.keys(projection.claims).length > 0 || Object.keys(projection.externalActions).length > 0
        || Object.keys(projection.evidence).some(key => key.startsWith("tdd:"))
        || Object.values(projection.approvals).some(approval => approval.status === "pending")
        || profile.order.slice(index + 1).some(id => projection.stages[id]?.status !== "pending")) {
        throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "只能恢复测试提交后、尚无 Red 证据的路径校验失败；请核对失败 Attempt 与当前状态。");
      }
      const stages = { ...projection.stages, "verify-red": transitionStage(transitionStage(projection.stages["verify-red"]!, { type: "transition", to: "retrying" }), { type: "transition", to: "ready" }) };
      const contexts = { ...projection.contexts };
      const retries = { ...projection.retries };
      delete contexts["verify-red"];
      delete retries["verify-red"];
      return {
        projection: { ...projection, stages, contexts, retries, evidence: { ...projection.evidence,
          [`testing.recovery:${input.expectedAttempt}`]: { actor: input.actor, reason: input.reason, failedAttempt: record },
        } },
        value: { workItemId: input.workItemId, stepId: "verify-red", previousAttempt: input.expectedAttempt, action: "inspect_then_acquire" },
      };
    },
  });
}
