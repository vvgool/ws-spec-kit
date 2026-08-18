import { computeWorkspaceTreeDigest } from "../../domain/digests.js";
import { executeTrustedTestGate, parseTrustedEvidence, testAssetManifest, testFileManifest } from "./red-gate.js";
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
  const [currentTests, currentAssets] = await Promise.all([
    testFileManifest(input.worktree, parsedRed.testPaths, parsedRed.testPathRules),
    testAssetManifest(input.worktree, parsedRed.testAssets.map(({ path }) => path)),
  ]);
  if (parsedRed.taskId !== input.taskId
    || input.redEvidence.commandId !== input.gate.commandId
    || JSON.stringify(parsedRed.testPathRules) !== JSON.stringify(input.gate.testPathRules)
    || JSON.stringify(parsedRed.testAssetPaths) !== JSON.stringify(input.gate.testAssetPaths)
    || JSON.stringify(parsedRed.productPaths) !== JSON.stringify(input.gate.productPaths)
    || input.redEvidence.testPathsDigest !== currentTests.digest
    || parsedRed.testAssetsDigest !== currentAssets.digest
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
  const sameAssets = evidence.testAssets.length === parsedRed.testAssets.length
    && evidence.testAssets.every((asset, index) => asset.path === parsedRed.testAssets[index]?.path && asset.digest === parsedRed.testAssets[index]?.digest);
  if (evidence.testAssetsDigest !== parsedRed.testAssetsDigest || !sameAssets) {
    const redPaths = new Set(parsedRed.testAssets.map(({ path }) => path));
    const greenPaths = new Set(evidence.testAssets.map(({ path }) => path));
    const missing = [...redPaths].filter((filename) => !greenPaths.has(filename)).sort();
    const added = [...greenPaths].filter((filename) => !redPaths.has(filename)).sort();
    const changed = evidence.testAssets.filter((asset) => parsedRed.testAssets.some((red) => red.path === asset.path && red.digest !== asset.digest)).map(({ path }) => path);
    throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", `Green 执行覆盖的测试资产集合与 Red 不一致（missing: ${missing.join(", ") || "none"}; added: ${added.join(", ") || "none"}; changed: ${changed.join(", ") || "none"}）。 `);
  }
  const cycle: TddCycleEvidence = {
    taskId: input.taskId,
    testPaths: [...input.redEvidence.testPaths],
    testPathRules: [...input.redEvidence.testPathRules],
    testAssets: input.redEvidence.testAssets.map((asset) => ({ ...asset })),
    testAssetsDigest: input.redEvidence.testAssetsDigest,
    testAssetPaths: [...input.redEvidence.testAssetPaths],
    productPaths: [...input.redEvidence.productPaths],
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
