import type { WorkItemId } from "../domain/ids.js";
import type { ArtifactReference, WorkPackage } from "./work-package.js";

export type WorkflowProfile = "auto" | "quick" | "standard" | "governed";

export type RequirementSourceInput =
  | { type: "prompt"; text: string }
  | { type: "file"; path: string }
  | { type: "issue"; provider: string; id: string; url?: string };

export interface StartInput {
  root: string;
  source: RequirementSourceInput;
  workflowRef?: string;
  profile?: WorkflowProfile;
}

export interface StartResult {
  workItemId: WorkItemId;
  workflowRef: string;
  profile: Exclude<WorkflowProfile, "auto">;
}

export type StepFailureCode =
  | "WSSPEC_STEP_FAILED"
  | "WSSPEC_STEP_INPUT_INVALID"
  | "WSSPEC_STEP_CONFIGURATION_INVALID";

export interface AcquireInput {
  root: string;
  workItemId: WorkItemId;
  actor: string;
}

export interface ArtifactCreateInput {
  root: string;
  workItemId: WorkItemId;
  stepId: string;
  attemptId: string;
  leaseToken: string;
  artifactType: string;
  outputId?: string;
  contentFile: string;
}

export interface SubmitResult {
  version: 1;
  status: "completed" | "failed";
  summary: string;
  modifiedFiles: string[];
  artifacts: ArtifactReference[];
  commands: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  externalWrites: Array<Record<string, unknown>>;
  remainingRisks: Array<Record<string, unknown>>;
}

export interface SubmitInput {
  root: string;
  workItemId: WorkItemId;
  stepId: string;
  attemptId: string;
  leaseToken: string;
  result: SubmitResult;
}

export interface ApprovalDecision {
  kind: "approval";
  root: string;
  workItemId: WorkItemId;
  requestId: string;
  decision: "approved" | "rejected";
  expectedDigest: string;
  actor: string;
}

export interface WorkflowTrustDecisionInput {
  kind: "workflow_trust";
  root: string;
  requestId: string;
  decision: "trusted" | "rejected";
  expectedPackageDigest: string;
  expectedCapabilityDigest: string;
  actor: string;
}

export interface ExternalActionDecisionInput {
  kind: "external_action";
  root: string;
  workItemId: WorkItemId;
  requestId: string;
  decision: "approved" | "rejected";
  expectedDigest: string;
  actor: string;
}

export interface ExternalActionReconcileInput {
  kind: "external_reconciliation";
  root: string;
  workItemId: WorkItemId;
  requestId: string;
  decision: "reconcile";
  expectedDigest: string;
  actor: string;
}

export interface ExternalActionMarkFailedInput {
  kind: "external_reconciliation";
  root: string;
  workItemId: WorkItemId;
  requestId: string;
  decision: "mark_failed";
  expectedDigest: string;
  evidence: string;
  actor: string;
}

export interface ExternalActionAdoptVerifiedInput {
  kind: "external_reconciliation";
  root: string;
  workItemId: WorkItemId;
  requestId: string;
  decision: "adopt_verified";
  expectedDigest: string;
  externalStableId: string;
  contentDigest: string;
  evidence: string;
  actor: string;
}

export type ExternalActionReconciliationInput =
  | ExternalActionReconcileInput
  | ExternalActionMarkFailedInput
  | ExternalActionAdoptVerifiedInput;

export type DecisionInput = ApprovalDecision | WorkflowTrustDecisionInput | ExternalActionDecisionInput | ExternalActionReconciliationInput;

export interface InspectInput {
  root: string;
  workItemId: WorkItemId;
}

interface BaseApprovalSummary {
  requestId: string;
  workItemId: WorkItemId;
  title: string;
  digest: string;
}

export interface StepApprovalSummary extends BaseApprovalSummary {
  kind: "step" | "workflow_trust";
}

export interface ExternalActionApproval extends BaseApprovalSummary {
  kind: "external_action";
  provider: string;
  action: "git.commit" | "issue.update" | "knowledge.publish" | "issue.close";
  target: { kind: "repository" | "issue" | "knowledge"; stableId: string };
  sideEffects: string[];
}

export type ApprovalSummary = StepApprovalSummary | ExternalActionApproval;

export interface Problem {
  code: `WSSPEC_${string}`;
  message: string;
  retryable: boolean;
}

export interface CompletionSummary {
  workItemId: WorkItemId;
  status: "closed" | "cancelled";
  message: string;
}

export interface WorkItemView {
  workItemId: WorkItemId;
  status: string;
  workflowRef: string;
  profile: Exclude<WorkflowProfile, "auto">;
  externalActions?: Array<{
    requestId: string;
    stepId: string;
    attemptId: string;
    provider: string;
    action: "git.commit" | "issue.update" | "knowledge.publish" | "issue.close";
    target: { kind: "repository" | "issue" | "knowledge"; stableId: string };
    externalEffectKind?: "issue.comment";
    externalEffectId?: string;
    status: "prepared" | "approved" | "executing" | "verified" | "reconciliation_required" | "failed";
  }>;
}

export type AgentAction =
  | { action: "execute"; workPackage: WorkPackage }
  | { action: "await_approval"; approval: ApprovalSummary }
  | { action: "blocked"; problems: Problem[] }
  | { action: "completed"; summary: CompletionSummary };

export interface WSSpecApplication {
  start(input: StartInput): Promise<StartResult>;
  acquire(input: AcquireInput): Promise<AgentAction>;
  submit(input: SubmitInput): Promise<AgentAction>;
  decide(input: DecisionInput): Promise<AgentAction>;
  inspect(input: InspectInput): Promise<WorkItemView>;
}
