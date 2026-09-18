import type { RetryProjection } from "../../domain/states.js";
import type { Problem, StepFailureCode } from "../../protocol/application.js";

export class RetryControlError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "RetryControlError";
  }
}

export const maxStepInterruptions = 20;

export function retryLimit(stepMaxAttempts: number | undefined, fallbackRetries: number): number {
  return stepMaxAttempts ?? fallbackRetries + 1;
}

export function acquireRetry(
  current: RetryProjection | undefined,
  stepInstanceId: string,
  maxAttempts: number,
): RetryProjection {
  const retry = current ?? { stepInstanceId, attemptsUsed: 0, maxAttempts, status: "ready" as const };
  if (retry.stepInstanceId !== stepInstanceId || retry.maxAttempts !== maxAttempts) {
    throw new RetryControlError("WSSPEC_RETRY_PROJECTION_INVALID", `步骤 ${stepInstanceId} 的重试投影与 Application 快照不一致。`);
  }
  if (retry.status !== "ready" || retry.attemptsUsed >= retry.maxAttempts) {
    throw new RetryControlError("WSSPEC_STEP_RETRY_EXHAUSTED", (retry.interruptions ?? 0) >= maxStepInterruptions ? `步骤 ${stepInstanceId} 已达到 ${maxStepInterruptions} 次中断上限，请检查会话或租约稳定性。` : `步骤 ${stepInstanceId} 已耗尽重试次数。`);
  }
  return { ...retry, attemptsUsed: retry.attemptsUsed + 1, status: "running" };
}

export function failRetry(current: RetryProjection): RetryProjection {
  if (current.status !== "running") {
    throw new RetryControlError("WSSPEC_RETRY_PROJECTION_INVALID", `步骤 ${current.stepInstanceId} 没有运行中的 Attempt。`);
  }
  return { ...current, status: current.attemptsUsed < current.maxAttempts ? "ready" : "exhausted" };
}

export function interruptedRetry(current: RetryProjection): RetryProjection {
  if (current.status !== "running") return current;
  const interruptions = (current.interruptions ?? 0) + 1;
  return { ...current, attemptsUsed: Math.max(0, current.attemptsUsed - 1), interruptions,
    status: interruptions >= maxStepInterruptions ? "exhausted" : "ready" };
}

export function isStepFailureCode(value: unknown): value is StepFailureCode {
  return value === "WSSPEC_STEP_FAILED"
    || value === "WSSPEC_STEP_INPUT_INVALID"
    || value === "WSSPEC_STEP_CONFIGURATION_INVALID";
}

export function isRetryableStepFailure(code: StepFailureCode): boolean {
  return code === "WSSPEC_STEP_FAILED";
}

export function stepFailureProblem(code: StepFailureCode, summary: string): Problem {
  return { code, message: summary, retryable: isRetryableStepFailure(code) };
}

export function retryFailureProblem(retry: RetryProjection, summary: string): Problem {
  return retry.status === "exhausted"
    ? retryExhaustedProblem(retry.stepInstanceId, retry)
    : stepFailureProblem("WSSPEC_STEP_FAILED", summary);
}

export function retryExhaustedProblem(stepInstanceId: string, retry?: RetryProjection): Problem {
  return {
    code: "WSSPEC_STEP_RETRY_EXHAUSTED",
    message: (retry?.interruptions ?? 0) >= maxStepInterruptions
      ? `步骤 ${stepInstanceId} 已达到 ${maxStepInterruptions} 次中断上限，请检查会话或租约稳定性。`
      : `步骤 ${stepInstanceId} 已耗尽重试次数。`,
    retryable: false,
  };
}
