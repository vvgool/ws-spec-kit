import { readFile } from "node:fs/promises";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";

import { computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import { verifyArtifact } from "../domain/artifacts.js";
import type { ConversationConfirmation } from "../protocol/application.js";
import type { ArtifactReference } from "../protocol/work-package.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { readControlPlane, resolveWorkItemContext, type RuntimeApproval } from "../storage/control-plane.js";
import { inspectCredentialText } from "../registry/connectors/secret-detector.js";
import { mutateControlPlane } from "./scheduler.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

type ApprovalArtifactReference = Pick<NonNullable<RuntimeApproval["artifacts"]>[number], "artifactType" | "outputId" | "artifactId" | "schemaVersion" | "path" | "revision" | "contentHash" | "mediaType">;

export function approvalRevisionEvidenceKey(stageId: string): string {
  return `approval-revision:${stageId}`;
}

const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const privateKey = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----|(?:^|\s)OPENSSH PRIVATE KEY(?:\s|$)/iu;
const awsAccessKey = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u;
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u;
const passwordConnectionString = /\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@|(?:password|pwd)\s*=\s*[^;\s]+)/iu;

export function normalizeApprovalFeedback(raw: string): string {
  const feedback = raw.replace(/\r\n?/gu, "\n").trim();
  if (feedback === "" || unpairedSurrogate.test(feedback) || Buffer.byteLength(feedback, "utf8") > 8192
    || privateKey.test(feedback) || awsAccessKey.test(feedback) || jwt.test(feedback) || passwordConnectionString.test(feedback)
    || !inspectCredentialText(feedback, 8192).ok) {
    throw new ApprovalError("WSSPEC_APPROVAL_FEEDBACK_INVALID", "修改意见为空、过长、编码异常或包含凭据样式内容。");
  }
  return feedback;
}

export function approvalFeedbackDigest(feedback: string): string {
  return sha256(normalizeApprovalFeedback(feedback));
}

export interface RejectionConfirmation {
  requestId: string;
  expectedDigest: string;
  actor: string;
  feedbackDigest: string;
  tokenHash: string;
  issuedAt: string;
  consumedAt?: string;
}

export function rejectionConfirmationEvidenceKey(tokenHash: string): string {
  return `approval-rejection-confirmation:${tokenHash}`;
}

export async function confirmArtifactRejection(input: { cwd: string; workItemId: string; requestId: string; expectedDigest: string; actor: string; feedback: string; terminal: { isTTY?: boolean } }): Promise<{ token: string; feedbackDigest: string }> {
  if (input.terminal.isTTY !== true) throw new ApprovalError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "修改意见确认必须来自真实交互式 TTY。");
  const feedbackDigest = approvalFeedbackDigest(input.feedback);
  const confirmationIdentity = sha256(canonicalize({
    requestId: input.requestId,
    expectedDigest: input.expectedDigest,
    actor: input.actor,
    feedbackDigest,
  })!);
  const token = `rejection-${confirmationIdentity.slice("sha256:".length)}`;
  const tokenHash = sha256(token);
  const confirmation: RejectionConfirmation = {
    requestId: input.requestId, expectedDigest: input.expectedDigest, actor: input.actor, feedbackDigest, tokenHash,
    issuedAt: new Date().toISOString(),
  };
  await mutateControlPlane<RejectionConfirmation>({
      cwd: input.cwd, workItemId: input.workItemId, eventType: "approval.rejection-confirmed",
      idempotencyKey: `approval-rejection-confirmation:${confirmationIdentity}`, actor: input.actor,
      operationInput: { requestId: input.requestId, expectedDigest: input.expectedDigest, actor: input.actor, feedbackDigest },
      mutate: (current) => {
        const request = assertPendingApproval(current, current.approvals[input.requestId], input.expectedDigest);
        if (request.contentHash !== input.expectedDigest) throw new ApprovalError("WSSPEC_APPROVAL_DIGEST_MISMATCH", "审批摘要与当前请求不一致。");
        return { projection: { ...current, evidence: { ...current.evidence, [rejectionConfirmationEvidenceKey(tokenHash)]: confirmation } }, value: confirmation };
      },
    });
  return { token, feedbackDigest };
}

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

export async function decideArtifactApproval<T = RuntimeApproval>(input: { cwd: string; workItemId: string; requestId: string; decision: "approve" | "reject"; terminal: { isTTY?: boolean }; confirmation?: ConversationConfirmation; feedback?: string; rejectionToken?: string; reason?: string; actor?: string; expectedDigest?: string; finalize?: (projection: Awaited<ReturnType<typeof readControlPlane>>, approval: RuntimeApproval) => Promise<{ projection: Awaited<ReturnType<typeof readControlPlane>>; value: T }> }): Promise<T> {
  let confirmation: ConversationConfirmation | undefined;
  if (input.confirmation !== undefined) {
    if (input.decision !== "approve" || input.confirmation?.source !== "conversation"
      || typeof input.confirmation.userMessage !== "string" || !input.actor?.trim() || !input.expectedDigest) {
      throw new ApprovalError("WSSPEC_APPROVAL_CONFIRMATION_INVALID", "对话确认只适用于步骤批准，且必须绑定用户原话、actor 和当前审批摘要。");
    }
    try {
      confirmation = { source: "conversation", userMessage: normalizeApprovalFeedback(input.confirmation.userMessage) };
    } catch {
      throw new ApprovalError("WSSPEC_APPROVAL_CONFIRMATION_INVALID", "用户确认内容为空、过长、编码异常或包含凭据样式内容。");
    }
  }
  const rawFeedback = input.feedback ?? (input.terminal.isTTY === true ? input.reason : undefined);
  const feedback = rawFeedback === undefined ? undefined : normalizeApprovalFeedback(rawFeedback);
  if (input.decision === "approve" && (feedback !== undefined || input.rejectionToken !== undefined)) {
    throw new ApprovalError("WSSPEC_APPROVAL_FEEDBACK_NOT_ALLOWED", "批准决定不能携带修改意见或拒绝确认凭据。");
  }
  if (input.terminal.isTTY === true && input.rejectionToken !== undefined) {
    throw new ApprovalError("WSSPEC_APPROVAL_FEEDBACK_NOT_ALLOWED", "TTY 拒绝决定不能携带拒绝确认凭据。");
  }
  if (input.terminal.isTTY !== true && confirmation === undefined && !(input.decision === "reject" && feedback !== undefined && input.rejectionToken !== undefined)) {
    throw new ApprovalError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "普通步骤批准可携带 confirmation 记录用户对当前版本的明确同意；未提供确认的批准或无反馈拒绝需要交互式 TTY。");
  }
  const tokenHash = input.rejectionToken === undefined ? undefined : sha256(input.rejectionToken);
  const projection = await readControlPlane(input.cwd, input.workItemId);
  const request = projection.approvals[input.requestId];
  const worktree = await worktreeFor(input.cwd, input.workItemId);
  try {
    return await mutateControlPlane({
      cwd: input.cwd, workItemId: input.workItemId, eventType: "approval.decided", idempotencyKey: `approval-decision:${input.requestId}`,
      ...(request === undefined ? {} : { stageId: request.stageId, attemptId: request.attemptId }),
      actor: input.actor ?? "interactive-user", operationInput: { requestId: input.requestId, decision: input.decision, feedback: feedback ?? null, tokenHash: tokenHash ?? null, expectedDigest: input.expectedDigest ?? null, ...(confirmation === undefined ? {} : { confirmation, actor: input.actor }) },
      mutate: async (current) => {
        const pending = assertPendingApproval(current, request, input.expectedDigest);
        let evidence = current.evidence;
        if (input.terminal.isTTY !== true && confirmation === undefined) {
          const key = rejectionConfirmationEvidenceKey(tokenHash!);
          const confirmation = current.evidence[key] as RejectionConfirmation | undefined;
          if (confirmation === undefined) throw new ApprovalError("WSSPEC_REJECTION_CONFIRMATION_INVALID", "拒绝确认凭据不存在或无效。");
          if (confirmation.consumedAt !== undefined) throw new ApprovalError("WSSPEC_REJECTION_CONFIRMATION_USED", "拒绝确认凭据已经使用。");
          if (confirmation.requestId !== input.requestId || confirmation.expectedDigest !== input.expectedDigest
            || confirmation.actor !== (input.actor ?? "interactive-user") || confirmation.feedbackDigest !== approvalFeedbackDigest(feedback!)) {
            throw new ApprovalError("WSSPEC_REJECTION_CONFIRMATION_MISMATCH", "拒绝确认凭据与请求、actor 或修改意见不匹配。");
          }
          evidence = { ...current.evidence, [key]: { ...confirmation, consumedAt: new Date().toISOString() } };
        }
        if (await computeWorkspaceTreeDigest(worktree) !== pending.workspaceTreeDigest) {
          throw new ApprovalError("WSSPEC_APPROVAL_EXPIRED", "审批绑定的工作区已经变化，请重新请求审批。");
        }
        await verifyApprovalArtifacts(input.cwd, input.workItemId, pending);
        const status = input.decision === "approve" ? "approved" : "rejected";
        const decided: RuntimeApproval = {
          ...pending,
          status,
          decidedBy: input.actor ?? "interactive-user",
          decisionSource: confirmation !== undefined ? "agent_transcribed" : input.terminal.isTTY === true ? "terminal" : "terminal_token",
          ...(confirmation === undefined ? {} : { confirmation }),
          decidedAt: new Date().toISOString(),
          ...(feedback === undefined ? {} : { feedback }),
        };
        const next = {
          ...current,
          workItem: transitionWorkItem(current.workItem, { type: "transition", to: "active" }),
          stages: { ...current.stages, [pending.stageId]: transitionStage(current.stages[pending.stageId]!, { type: "transition", to: input.decision === "approve" ? "succeeded" : "revision_required" }) },
          approvals: { ...current.approvals, [pending.requestId]: decided },
          evidence: input.decision === "approve" ? evidence : {
            ...evidence,
            [approvalRevisionEvidenceKey(pending.stageId)]: pending.requestId,
          },
        };
        return input.finalize === undefined ? { projection: next, value: decided as T } : input.finalize(next, decided);
      },
    });
  } catch (error) {
    if (!(error instanceof ApprovalError) || error.code !== "WSSPEC_APPROVAL_EXPIRED") throw error;
    if (request === undefined) throw error;
    await expireArtifactApproval({ cwd: input.cwd, workItemId: input.workItemId, request, worktree });
    throw error;
  }
}
