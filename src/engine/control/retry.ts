import type { RetryProjection } from "../../domain/states.js";
import type { Problem, StepFailureCode } from "../../protocol/application.js";

export class RetryControlError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "RetryControlError";
  }
}

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
    throw new RetryControlError("WSSPEC_STEP_RETRY_EXHAUSTED", `步骤 ${stepInstanceId} 已耗尽重试次数。`);
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
  return current.status === "running" ? failRetry(current) : current;
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
    ? retryExhaustedProblem(retry.stepInstanceId)
    : stepFailureProblem("WSSPEC_STEP_FAILED", summary);
}

export function retryExhaustedProblem(stepInstanceId: string): Problem {
  return {
    code: "WSSPEC_STEP_RETRY_EXHAUSTED",
    message: `步骤 ${stepInstanceId} 已耗尽重试次数。`,
    retryable: false,
  };
}
