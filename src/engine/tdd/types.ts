import type { CompiledStep } from "../../domain/workflow.js";

export type TddCommandStep = Pick<CompiledStep, "id" | "uses" | "action" | "expectedOutcome">;

export const testPathRules = ["node", "java", "ruby", "dotnet"] as const;
export type TestPathRule = (typeof testPathRules)[number];

export interface FixedTestGate {
  commandId: string;
  argv: readonly string[];
  cwd: "worktree";
  timeoutMs: number;
  inheritEnv: readonly string[];
  env: Readonly<Record<string, string>>;
  testPathRules: readonly TestPathRule[];
  reporter: { type: "node-test"; version: 1 };
}

export interface TestFileDigest {
  path: string;
  digest: string;
}

export interface TrustedEvidence {
  evidenceId: string;
  level: "trusted";
  phase: "red" | "green";
  taskId: string;
  stepId: string;
  commandId: string;
  commandDigest: string;
  exitCode: number;
  failedTests: string[];
  testPaths: string[];
  testFiles: TestFileDigest[];
  testPathsDigest: string;
  testPathRules: TestPathRule[];
  workspaceDigest: string;
  summary: string;
}

export interface TddCycleEvidence {
  taskId: string;
  testPaths: string[];
  testPathRules: TestPathRule[];
  commandId: string;
  redEvidenceId: string;
  greenEvidenceId: string;
  refactorEvidenceId?: string;
}

export class VerificationError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "VerificationError";
  }
}

export interface RedEvidenceInput {
  taskId: string;
  step: TddCommandStep;
  gate: FixedTestGate;
  worktree: string;
  workspaceDigest: string;
  modifiedFiles: readonly string[];
  testPaths: readonly string[];
  secrets?: readonly string[];
}

export interface GreenEvidenceInput {
  taskId: string;
  step: TddCommandStep;
  gate: FixedTestGate;
  worktree: string;
  workspaceDigest: string;
  redEvidence: TrustedEvidence;
  previousCycle?: TddCycleEvidence;
  refactorEvidenceId?: string;
}
