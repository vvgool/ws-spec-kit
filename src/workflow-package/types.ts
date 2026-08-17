export interface WorkflowManifest {
  version: 1;
  id: string;
  description?: string;
  entry: "workflow.yaml";
  profiles: string[];
  skills: string[];
  capabilities: string[];
  externalSideEffects: string[];
  connectors: string[];
}

export interface WorkflowIdentity { id: string; version: 1 }
export interface WorkflowInputDefinition { accepts: string[] }
export interface WorkflowSkillBinding { ref: string; required?: boolean; fallback?: string }
export interface WorkflowArtifactInput { artifact: string; required?: boolean }
export interface WorkflowRetry { maxAttempts: number }
export interface WorkflowLoop { until: string; maxIterations: number }
export interface WorkflowStep {
  id: string;
  uses: string;
  needs?: string[];
  when?: string;
  retry?: WorkflowRetry;
  loop?: WorkflowLoop;
  approval?: boolean | "required";
  inputs?: Array<string | WorkflowArtifactInput>;
  outputs?: string[];
  skills?: WorkflowSkillBinding[];
  action?: string;
  objective?: string;
  expectedOutcome?: string;
  until?: string;
  maxIterations?: number;
  steps?: WorkflowStep[];
}
export interface WorkflowGate { id: string; evidence: "trusted" | "attested"; command: string[] }
export interface WorkflowChangePolicy { kind: "feature" | "documentation-only"; allowedPaths: string[] }
export interface WorkflowDefinition {
  version: 1;
  workflow: WorkflowIdentity;
  inputs: Record<string, WorkflowInputDefinition>;
  steps: WorkflowStep[];
  gates: WorkflowGate[];
  changePolicy?: WorkflowChangePolicy;
}

export interface ProfileIdentity { id: string; workflow: string }
export interface ProfileArtifactOverlay { required?: boolean; contentLevel?: string }
export interface ProfileStepOverlay {
  enabled?: boolean;
  approval?: boolean;
  artifactLevel?: string;
  artifacts?: Record<string, ProfileArtifactOverlay>;
  gates?: string[];
  maxIterations?: number;
  independentReviewActor?: boolean;
}
export interface ProfilePublishing { issueRequired: boolean; knowledgeRequired: boolean; readBackRequired?: boolean }
export interface ProfileAudit {
  level: "standard" | "complete";
  retention?: "standard" | "extended";
  recordDecisions?: boolean;
  recordApprovals?: boolean;
  recordActors?: boolean;
  recordPublishing?: boolean;
}
export interface ProfileDefinition {
  version: 1;
  profile: ProfileIdentity;
  steps: Record<string, ProfileStepOverlay>;
  publishing: ProfilePublishing;
  audit: ProfileAudit;
}

export interface WorkflowPackageFile {
  path: string;
  digest: string;
}

export interface WorkflowPackage {
  ref: string;
  root: string;
  manifest: WorkflowManifest;
  workflow: WorkflowDefinition;
  profiles: Map<string, ProfileDefinition>;
  packageSkills: Map<string, { entrypoint: string; digest: string }>;
  files: WorkflowPackageFile[];
  contentDigest: string;
}

export interface WorkflowPackageLock {
  version: 1;
  contentDigest: string;
  files: WorkflowPackageFile[];
  packageSkills: Array<{ ref: string; digest: string }>;
}

export interface WorkflowTrustRecord {
  requestId: string;
  packageRef: string;
  packageDigest: string;
  capabilityDigest: string;
  decision: "trusted" | "rejected";
  actor: string;
  decidedAt: string;
}

export interface WorkflowTrustSummary {
  requestId: string;
  packageRef: string;
  packageDigest: string;
  capabilityDigest: string;
  fileDigests: Array<{ path: string; digest: string }>;
  skillDigests: Array<{ ref: string; digest: string }>;
  capabilities: string[];
}

export type WorkflowTrustDecision =
  | { status: "trusted"; record: WorkflowTrustRecord }
  | { status: "approval_required"; summary: WorkflowTrustSummary }
  | { status: "rejected"; record: WorkflowTrustRecord };

export class WorkflowPackageError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "WorkflowPackageError";
  }
}
