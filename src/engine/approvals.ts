import { readFile } from "node:fs/promises";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";

import { computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import { verifyArtifact } from "../domain/artifacts.js";
import type { ArtifactReference } from "../protocol/work-package.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { readControlPlane, resolveWorkItemContext, type RuntimeApproval } from "../storage/control-plane.js";
import { mutateControlPlane } from "./scheduler.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

type ApprovalArtifactReference = Pick<NonNullable<RuntimeApproval["artifacts"]>[number], "artifactType" | "outputId" | "artifactId" | "schemaVersion" | "path" | "revision" | "contentHash" | "mediaType">;

function normalizedApprovalArtifact(artifact: ApprovalArtifactReference): Record<string, unknown> {
  return {
    artifactType: artifact.artifactType,
    outputId: artifact.outputId ?? null,
    artifactId: artifact.artifactId ?? null,
    schemaVersion: artifact.schemaVersion,
    path: artifact.path,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
    mediaType: artifact.mediaType ?? null,
  };
}

export function sortApprovalArtifacts<T extends ApprovalArtifactReference>(artifacts: readonly T[]): T[] {
  return artifacts.map((artifact) => {
    const key = canonicalize(normalizedApprovalArtifact(artifact));
    if (key === undefined) throw new ApprovalError("WSSPEC_APPROVAL_DIGEST_INVALID", "审批 Artifact 引用无法规范化。");
    return { artifact, key: Buffer.from(key, "utf8") };
  }).sort((left, right) => Buffer.compare(left.key, right.key)).map(({ artifact }) => artifact);
}

export class ApprovalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ApprovalError"; }
}

export function approvalBindingDigest(input: {
  stageId: string;
  attemptId: string;
  artifacts: readonly Pick<NonNullable<RuntimeApproval["artifacts"]>[number], "artifactType" | "outputId" | "artifactId" | "schemaVersion" | "path" | "revision" | "contentHash" | "mediaType">[];
}): string {
  const binding = canonicalize({
    version: 1,
    stageId: input.stageId,
    attemptId: input.attemptId,
    artifacts: sortApprovalArtifacts(input.artifacts).map(normalizedApprovalArtifact),
  });
  if (binding === undefined) throw new ApprovalError("WSSPEC_APPROVAL_DIGEST_INVALID", "审批 Artifact 引用无法规范化。");
  return sha256(binding);
}

export async function prepareArtifactApproval(input: {
  cwd: string;
  workItemId: string;
  stageId: string;
  attemptId: string;
  artifacts: ArtifactReference[];
  actor?: string;
  now?: Date;
}): Promise<RuntimeApproval> {
  const context = await resolveWorkItemContext(input.cwd, input.workItemId);
  const worktree = context.executionWorktree;
  const artifactRoot = context.materialized ? worktree : context.authorityRoot;
  const physicalArtifactPath = (referencePath: string): string => context.materialized
    ? path.join(artifactRoot, referencePath)
    : path.join(artifactRoot, referencePath.replace(`.wsspec/work-items/${input.workItemId}/`, ""));
  const artifacts = await Promise.all(input.artifacts.map(async (reference) => {
    if (reference.path === undefined) throw new ApprovalError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `Artifact ${reference.artifactType} 缺少路径。`);
    const verified = await verifyArtifact(physicalArtifactPath(reference.path), {
      repositoryRoot: artifactRoot,
      artifactType: reference.artifactType,
      workItemId: input.workItemId,
      stageId: input.stageId,
      attemptId: input.attemptId,
    });
    if ((reference.contentHash !== undefined && reference.contentHash !== verified.contentHash)
      || (reference.revision !== undefined && reference.revision !== verified.revision)) {
      throw new ApprovalError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `Artifact ${reference.artifactType} 引用与文件不一致。`);
    }
    return { ...verified, path: reference.path };
  }));
  const sortedArtifacts = sortApprovalArtifacts(artifacts);
  const artifactContents = await Promise.all(sortedArtifacts.map(async (artifact) => ({
    artifact,
    content: await readFile(physicalArtifactPath(artifact.path), "utf8"),
  })));
  const contentHash = approvalBindingDigest({ stageId: input.stageId, attemptId: input.attemptId, artifacts: sortedArtifacts });
  const artifactPath = sortedArtifacts[0]?.path;
  const artifactDiff = artifactContents
    .map(({ artifact, content }) => `--- /dev/null\n+++ ${artifact.path}\n${content.split("\n").map((line) => `+${line}`).join("\n")}`)
    .join("\n")
    .slice(0, 65536);
  return {
    requestId: `approval-${crypto.randomUUID()}`,
    stageId: input.stageId,
    attemptId: input.attemptId,
    ...(artifactPath === undefined ? {} : { artifactPath }),
    contentHash,
    artifacts: sortedArtifacts,
    ...(artifactDiff === "" ? {} : { artifactDiff }),
    workspaceTreeDigest: await computeWorkspaceTreeDigest(worktree),
    requestedBy: input.actor ?? "engine",
    status: "pending",
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

async function worktreeFor(cwd: string, workItemId: string): Promise<string> {
  return (await resolveWorkItemContext(cwd, workItemId)).executionWorktree;
}

export async function requestArtifactApproval(input: { cwd: string; workItemId: string; stageId: string; attemptId: string; artifactPath: string; artifactType: string; actor?: string }): Promise<RuntimeApproval> {
  let projection = await readControlPlane(input.cwd, input.workItemId);
  if (projection.stages[input.stageId]?.status !== "validating") throw new ApprovalError("WSSPEC_APPROVAL_NOT_READY", "Stage 尚未进入 validating。");
  const request = await prepareArtifactApproval({
    ...input,
    artifacts: [{ artifactType: input.artifactType, schemaVersion: 1, path: input.artifactPath }],
  });
  return mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "approval.requested", idempotencyKey: `approval-request:${request.requestId}`,
    stageId: input.stageId, attemptId: input.attemptId, operationInput: request,
    mutate: (current) => {
      if (current.stages[input.stageId]?.status !== "validating") throw new ApprovalError("WSSPEC_APPROVAL_NOT_READY", "Stage 尚未进入 validating。");
      const next = {
        ...current,
        workItem: transitionWorkItem(current.workItem, { type: "transition", to: "awaiting_approval" }),
        stages: { ...current.stages, [input.stageId]: transitionStage(current.stages[input.stageId]!, { type: "transition", to: "awaiting_approval" }) },
        approvals: { ...current.approvals, [request.requestId]: request },
      };
      return { projection: next, value: request };
    },
  });
}

function assertPendingApproval(
  current: Awaited<ReturnType<typeof readControlPlane>>,
  request: RuntimeApproval | undefined,
  expectedDigest?: string,
): RuntimeApproval {
  if (request === undefined) {
    throw new ApprovalError("WSSPEC_APPROVAL_NOT_PENDING", "审批请求不存在、已经处理或绑定已变化。");
  }
  const pending = current.approvals[request.requestId];
  if (pending?.status !== "pending"
    || current.stages[pending.stageId]?.status !== "awaiting_approval") {
    throw new ApprovalError("WSSPEC_APPROVAL_NOT_PENDING", "审批请求不存在、已经处理或绑定已变化。");
  }
  if (expectedDigest !== undefined && pending.contentHash !== expectedDigest) {
    throw new ApprovalError("WSSPEC_APPROVAL_DIGEST_MISMATCH", "审批摘要与当前请求不一致。");
  }
  if (pending.stageId !== request.stageId
    || pending.attemptId !== request.attemptId
    || pending.contentHash !== request.contentHash
    || pending.workspaceTreeDigest !== request.workspaceTreeDigest
    || pending.requestedBy !== request.requestedBy
    || JSON.stringify(pending.artifacts) !== JSON.stringify(request.artifacts)) {
    throw new ApprovalError("WSSPEC_APPROVAL_NOT_PENDING", "审批请求不存在、已经处理或绑定已变化。");
  }
  return pending;
}

async function verifyApprovalArtifacts(cwd: string, workItemId: string, request: RuntimeApproval): Promise<void> {
  const context = await resolveWorkItemContext(cwd, workItemId);
  const artifactRoot = context.materialized ? context.executionWorktree : context.authorityRoot;
  const references = request.artifacts ?? (request.artifactPath === undefined ? [] : [{
    artifactType: path.basename(request.artifactPath, ".md"),
    schemaVersion: 1,
    path: request.artifactPath,
    contentHash: request.contentHash,
    revision: 1,
  }]);
  const verifiedReferences = await Promise.all(references.map(async (reference) => {
    const physicalPath = context.materialized
      ? reference.path
      : reference.path.replace(`.wsspec/work-items/${workItemId}/`, "");
    const verified = await verifyArtifact(path.join(artifactRoot, physicalPath), {
      repositoryRoot: artifactRoot,
      artifactType: reference.artifactType,
      workItemId,
      stageId: request.stageId,
      attemptId: request.attemptId,
    });
    return { ...verified, path: reference.path };
  }));
  const sortedVerifiedReferences = sortApprovalArtifacts(verifiedReferences);
  if (request.artifacts !== undefined) {
    const boundReferences = sortApprovalArtifacts(request.artifacts);
    if (sortedVerifiedReferences.some((verified, index) => {
      const bound = boundReferences[index];
      return bound === undefined
        || verified.artifactType !== bound.artifactType
        || verified.path !== bound.path
        || verified.revision !== bound.revision
        || verified.contentHash !== bound.contentHash;
    })) {
      throw new ApprovalError("WSSPEC_APPROVAL_DIGEST_MISMATCH", "审批绑定的 Artifact 引用已经变化。");
    }
  }
  const verifiedDigest = approvalBindingDigest({ stageId: request.stageId, attemptId: request.attemptId, artifacts: sortedVerifiedReferences });
  if (verifiedDigest !== request.contentHash) throw new ApprovalError("WSSPEC_APPROVAL_DIGEST_MISMATCH", "审批绑定的 Artifact 集合摘要已经变化。");
}

async function expireArtifactApproval(input: { cwd: string; workItemId: string; request: RuntimeApproval; worktree: string }): Promise<void> {
  await mutateControlPlane({
    cwd: input.cwd,
    workItemId: input.workItemId,
    eventType: "approval.expired",
    idempotencyKey: `approval-expired:${input.request.requestId}`,
    stageId: input.request.stageId,
    attemptId: input.request.attemptId,
    operationInput: { requestId: input.request.requestId, workspaceTreeDigest: input.request.workspaceTreeDigest },
    mutate: async (current) => {
      const pending = assertPendingApproval(current, input.request);
      if (await computeWorkspaceTreeDigest(input.worktree) === pending.workspaceTreeDigest) {
        throw new ApprovalError("WSSPEC_APPROVAL_NOT_EXPIRED", "审批绑定的工作区当前未变化，请重试决定。");
      }
      const expired: RuntimeApproval = { ...pending, status: "expired", decidedAt: new Date().toISOString() };
      return { projection: { ...current, approvals: { ...current.approvals, [pending.requestId]: expired } }, value: expired };
    },
  });
}

export async function decideArtifactApproval(input: { cwd: string; workItemId: string; requestId: string; decision: "approve" | "reject"; terminal: { isTTY?: boolean }; reason?: string; actor?: string; expectedDigest?: string }): Promise<RuntimeApproval> {
  if (input.terminal.isTTY !== true) throw new ApprovalError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "批准或拒绝必须来自真实交互式 TTY。");
  const projection = await readControlPlane(input.cwd, input.workItemId);
  const request = projection.approvals[input.requestId];
  const worktree = await worktreeFor(input.cwd, input.workItemId);
  try {
    return await mutateControlPlane({
      cwd: input.cwd, workItemId: input.workItemId, eventType: "approval.decided", idempotencyKey: `approval-decision:${input.requestId}`,
      ...(request === undefined ? {} : { stageId: request.stageId, attemptId: request.attemptId }),
      actor: input.actor ?? "interactive-user", operationInput: { requestId: input.requestId, decision: input.decision, reason: input.reason ?? null, expectedDigest: input.expectedDigest ?? null },
      mutate: async (current) => {
        const pending = assertPendingApproval(current, request, input.expectedDigest);
        if (await computeWorkspaceTreeDigest(worktree) !== pending.workspaceTreeDigest) {
          throw new ApprovalError("WSSPEC_APPROVAL_EXPIRED", "审批绑定的工作区已经变化，请重新请求审批。");
        }
        await verifyApprovalArtifacts(input.cwd, input.workItemId, pending);
        const status = input.decision === "approve" ? "approved" : "rejected";
        const decided: RuntimeApproval = {
          ...pending,
          status,
          decidedBy: input.actor ?? "interactive-user",
          decidedAt: new Date().toISOString(),
        };
        const next = {
          ...current,
          workItem: transitionWorkItem(current.workItem, { type: "transition", to: "active" }),
          stages: { ...current.stages, [pending.stageId]: transitionStage(current.stages[pending.stageId]!, { type: "transition", to: input.decision === "approve" ? "succeeded" : "revision_required" }) },
          approvals: { ...current.approvals, [pending.requestId]: decided },
        };
        return { projection: next, value: decided };
      },
    });
  } catch (error) {
    if (!(error instanceof ApprovalError) || error.code !== "WSSPEC_APPROVAL_EXPIRED") throw error;
    if (request === undefined) throw error;
    await expireArtifactApproval({ cwd: input.cwd, workItemId: input.workItemId, request, worktree });
    throw error;
  }
}
