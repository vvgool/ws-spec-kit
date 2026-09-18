import { VerificationError } from "../engine/tdd/types.js";
import type { ApplicationState } from "./state.js";
import { maxStepInterruptions } from "../engine/control/retry.js";
import { fixedTestGateForState, tddRedEvidenceKey } from "../engine/verification.js";
import { commandMismatchMessage, fixedGateCommandIdentity, parseTrustedEvidence } from "../engine/tdd/red-gate.js";

import type { RecoveryGuidance } from "../protocol/application.js";

/** Advisory only. Mutating operations always recheck their own full preconditions. */
export async function recoveryGuidance(state: ApplicationState): Promise<RecoveryGuidance> {
  const p = state.projection;
  const profile = state.snapshot.profiles[p.profile.selected];
  const currentStep = profile.order.find(id => !["succeeded", "succeeded_with_warnings", "skipped", "cancelled"].includes(p.stages[id]?.status ?? "pending"));
  let currentStepInstanceId = currentStep;
  const loop = currentStep === undefined ? undefined : p.loops[currentStep];
  if (loop !== undefined) {
    const prefix = `${loop.loopId}:${loop.iteration}:`;
    const claimed = p.claims[currentStep!]?.stageId;
    const context = p.contexts[currentStep!] as { stepInstanceId?: string } | undefined;
    const unfinished = Object.keys(p.retries).find(id => {
      if (!id.startsWith(prefix)) return false;
      const record = p.contexts[id] as { skipped?: boolean; result?: { status?: string } } | undefined;
      return record?.skipped !== true && record?.result?.status !== "completed";
    });
    currentStepInstanceId = claimed?.startsWith(prefix) ? claimed
      : unfinished ?? (context?.stepInstanceId?.startsWith(prefix) ? context.stepInstanceId : currentStep);
  }
  const retry = currentStepInstanceId === undefined || !Object.hasOwn(p.retries, currentStepInstanceId) ? undefined : p.retries[currentStepInstanceId];
  const base = { ...(currentStep === undefined ? {} : { currentStep }), ...(currentStepInstanceId === undefined ? {} : { currentStepInstanceId }), ...(retry === undefined ? {} : { retry: {
    attemptsUsed: retry.attemptsUsed, attemptsRemaining: Math.max(0, retry.maxAttempts - retry.attemptsUsed),
    interruptions: retry.interruptions ?? 0, interruptionsRemaining: Math.max(0, maxStepInterruptions - (retry.interruptions ?? 0)),
  } }) };
  const result = (nextAction: RecoveryGuidance["nextAction"]): RecoveryGuidance => ({ ...base, nextAction });
  if (["closed", "cancelled"].includes(p.workItem.status)) return result({ kind: "completed", reason: "任务已结束。" });
  if (Object.values(p.externalActions).some(a => a.status === "reconciliation_required" || a.status === "executing"))
    return result({ kind: "reconcile", reason: "外部动作正在执行或结果未知，先检查动作状态并按协议回查，不能自动重发。" });
  if (Object.values(p.approvals).some(a => a.status === "pending"))
    return result({ kind: "await_approval", reason: "存在待确认审批，请核对当前审批版本后 decide。" });
  if (p.workItem.status !== "active") return result({ kind: "blocked", reason: `任务状态为 ${p.workItem.status}，不能自动恢复。` });
  if (retry?.status === "exhausted") return result({ kind: "blocked", reason: (retry.interruptions ?? 0) >= maxStepInterruptions
    ? "已达到中断上限，请检查会话或租约稳定性；不会自动重置预算。" : "执行失败预算已耗尽；不会自动重置预算。" });
  if (Object.keys(p.claims).length > 0) return result({ kind: "acquire", reason: "使用原 actor 获取或恢复当前 Work Package，其他 actor 不能抢占活动租约。" });
  const context = p.contexts["verify-red"] as { workPackage?: { attemptId?: string }; result?: { status?: string; failureCode?: string; summary?: string } } | undefined;
  if (currentStep === "verify-red" && p.stages[currentStep]?.status === "failed"
    && context?.result?.status === "failed" && context.result.failureCode === "WSSPEC_STEP_INPUT_INVALID"
    && context.result.summary?.startsWith("WSSPEC_TDD_TEST_PATH_INVALID:") && context.workPackage?.attemptId) {
    return result({ kind: "retry-test-gate", expectedAttempt: context.workPackage.attemptId,
      reason: "Red 路径校验失败；修复路径或扫描问题后 recover 将重开测试步骤，后续仍须执行完整门禁。" });
  }
  if (currentStep === "implement" && p.stages.implement?.status === "ready") {
    const red = parseTrustedEvidence(p.evidence[tddRedEvidenceKey(p.workItemId)]);
    if (red !== undefined) {
      try {
        const identity = await fixedGateCommandIdentity(await fixedTestGateForState(state), state.worktree);
        if (identity.commandDigest !== red.commandDigest) return result({ kind: "revalidate-red", expectedEvidence: red.evidenceId,
          reason: commandMismatchMessage(red, identity.commandFingerprint) });
      } catch (error) {
        if (!(error instanceof VerificationError)) throw error;
        const code = error.code;
        return result({ kind: "blocked", reason: `${code}：测试执行环境不可用，请修复 Node、runner 或测试配置后重新 inspect。` });
      }
    }
  }
  if (currentStep !== undefined && p.stages[currentStep]?.status === "failed" && retry?.status === "ready")
    return result({ kind: "acquire", reason: "上次执行失败，剩余预算允许重新领取。" });
  if (currentStep !== undefined && ["failed", "paused", "invalidated"].includes(p.stages[currentStep]?.status ?? ""))
    return result({ kind: "blocked", reason: `步骤 ${currentStep} 为 ${p.stages[currentStep]!.status}，无可自动执行的恢复操作。` });
  return result({ kind: "acquire", reason: "继续 acquire；引擎会校验测试资产、工作区与当前步骤条件。" });
}
