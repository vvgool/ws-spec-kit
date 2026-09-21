import type { WorkflowPackage, WorkflowStep } from "./types.js";

/** Only the built-in assessment contract is exempt from code-change gates. */
export function isReadOnlyAssessmentPackage(pkg: WorkflowPackage): boolean {
  const readOnly = (steps: readonly WorkflowStep[]): boolean => steps.every(step => step.workspace === "read-only"
    && (step.uses === "agent.execute" || step.uses === "control.close"
      || (step.uses === "connector.execute" && step.action === "requirement.capture"))
    && readOnly(step.steps ?? []));
  return pkg.ref === "builtin://workflows/assessment" && pkg.workflow.gates.length === 0 && readOnly(pkg.workflow.steps);
}
