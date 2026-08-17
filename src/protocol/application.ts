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

export interface AcquireInput {
  root: string;
  workItemId: WorkItemId;
  actor: string;
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

export type DecisionInput = ApprovalDecision | WorkflowTrustDecisionInput;

export interface InspectInput {
  root: string;
  workItemId: WorkItemId;
}

export interface ApprovalSummary {
  kind: "step" | "external_action" | "workflow_trust";
  requestId: string;
  workItemId: WorkItemId;
  title: string;
  digest: string;
}

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

