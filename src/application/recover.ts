import type { WorkItemId } from "../domain/ids.js";
import { inspectApplication } from "./inspect.js";
import { revalidateRed } from "./revalidate-red.js";
import { retryTestGate } from "./retry-test-gate.js";
import { VerificationError } from "../engine/tdd/types.js";

/** Selects an existing guarded recovery operation; never approves or sends external writes. */
export async function recoverApplication(input: { root: string; workItemId: WorkItemId; actor: string; reason: string }) {
  if (!input.actor.trim() || !input.reason.trim()) throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "恢复必须提供操作者和原因。");
  const view = await inspectApplication({ root: input.root, workItemId: input.workItemId });
  const action = view.nextAction;
  if (action.kind === "revalidate-red" && action.expectedEvidence !== undefined) {
    await revalidateRed({ ...input, expectedEvidence: action.expectedEvidence });
  } else if (action.kind === "retry-test-gate" && action.expectedAttempt !== undefined) {
    await retryTestGate({ ...input, expectedAttempt: action.expectedAttempt });
  } else return view;
  return inspectApplication({ root: input.root, workItemId: input.workItemId });
}
