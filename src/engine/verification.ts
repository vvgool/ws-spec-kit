import * as canonicalizeModule from "canonicalize";

import { computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import { validate } from "../schemas/index.js";
import { mutateControlPlane } from "./scheduler.js";
import { loadApplicationState, selectedProfile, type SnapshotStep } from "../application/state.js";

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

export class VerificationError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "VerificationError";
  }
}

export function evidenceRecordHash(evidence: UnsignedGateEvidence): string {
  const encoded = canonicalize(evidence);
  if (encoded === undefined) throw new VerificationError("WSSPEC_EVIDENCE_INVALID", "Evidence 无法规范化。");
  return sha256(encoded);
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
