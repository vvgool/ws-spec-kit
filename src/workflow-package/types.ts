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

export interface WorkflowStep { id: string; skills: string[] }
export interface WorkflowGate { id: string; evidence: "trusted" | "attested"; command: string[] }
export interface WorkflowChangePolicy { kind: "feature" | "documentation-only"; allowedPaths: string[] }
export interface WorkflowDefinition {
  version: 1;
  id: string;
  steps: WorkflowStep[];
  gates: WorkflowGate[];
  changePolicy?: WorkflowChangePolicy;
}

export interface ProfileDefinition {
  version: 1;
  id: string;
  workflow: string;
  design?: boolean;
  reviewIterations?: number;
  audit?: "standard" | "complete";
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
  packageRef: string;
  packageDigest: string;
  capabilityDigest: string;
  decision: "trusted" | "rejected";
  actor: string;
  decidedAt: string;
}

export interface WorkflowTrustSummary {
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
