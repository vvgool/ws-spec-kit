import type { CompiledStep } from "../../domain/workflow.js";

export type TddCommandStep = Pick<CompiledStep, "id" | "uses" | "action" | "expectedOutcome">;

export const testPathRules = ["node", "java", "ruby", "dotnet"] as const;
export type TestPathRule = (typeof testPathRules)[number];

export const defaultTestAssetPaths = [
  "test/**",
  "tests/**",
  "**/__tests__/**",
  "**/__snapshots__/**",
  "**/*.test.*",
  "**/*.spec.*",
] as const;
export const defaultProductPaths = ["src/**"] as const;

export interface FixedTestGate {
  commandId: string;
  argv: readonly string[];
  cwd: "worktree";
  timeoutMs: number;
  inheritEnv: readonly string[];
  env: Readonly<Record<string, string>>;
  testPathRules: readonly TestPathRule[];
  testAssetPaths: readonly string[];
  productPaths: readonly string[];
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
  testAssets: TestFileDigest[];
  testAssetsDigest: string;
  testAssetPaths: string[];
  productPaths: string[];
  workspaceDigest: string;
  summary: string;
}

export interface TddCycleEvidence {
  taskId: string;
  testPaths: string[];
  testPathRules: TestPathRule[];
  testAssets: TestFileDigest[];
  testAssetsDigest: string;
  testAssetPaths: string[];
  productPaths: string[];
  commandId: string;
  redEvidenceId: string;
  greenEvidenceId: string;
  refactorEvidenceId?: string;
}

export const tddVerificationCodes = [
  "WSSPEC_TDD_EVIDENCE_INVALIDATED",
  "WSSPEC_TDD_GATE_CONFIGURATION_INVALID",
  "WSSPEC_TDD_GATE_EXECUTION_FAILED",
  "WSSPEC_TDD_GREEN_NOT_OBSERVED",
  "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE",
  "WSSPEC_TDD_RED_NOT_OBSERVED",
  "WSSPEC_TDD_RED_REQUIRED",
  "WSSPEC_TDD_RED_SCOPE_INVALID",
  "WSSPEC_TDD_RED_SYNTAX_FAILURE",
  "WSSPEC_TDD_RED_TIMEOUT",
  "WSSPEC_TDD_REPORT_INVALID",
  "WSSPEC_TDD_REPORTER_UNSUPPORTED",
  "WSSPEC_TDD_STEP_INVALID",
  "WSSPEC_TDD_TEST_PATH_INVALID",
] as const;
export type TddVerificationCode = (typeof tddVerificationCodes)[number];

export function isTddVerificationCode(value: string): value is TddVerificationCode {
  return (tddVerificationCodes as readonly string[]).includes(value);
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
