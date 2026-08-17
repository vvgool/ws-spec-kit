export type StageKind = "define" | "design" | "plan" | "implement" | "review" | "verify" | "publish" | "close";
export type StageOwner = "agent" | "engine";

export interface Approval {
  required: boolean;
  provider?: "interactive";
}

export interface Stage {
  id: string;
  kind: StageKind;
  owner: StageOwner;
  uses: string;
  needs?: string[];
  input?: string[];
  output?: string[];
  approval?: Approval;
  gates?: string[];
  publish?: string[];
}

export interface Workflow {
  version: 1;
  workflow: { id: string };
  stages: Stage[];
}

export interface NormalizedStage extends Stage {
  needs: string[];
  input: string[];
  output: string[];
  approval: Approval;
  gates: string[];
  publish: string[];
}

export interface CompiledWorkflow {
  version: 1;
  id: string;
  stages: NormalizedStage[];
  order: string[];
}

