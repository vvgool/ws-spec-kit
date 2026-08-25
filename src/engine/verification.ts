import * as canonicalizeModule from "canonicalize";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import { isRepositoryRelativePattern } from "../domain/repository-path.js";
import { validate } from "../schemas/index.js";
import { mutateControlPlane } from "./scheduler.js";
import { loadApplicationState, selectedProfile, type SnapshotStep } from "../application/state.js";
import { deriveTestAssetRoots, fixedGateCommandDigest, isTrustedTestAssetPath, parseTrustedEvidence, testAssetScopeManifest, testFileManifest } from "./tdd/red-gate.js";
import { testPathRules, type FixedTestGate, type TddCycleEvidence, type TrustedEvidence } from "./tdd/types.js";
import { VerificationError } from "./tdd/types.js";

export { VerificationError } from "./tdd/types.js";

export const tddRedEvidenceKey = (taskId: string): string => `tdd:${taskId}:red`;
export const tddCycleEvidenceKey = (taskId: string): string => `tdd:${taskId}:cycle`;
export const tddGreenEvidenceKey = (taskId: string, evidenceId: string): string => `tdd:${taskId}:green:${evidenceId}`;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function requiresTrustedTestGate(steps: readonly { id: string; enabled: boolean; steps?: readonly unknown[] }[]): boolean {
  return steps.some((step) => {
    const children = Array.isArray(step.steps) ? step.steps as Array<{ id: string; enabled: boolean; steps?: readonly unknown[] }> : [];
    return ((step.id === "verify-red" || step.id === "verify-green") && step.enabled) || requiresTrustedTestGate(children);
  });
}

export function fixedTestGateFromConfig(raw: unknown): FixedTestGate {
  const config = object(raw);
  const gate = object(object(object(config?.quality)?.gates)?.test);
  const configuredPathRules = object(config?.testing)?.pathRules;
  const testAssetPaths = object(config?.testing)?.testAssetPaths;
  const productPaths = object(config?.testing)?.productPaths;
  const argv = gate?.command;
  const timeoutSeconds = gate?.timeoutSeconds;
  const inheritEnv = gate?.inheritEnv;
  const env = gate?.env;
  const reporter = object(gate?.reporter);
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((value) => typeof value === "string")
    || typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1
    || (inheritEnv !== undefined && (!Array.isArray(inheritEnv) || !inheritEnv.every((value) => typeof value === "string")))
    || (env !== undefined && object(env) === undefined)
    || !Array.isArray(configuredPathRules) || configuredPathRules.length === 0
    || !configuredPathRules.every((value) => typeof value === "string" && (testPathRules as readonly string[]).includes(value))
    || !Array.isArray(testAssetPaths) || testAssetPaths.length === 0 || !testAssetPaths.every((value) => typeof value === "string" && isRepositoryRelativePattern(value))
    || !Array.isArray(productPaths) || productPaths.length === 0 || !productPaths.every((value) => typeof value === "string" && isRepositoryRelativePattern(value))
    || reporter?.type !== "node-test" || reporter.version !== 1) {
    throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "Project Config 缺少固定且完整的 test Gate。");
  }
  return {
    commandId: "test",
    argv: argv as string[],
    cwd: "worktree",
    timeoutMs: timeoutSeconds * 1_000,
    inheritEnv: (inheritEnv ?? []) as string[],
    env: Object.fromEntries(Object.entries(object(env) ?? {}).map(([name, value]) => {
      if (typeof value !== "string") throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", `Test Gate env ${name} 必须是字符串。`);
      return [name, value];
    })),
    testPathRules: configuredPathRules as FixedTestGate["testPathRules"],
    testAssetPaths: testAssetPaths as string[],
    testAssetRoots: deriveTestAssetRoots(testAssetPaths as string[]),
    productPaths: productPaths as string[],
    reporter: { type: "node-test", version: 1 },
  };
}

export async function fixedTestGateForState(state: Pick<import("../application/state.js").ApplicationState, "itemRoot">): Promise<FixedTestGate> {
  return fixedTestGateFromConfig(parse(await readFile(path.join(state.itemRoot, "snapshot", "config.yaml"), "utf8")));
}

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export type EvidenceLevel = "trusted" | "attested" | "reported";

export interface UnsignedGateEvidence {
  evidenceId: string;
  level: EvidenceLevel;
  gateId: string;
  codeRevision: string;
  baselineTreeDigest: string;
  workspaceTreeDigest: string;
  configDigest: string;
  attemptId: string;
  result: "passed" | "failed";
}

export interface GateEvidence extends UnsignedGateEvidence {
  recordHash: string;
}

export function evidenceRecordHash(evidence: UnsignedGateEvidence): string {
  const encoded = canonicalize(evidence);
  if (encoded === undefined) throw new VerificationError("WSSPEC_EVIDENCE_INVALID", "Evidence 无法规范化。");
  return sha256(encoded);
}

export function assertImplementHasTrustedRed(input: {
  taskId: string;
  commandId: string;
  gate?: FixedTestGate;
  worktree: string;
  redEvidence: TrustedEvidence | undefined;
  requireWorkspaceMatch?: boolean;
}): Promise<void> {
  const evidence = parseTrustedEvidence(input.redEvidence);
  if (evidence === undefined || evidence.phase !== "red" || evidence.taskId !== input.taskId) {
    throw new VerificationError("WSSPEC_TDD_RED_REQUIRED", "acquire implement 前必须存在引擎产生的可信 Red Evidence。 ");
  }
  return Promise.all([
    testFileManifest(input.worktree, evidence.testPaths, evidence.testPathRules),
    testAssetScopeManifest(input.worktree, { testAssetPaths: evidence.testAssetPaths, testAssetRoots: evidence.testAssetRoots, productPaths: evidence.productPaths }),
    computeWorkspaceTreeDigest(input.worktree),
    input.gate === undefined ? Promise.resolve(evidence.commandDigest) : fixedGateCommandDigest(input.gate, input.worktree),
  ]).then(([manifest, assets, workspaceDigest, commandDigest]) => {
    if (evidence.commandId !== input.commandId || evidence.commandDigest !== commandDigest) {
      throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Red Evidence 的命令、环境或可执行文件已变化。 ");
    }
    if (manifest.digest !== evidence.testPathsDigest
      || assets.digest !== evidence.testAssetsDigest
      || (input.gate !== undefined && (JSON.stringify(input.gate.testAssetPaths) !== JSON.stringify(evidence.testAssetPaths)
        || JSON.stringify(input.gate.testAssetRoots) !== JSON.stringify(evidence.testAssetRoots)
        || JSON.stringify(input.gate.productPaths) !== JSON.stringify(evidence.productPaths)))
      || (input.requireWorkspaceMatch === true && workspaceDigest !== evidence.workspaceDigest)) {
      throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Red 测试内容已修改或删除。 ");
    }
  });
}

export function evaluateReviewFixEvidence(input: {
  modifiedFiles: readonly string[];
  cycle: TddCycleEvidence;
}): { action: "append-green"; commandId: string } | { action: "restart-cycle"; nextStepId: "write-tests" } {
  return input.modifiedFiles.some((filename) => {
    const normalized = filename.replaceAll("\\", "/");
    return isTrustedTestAssetPath(normalized, input.cycle);
  })
    ? { action: "restart-cycle", nextStepId: "write-tests" }
    : { action: "append-green", commandId: input.cycle.commandId };
}

export function evidenceProjectionKey(stageId: string, gateId: string): string {
  return `${stageId}:gate:${gateId}`;
}

function gateEvidence(value: unknown): GateEvidence | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<GateEvidence>;
  if (typeof record.evidenceId !== "string"
    || (record.level !== "trusted" && record.level !== "attested" && record.level !== "reported")
    || typeof record.gateId !== "string"
    || typeof record.codeRevision !== "string"
    || typeof record.baselineTreeDigest !== "string"
    || typeof record.workspaceTreeDigest !== "string"
    || typeof record.configDigest !== "string"
    || typeof record.attemptId !== "string"
    || (record.result !== "passed" && record.result !== "failed")
    || typeof record.recordHash !== "string") return undefined;
  return record as GateEvidence;
}

const evidenceStrength: Record<EvidenceLevel, number> = { reported: 0, attested: 1, trusted: 2 };

export function isFreshGateEvidence(input: {
  evidence: unknown;
  gateId: string;
  attemptId: string;
  requiredLevel: EvidenceLevel;
  workspaceTreeDigest: string;
  configDigest: string;
}): boolean {
  const record = gateEvidence(input.evidence);
  if (record === undefined) return false;
  const { recordHash: _recordHash, ...unsigned } = record;
  return record.gateId === input.gateId
    && record.attemptId === input.attemptId
    && evidenceStrength[record.level] >= evidenceStrength[input.requiredLevel]
    && record.result === "passed"
    && record.workspaceTreeDigest === input.workspaceTreeDigest
    && record.configDigest === input.configDigest
    && record.recordHash === evidenceRecordHash(unsigned);
}

function flatten(steps: readonly SnapshotStep[]): SnapshotStep[] {
  return steps.flatMap((step) => [step, ...flatten(step.steps)]);
}

function stepForEvidence(steps: readonly SnapshotStep[], stageId: string): SnapshotStep | undefined {
  const direct = flatten(steps).find(({ id }) => id === stageId);
  if (direct !== undefined) return direct;
  const childId = stageId.split(":").at(-1);
  return childId === undefined ? undefined : flatten(steps).find(({ id }) => id === childId);
}

export async function recordGateEvidence(input: {
  cwd: string;
  workItemId: string;
  stageId: string;
  actor: string;
  evidence: GateEvidence;
}): Promise<GateEvidence> {
  const evidence = validate<GateEvidence>("builtin.evidence.v1", input.evidence);
  const { recordHash: _recordHash, ...unsigned } = evidence;
  if (evidence.recordHash !== evidenceRecordHash(unsigned)) {
    throw new VerificationError("WSSPEC_EVIDENCE_HASH_MISMATCH", "Evidence recordHash 与内容不一致。");
  }
  const state = await loadApplicationState(input.cwd, input.workItemId);
  const profile = selectedProfile(state.snapshot);
  const step = stepForEvidence(profile.steps, input.stageId);
  const gate = state.snapshot.gates.find(({ id }) => id === evidence.gateId);
  if (step === undefined || !step.gates.includes(evidence.gateId) || gate === undefined) {
    throw new VerificationError("WSSPEC_GATE_NOT_REQUIRED", `步骤 ${input.stageId} 未声明 Gate ${evidence.gateId}。`);
  }
  if (evidenceStrength[evidence.level] < evidenceStrength[gate.evidence]) {
    throw new VerificationError("WSSPEC_EVIDENCE_LEVEL_INSUFFICIENT", `Gate ${evidence.gateId} 的 Evidence 信任级别不足。`);
  }
  const assertFresh = async (): Promise<void> => {
    if (evidence.baselineTreeDigest !== state.item.execution.baselineTreeDigest
      || evidence.configDigest !== state.item.execution.configDigest
      || evidence.workspaceTreeDigest !== await computeWorkspaceTreeDigest(state.worktree)) {
      throw new VerificationError("WSSPEC_EVIDENCE_STALE", `Gate ${evidence.gateId} 的 Evidence 与当前执行快照不一致。`);
    }
  };
  await assertFresh();
  const context = state.projection.contexts[input.stageId] as { workPackage?: { attemptId?: unknown } } | undefined;
  if (context?.workPackage?.attemptId !== evidence.attemptId) {
    throw new VerificationError("WSSPEC_EVIDENCE_ATTEMPT_MISMATCH", `Gate ${evidence.gateId} 未绑定当前 Attempt。`);
  }

  return mutateControlPlane({
    cwd: input.cwd,
    workItemId: input.workItemId,
    eventType: "evidence.recorded",
    idempotencyKey: `evidence:${evidence.evidenceId}`,
    actor: input.actor,
    stageId: input.stageId,
    attemptId: evidence.attemptId,
    operationInput: evidence,
    mutate: async (current) => {
      await assertFresh();
      const currentContext = current.contexts[input.stageId] as { workPackage?: { attemptId?: unknown } } | undefined;
      if (currentContext?.workPackage?.attemptId !== evidence.attemptId) {
        throw new VerificationError("WSSPEC_EVIDENCE_ATTEMPT_MISMATCH", `Gate ${evidence.gateId} 未绑定当前 Attempt。`);
      }
      return {
        projection: {
          ...current,
          evidence: { ...current.evidence, [evidenceProjectionKey(input.stageId, evidence.gateId)]: evidence },
        },
        value: evidence,
      };
    },
  });
}
