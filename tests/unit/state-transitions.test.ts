import assert from "node:assert/strict";
import test from "node:test";

import {
  StateTransitionError,
  stageStatuses,
  transitionStage,
  transitionWorkItem,
  workItemStatuses,
  type StageStatus,
  type WorkItemStatus,
} from "../../src/domain/states.js";

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

const activeStageStatuses = ["pending", "ready", "claimed", "running", "paused", "validating", "awaiting_approval", "revision_required", "failed", "retrying", "invalidated"] as const;
for (const status of activeStageStatuses) stageTransitions.push([status, "cancelled"]);

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

test("accepts every Stage transition defined by State Transitions v1", () => {
  for (const [from, to] of stageTransitions) {
    const result = transitionStage({ status: from }, { type: "transition", to });
    assert.equal(result.status, to, `${from} -> ${to}`);
  }
});

test("rejects every Stage transition absent from State Transitions v1", () => {
  const allowed = new Set(stageTransitions.map(([from, to]) => `${from}:${to}`));
  for (const from of stageStatuses) for (const to of stageStatuses) {
    if (allowed.has(`${from}:${to}`)) continue;
    assert.throws(
      () => transitionStage({ status: from }, { type: "transition", to }),
      (error: unknown) => error instanceof StateTransitionError && error.code === "WSSPEC_STATE_TRANSITION_FORBIDDEN",
      `${from} -> ${to}`,
    );
  }
});

test("accepts every Work Item transition defined by State Transitions v1", () => {
  for (const [from, to] of workItemTransitions) {
    const state = from === "paused" ? { status: from, suspendedFrom: to as "active" | "blocked" | "pending_publish" } : { status: from };
    const result = transitionWorkItem(state, { type: "transition", to });
    assert.equal(result.status, to, `${from} -> ${to}`);
  }
});

test("a paused Work Item can resume only to its recorded suspended state", () => {
  assert.throws(
    () => transitionWorkItem({ status: "paused", suspendedFrom: "blocked" }, { type: "transition", to: "active" }),
    (error: unknown) => error instanceof StateTransitionError && error.code === "WSSPEC_STATE_TRANSITION_FORBIDDEN",
  );
  assert.equal(transitionWorkItem({ status: "paused", suspendedFrom: "blocked" }, { type: "transition", to: "blocked" }).status, "blocked");
});

test("rejects every Work Item transition absent from State Transitions v1", () => {
  const allowed = new Set(workItemTransitions.map(([from, to]) => `${from}:${to}`));
  for (const from of workItemStatuses) for (const to of workItemStatuses) {
    if (allowed.has(`${from}:${to}`)) continue;
    assert.throws(
      () => transitionWorkItem({ status: from }, { type: "transition", to }),
      (error: unknown) => error instanceof StateTransitionError && error.code === "WSSPEC_STATE_TRANSITION_FORBIDDEN",
      `${from} -> ${to}`,
    );
  }
});
