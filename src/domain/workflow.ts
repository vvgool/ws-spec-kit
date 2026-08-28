import type { ResolvedSkill } from "../registry/skills/types.js";
import type { ProfileAudit, ProfilePublishing, WorkflowActorRole, WorkflowRetry, WorkspaceMode } from "../workflow-package/types.js";

export type SecurityClass = "agent" | "local-read" | "local-write" | "external-read" | "external-write" | "control";
export type ProfileId = "quick" | "standard" | "governed";

export interface ArtifactRequirement {
  outputId: string;
  required: boolean;
}

export interface ArtifactDeclaration {
  outputId: string;
  artifact: string;
  required: boolean;
  contentLevel?: string;
}

export interface CompiledStep {
  id: string;
  uses: string;
  workspace: WorkspaceMode;
  actorRole?: WorkflowActorRole;
  securityClass: SecurityClass;
  needs: string[];
  enabled: boolean;
  skills: ResolvedSkill[];
  inputs: ArtifactRequirement[];
  outputs: ArtifactDeclaration[];
  gates: string[];
  approval: boolean;
  authorizationRequired: boolean;
  artifactLevel?: string;
  action?: string;
  objective?: string;
  expectedOutcome?: string;
  when?: string;
  until?: string;
  retry?: WorkflowRetry;
  maxIterations?: number;
  independentReviewActor?: boolean;
  steps: CompiledStep[];
}

export interface ResolvedChangePolicy {
  kind: "feature" | "documentation-only";
  allowedPaths: string[];
  digest: string;
}

export interface CompiledProfile {
  id: string;
  publishing: ProfilePublishing;
  audit: ProfileAudit;
}

export interface CompiledWorkflow {
  version: 1;
  id: string;
  packageRef: string;
  packageDigest: string;
  profile: CompiledProfile;
  steps: CompiledStep[];
  order: string[];
  changePolicy: ResolvedChangePolicy;
}
