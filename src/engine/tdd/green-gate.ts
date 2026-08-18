import { computeWorkspaceTreeDigest } from "../../domain/digests.js";
import { executeTrustedTestGate, parseTrustedEvidence, testFileManifest } from "./red-gate.js";
import type { GreenEvidenceInput, TddCycleEvidence, TrustedEvidence } from "./types.js";
import { VerificationError } from "./types.js";

export async function recordGreenEvidenceDetails(input: GreenEvidenceInput): Promise<{ cycle: TddCycleEvidence; evidence: TrustedEvidence }> {
  const initialGreen = input.step.id === "verify-green" && input.step.action === "quality.test" && input.step.expectedOutcome === "success";
  const reviewGreen = input.step.id === "verify" && input.step.action === "quality.verify";
  if (input.step.uses !== "command.execute" || (!initialGreen && !reviewGreen)) {
    throw new VerificationError("WSSPEC_TDD_STEP_INVALID", "Green Evidence 只能由编译后的 verify-green Step 产生。 ");
  }
  const currentWorkspaceDigest = await computeWorkspaceTreeDigest(input.worktree);
  const parsedRed = parseTrustedEvidence(input.redEvidence);
  if (parsedRed === undefined) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Red Evidence 结构或内容摘要无效。 ");
  const currentTests = await testFileManifest(input.worktree, parsedRed.testPaths, parsedRed.testPathRules);
  if (parsedRed.taskId !== input.taskId
    || input.redEvidence.commandId !== input.gate.commandId
    || JSON.stringify(parsedRed.testPathRules) !== JSON.stringify(input.gate.testPathRules)
    || input.redEvidence.testPathsDigest !== currentTests.digest
    || input.workspaceDigest !== currentWorkspaceDigest) {
    throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Red Evidence 与当前命令、测试或 workspace 不再一致。 ");
  }
  const evidence = await executeTrustedTestGate({
    taskId: input.taskId,
    phase: "green",
    stepId: input.step.id,
    gate: input.gate,
    worktree: input.worktree,
    workspaceDigest: input.workspaceDigest,
    testPaths: input.redEvidence.testPaths,
    expectedCommandDigest: parsedRed.commandDigest,
  });
  const cycle: TddCycleEvidence = {
    taskId: input.taskId,
    testPaths: [...input.redEvidence.testPaths],
    testPathRules: [...input.redEvidence.testPathRules],
    commandId: input.gate.commandId,
    redEvidenceId: input.redEvidence.evidenceId,
    greenEvidenceId: input.previousCycle?.greenEvidenceId ?? evidence.evidenceId,
    ...(input.previousCycle === undefined && input.refactorEvidenceId === undefined
      ? {}
      : { refactorEvidenceId: input.refactorEvidenceId ?? evidence.evidenceId }),
  };
  return { cycle, evidence };
}

export async function recordGreenEvidence(input: GreenEvidenceInput): Promise<TddCycleEvidence> {
  return (await recordGreenEvidenceDetails(input)).cycle;
}
