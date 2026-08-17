import { sha256 } from "../domain/digests.js";
import { createWorkflowTrustRequest, decideWorkflowTrustRequest, readWorkflowTrustRecords } from "../storage/workflow-trust.js";
import { builtinWorkflowPackageProvenance } from "./loader.js";
import type { WorkflowPackage, WorkflowTrustDecision, WorkflowTrustRecord, WorkflowTrustSummary } from "./types.js";
import { WorkflowPackageError } from "./types.js";

interface EvaluateWorkflowTrustBase {
  root: string;
  pkg: WorkflowPackage;
}

export type EvaluateWorkflowTrustInput =
  | EvaluateWorkflowTrustBase & { interactive: false }
  | EvaluateWorkflowTrustBase & { interactive: true; actor: string; channel: "interactive" };

export interface RecordWorkflowTrustInput {
  root: string;
  pkg: WorkflowPackage;
  decision: "trusted" | "rejected";
  actor: string;
  requestId: string;
  expectedPackageDigest: string;
  expectedCapabilityDigest: string;
}


export function workflowCapabilities(pkg: WorkflowPackage): string[] {
  return [...new Set([...(pkg.manifest.capabilities ?? []), ...(pkg.manifest.externalSideEffects ?? [])])].sort();
}

export function workflowCapabilityDigest(pkg: WorkflowPackage): string {
  return sha256(`${JSON.stringify({ version: 1, capabilities: workflowCapabilities(pkg) })}\n`);
}

export function workflowTrustSummary(pkg: WorkflowPackage, requestId = crypto.randomUUID()): WorkflowTrustSummary {
  return {
    requestId,
    packageRef: pkg.ref,
    packageDigest: pkg.contentDigest,
    capabilityDigest: workflowCapabilityDigest(pkg),
    fileDigests: [...pkg.files].map(({ path, digest }) => ({ path, digest })),
    skillDigests: [...pkg.packageSkills.entries()].map(([ref, skill]) => ({ ref, digest: skill.digest })).sort((left, right) => left.ref.localeCompare(right.ref)),
    capabilities: workflowCapabilities(pkg),
  };
}

function builtinRecord(pkg: WorkflowPackage): WorkflowTrustRecord {
  return { requestId: `builtin:${pkg.ref}`, packageRef: pkg.ref, packageDigest: pkg.contentDigest, capabilityDigest: workflowCapabilityDigest(pkg), decision: "trusted", actor: "builtin", decidedAt: "1970-01-01T00:00:00.000Z" };
}

export async function evaluateWorkflowTrust(input: EvaluateWorkflowTrustInput): Promise<WorkflowTrustDecision> {
  const builtinProvenance = await builtinWorkflowPackageProvenance(input.pkg);
  if (input.pkg.ref.startsWith("builtin://")) {
    if (builtinProvenance === undefined) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_BUILTIN_PROVENANCE_INVALID", "Builtin Workflow Package 缺少可验证的发布来源。");
    return { status: "trusted", record: builtinRecord(input.pkg) };
  }
  const summary = workflowTrustSummary(input.pkg);
  const records = await readWorkflowTrustRecords(input.root);
  const record = [...records].reverse().find((item) => item.packageDigest === summary.packageDigest && item.capabilityDigest === summary.capabilityDigest);
  if (record?.decision === "trusted") return { status: "trusted", record };
  if (record?.decision === "rejected") return { status: "rejected", record };
  if (!input.interactive) throw new WorkflowPackageError("WSSPEC_WORKFLOW_TRUST_REQUIRED", "非交互环境不能默认信任 Workflow Package。");
  if (input.channel !== "interactive") throw new WorkflowPackageError("WSSPEC_WORKFLOW_TRUST_CHANNEL_INVALID", "Workflow Package 信任请求必须来自可信交互通道。");
  if (input.actor === "") throw new WorkflowPackageError("WSSPEC_WORKFLOW_TRUST_ACTOR_INVALID", "Workflow Package 信任请求必须绑定操作者。");
  const createdAt = new Date().toISOString();
  await createWorkflowTrustRequest(input.root, { event: "requested", requestId: summary.requestId, packageRef: summary.packageRef, packageDigest: summary.packageDigest, capabilityDigest: summary.capabilityDigest, actor: input.actor, channel: input.channel, createdAt, expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString() });
  return { status: "approval_required", summary };
}

export async function recordWorkflowTrust(input: RecordWorkflowTrustInput): Promise<WorkflowTrustRecord> {
  if (input.pkg.ref.startsWith("builtin://")) throw new WorkflowPackageError("WSSPEC_WORKFLOW_TRUST_BUILTIN_MANAGED", "内置 Workflow Package 只能使用内置信任来源。");
  const summary = workflowTrustSummary(input.pkg);
  if (input.expectedPackageDigest !== summary.packageDigest) throw new WorkflowPackageError("WSSPEC_WORKFLOW_TRUST_CHANGED", "Workflow Package 内容已变化，请重新确认。");
  if (input.expectedCapabilityDigest !== summary.capabilityDigest) throw new WorkflowPackageError("WSSPEC_WORKFLOW_TRUST_CHANGED", "Workflow Package 能力已变化，请重新确认。");
  if (input.actor === "") throw new WorkflowPackageError("WSSPEC_WORKFLOW_TRUST_ACTOR_INVALID", "信任决定必须记录操作者。");
  return decideWorkflowTrustRequest(input.root, { requestId: input.requestId, packageRef: input.pkg.ref, packageDigest: summary.packageDigest, capabilityDigest: summary.capabilityDigest, decision: input.decision, actor: input.actor, decidedAt: new Date().toISOString() });
}
