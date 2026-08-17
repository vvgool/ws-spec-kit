import type { InspectInput, WorkItemView } from "../protocol/application.js";
import { validate } from "../schemas/index.js";
import { recoverControlPlane } from "../storage/control-plane.js";
import { loadApplicationState } from "./state.js";

export async function inspectApplication(input: InspectInput): Promise<WorkItemView> {
  validate("builtin.application-inspect-input.v1", input);
  await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  const state = await loadApplicationState(input.root, input.workItemId);
  return {
    workItemId: state.item.workItemId,
    status: state.projection.workItem.status,
    workflowRef: state.snapshot.workflowRef,
    profile: state.snapshot.selectedProfile,
  };
}
