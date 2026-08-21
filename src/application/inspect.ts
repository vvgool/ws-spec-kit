import type { InspectInput, WorkItemView } from "../protocol/application.js";
import { validate } from "../schemas/index.js";
import { recoverControlPlane } from "../storage/control-plane.js";
import { loadApplicationState } from "./state.js";

export async function inspectApplication(input: InspectInput): Promise<WorkItemView> {
  validate("builtin.application-inspect-input.v1", input);
  await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  const state = await loadApplicationState(input.root, input.workItemId);
  const externalActions = Object.values(state.projection.externalActions)
    .sort((left, right) => left.request.createdAt.localeCompare(right.request.createdAt))
    .map((external) => ({
      requestId: external.request.requestId,
      stepId: external.request.stepId,
      attemptId: external.request.attemptId,
      provider: external.request.provider,
      action: external.request.action,
      target: { ...external.request.target },
      ...(external.request.externalEffectKind === undefined ? {} : { externalEffectKind: external.request.externalEffectKind }),
      ...(external.status !== "verified" || external.receipt.externalEffectId === undefined
        ? {}
        : { externalEffectId: external.receipt.externalEffectId }),
      status: external.status,
    }));
  return {
    workItemId: state.item.workItemId,
    status: state.projection.workItem.status,
    workflowRef: state.snapshot.workflowRef,
    profile: state.snapshot.selectedProfile,
    ...(externalActions.length === 0 ? {} : { externalActions }),
  };
}
