export const stageStatuses = [
  "pending", "ready", "claimed", "running", "paused", "validating", "awaiting_approval",
  "revision_required", "failed", "retrying", "succeeded", "succeeded_with_warnings", "skipped",
  "invalidated", "cancelled",
] as const;

export type StageStatus = (typeof stageStatuses)[number];
export interface StageState { status: StageStatus; suspendedFrom?: "running" }
export interface StageEvent { type: "transition"; to: StageStatus }

export interface LoopProjection {
  loopId: string;
  iteration: number;
  maxIterations: number;
  status: "running" | "succeeded" | "blocked";
}

export interface RetryProjection {
  stepInstanceId: string;
  attemptsUsed: number;
  maxAttempts: number;
  status: "ready" | "running" | "exhausted";
}

export const workItemStatuses = [
  "draft", "active", "awaiting_approval", "verifying", "verified", "blocked", "pending_publish",
  "reconciliation_required", "paused", "closed", "cancelled",
] as const;

export type WorkItemStatus = (typeof workItemStatuses)[number];
export interface WorkItemState { status: WorkItemStatus; suspendedFrom?: "active" | "blocked" | "pending_publish" }
export interface WorkItemEvent { type: "transition"; to: WorkItemStatus }

export class StateTransitionError extends Error {
  readonly code = "WSSPEC_STATE_TRANSITION_FORBIDDEN";

  constructor(scope: "Stage" | "Work Item", from: string, to: string) {
    super(`${scope} 状态不允许从 ${from} 转换到 ${to}。`);
    this.name = "StateTransitionError";
  }
}

const pairs = <T extends string>(values: ReadonlyArray<readonly [T, T]>): ReadonlySet<string> =>
  new Set(values.map(([from, to]) => `${from}:${to}`));

const stageTransitions: Array<readonly [StageStatus, StageStatus]> = [
  ["pending", "ready"], ["pending", "skipped"], ["ready", "claimed"], ["ready", "running"],
  ["claimed", "running"], ["claimed", "ready"], ["running", "validating"], ["running", "failed"],
  ["running", "paused"], ["paused", "running"], ["paused", "ready"], ["validating", "succeeded"],
  ["validating", "succeeded_with_warnings"], ["validating", "awaiting_approval"], ["validating", "failed"],
  ["awaiting_approval", "succeeded"], ["awaiting_approval", "revision_required"],
  ["revision_required", "ready"], ["failed", "retrying"], ["retrying", "ready"],
  ["succeeded", "invalidated"], ["succeeded_with_warnings", "invalidated"], ["skipped", "invalidated"],
  ["invalidated", "ready"],
];
for (const status of ["pending", "ready", "claimed", "running", "paused", "validating", "awaiting_approval", "revision_required", "failed", "retrying"] as const) {
  stageTransitions.push([status, "invalidated"]);
}
for (const status of ["pending", "ready", "claimed", "running", "paused", "validating", "awaiting_approval", "revision_required", "failed", "retrying", "invalidated"] as const) {
  stageTransitions.push([status, "cancelled"]);
}
const allowedStageTransitions = pairs(stageTransitions);

const workItemTransitions: Array<readonly [WorkItemStatus, WorkItemStatus]> = [
  ["draft", "active"], ["active", "awaiting_approval"], ["awaiting_approval", "active"],
  ["active", "verifying"], ["verifying", "verified"], ["verifying", "blocked"],
  ["blocked", "verifying"], ["verified", "closed"], ["verified", "pending_publish"],
  ["verified", "blocked"],
  ["pending_publish", "pending_publish"], ["pending_publish", "closed"],
  ["pending_publish", "reconciliation_required"], ["reconciliation_required", "pending_publish"],
  ["active", "paused"], ["blocked", "paused"], ["pending_publish", "paused"],
  ["paused", "active"], ["paused", "blocked"], ["paused", "pending_publish"],
];
for (const status of workItemStatuses.filter((value) => value !== "closed" && value !== "cancelled")) {
  workItemTransitions.push([status, "cancelled"]);
}
const allowedWorkItemTransitions = pairs(workItemTransitions);

export function transitionStage(state: StageState, event: StageEvent): StageState {
  if (!allowedStageTransitions.has(`${state.status}:${event.to}`)) {
    throw new StateTransitionError("Stage", state.status, event.to);
  }
  if (event.to === "paused") return { status: event.to, suspendedFrom: "running" };
  return { status: event.to };
}

export function transitionWorkItem(state: WorkItemState, event: WorkItemEvent): WorkItemState {
  if (!allowedWorkItemTransitions.has(`${state.status}:${event.to}`)) {
    throw new StateTransitionError("Work Item", state.status, event.to);
  }
  if (state.status === "paused" && state.suspendedFrom !== event.to) {
    throw new StateTransitionError("Work Item", state.status, event.to);
  }
  if (event.to === "paused") {
    return { status: event.to, suspendedFrom: state.status as "active" | "blocked" | "pending_publish" };
  }
  return { status: event.to };
}
