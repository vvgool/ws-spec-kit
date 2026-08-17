import type { WorkItemId } from "../domain/ids.js";

export interface ArtifactReference {
  artifactType: string;
  schemaVersion: number;
  path?: string;
  revision?: number;
  contentHash?: string;
  mediaType?: string;
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
  lease: {
    token: string;
    expiresAt: string;
  };
  objective: string;
  skills: ResolvedSkillDescriptor[];
  artifacts: ArtifactReference[];
  constraints: {
    allowedPaths: string[];
    forbiddenActions: string[];
  };
  requiredOutputs: ArtifactReference[];
  gates: WorkPackageGate[];
  resultSchema: "builtin.submit-result.v1";
}

