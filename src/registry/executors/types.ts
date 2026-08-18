import type { CompiledStep, SecurityClass } from "../../domain/workflow.js";
import type { AgentAction, StepFailureCode, SubmitResult } from "../../protocol/application.js";
import type { ArtifactReference } from "../../protocol/work-package.js";
import type { RuntimeProjection } from "../../storage/control-plane.js";

export type ValidatedStepResult =
  | { status: "completed"; artifacts: ArtifactReference[]; failureCode?: never }
  | { status: "failed"; artifacts: ArtifactReference[]; failureCode: StepFailureCode };

export interface StepExecutor {
  id: string;
  securityClass: SecurityClass;
  acquire(step: CompiledStep, runtime: RuntimeProjection): Promise<AgentAction>;
  validate(step: CompiledStep, result: SubmitResult, runtime: RuntimeProjection): Promise<ValidatedStepResult>;
}
