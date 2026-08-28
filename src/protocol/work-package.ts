import type { WorkItemId } from "../domain/ids.js";
import type { WorkspaceMode } from "../workflow-package/types.js";

export interface ArtifactReference {
  artifactType: string;
  outputId?: string;
  schemaVersion: number;
  artifactId?: string;
  path?: string;
  revision?: number;
  contentHash?: string;
  mediaType?: string;
  contentLevel?: string;
}

export interface ArtifactExpectation {
  artifactType: string;
  outputId?: string;
  schemaVersion: number;
  contentLevel?: string;
}

export interface ResolvedSkillDescriptor {
  ref: string;
  version: string;
  digest: string;
  description: string;
}

export interface WorkPackageGate {
  id: string;
  evidence: "trusted" | "attested" | "reported";
  required: boolean;
}

export interface WorkPackage {
  version: 1;
  workItemId: WorkItemId;
  stepId: string;
  attemptId: string;
  workspace: {
    mode: WorkspaceMode;
    materialized: boolean;
  };
  lease: {
    token: string;
    expiresAt: string;
  };
  objective: string;
  artifactLevel?: string;
  skills: ResolvedSkillDescriptor[];
  artifacts: ArtifactReference[];
  constraints: {
    allowedPaths: string[];
    forbiddenActions: string[];
  };
  requiredOutputs: ArtifactExpectation[];
  artifactAuthoring?: {
    version: 1;
    maxContentBytes: number;
    draftRoots: string[];
  };
  gates: WorkPackageGate[];
  resultSchema: "builtin.submit-result.v1";
}
