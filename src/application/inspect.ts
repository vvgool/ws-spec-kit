import { recoveryGuidance } from "./recovery-guidance.js";
import { parseTrustedEvidence } from "../engine/tdd/red-gate.js";
import { tddRedEvidenceKey } from "../engine/verification.js";
import { readTestingConfigMigration, testingConfigEvidenceKey } from "../storage/testing-config-migration.js";
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
  const failedRed = state.projection.contexts["verify-red"] as { workPackage?: { attemptId?: string }; result?: { summary?: string } } | undefined;
  const red = parseTrustedEvidence(state.projection.evidence[tddRedEvidenceKey(state.item.workItemId)]);
  return {
    ...await recoveryGuidance(state),
    ...(red === undefined ? {} : { redEvidenceId: red.evidenceId }),
    ...(state.projection.stages["verify-red"]?.status !== "failed" || !failedRed?.workPackage?.attemptId ? {} : { failedTestGate: { stepId: "verify-red" as const, attemptId: failedRed.workPackage.attemptId, summary: failedRed.result?.summary ?? "" } }),
    testingConfigDigest: readTestingConfigMigration(state.projection.evidence[testingConfigEvidenceKey], state.item.execution.configDigest)?.configDigest ?? state.item.execution.configDigest,
    workItemId: state.item.workItemId,
    status: state.projection.workItem.status,
    workflowRef: state.snapshot.workflowRef,
    profile: state.snapshot.selectedProfile,
    ...(externalActions.length === 0 ? {} : { externalActions }),
  };
}
