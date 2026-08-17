import { readFile } from "node:fs/promises";
import path from "node:path";

import { computeWorkspaceTreeDigest } from "../domain/digests.js";
import { verifyArtifact } from "../domain/artifacts.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { readControlPlane, type RuntimeApproval } from "../storage/control-plane.js";
import { mutateControlPlane } from "./scheduler.js";

export class ApprovalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ApprovalError"; }
}

async function worktreeFor(cwd: string, workItemId: string): Promise<string> {
  const projection = await readControlPlane(cwd, workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryRoot: string };
  return path.join(cache.repositoryRoot, locator.worktree);
}

export async function requestArtifactApproval(input: { cwd: string; workItemId: string; stageId: string; attemptId: string; artifactPath: string }): Promise<RuntimeApproval> {
  let projection = await readControlPlane(input.cwd, input.workItemId);
  if (projection.stages[input.stageId]?.status !== "validating") throw new ApprovalError("WSSPEC_APPROVAL_NOT_READY", "Stage 尚未进入 validating。");
  const worktree = await worktreeFor(input.cwd, input.workItemId);
  const artifact = await verifyArtifact(path.join(worktree, input.artifactPath), { repositoryRoot: worktree, artifactType: path.basename(input.artifactPath, ".md"), workItemId: input.workItemId, stageId: input.stageId, attemptId: input.attemptId });
  const artifactContent = await readFile(path.join(worktree, artifact.path), "utf8");
  const request: RuntimeApproval = { requestId: `approval-${crypto.randomUUID()}`, stageId: input.stageId, attemptId: input.attemptId, artifactPath: artifact.path, contentHash: artifact.contentHash, artifactDiff: `--- /dev/null\n+++ ${artifact.path}\n${artifactContent.split("\n").map((line) => `+${line}`).join("\n")}`.slice(0, 65536), workspaceTreeDigest: await computeWorkspaceTreeDigest(worktree), status: "pending", createdAt: new Date().toISOString() };
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

export async function decideArtifactApproval(input: { cwd: string; workItemId: string; requestId: string; decision: "approve" | "reject"; terminal: { isTTY?: boolean }; reason?: string }): Promise<RuntimeApproval> {
  if (input.terminal.isTTY !== true) throw new ApprovalError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "批准或拒绝必须来自真实交互式 TTY。");
  let projection = await readControlPlane(input.cwd, input.workItemId);
  const request = projection.approvals[input.requestId];
  if (request?.status !== "pending") throw new ApprovalError("WSSPEC_APPROVAL_NOT_PENDING", "审批请求不存在或已经处理。");
  const worktree = await worktreeFor(input.cwd, input.workItemId);
  const currentDigest = await computeWorkspaceTreeDigest(worktree);
  if (currentDigest !== request.workspaceTreeDigest) {
    const expired: RuntimeApproval = { ...request, status: "expired", decidedAt: new Date().toISOString() };
    await mutateControlPlane({
      cwd: input.cwd, workItemId: input.workItemId, eventType: "approval.expired", idempotencyKey: `approval-expired:${request.requestId}`,
      stageId: request.stageId, attemptId: request.attemptId, operationInput: { requestId: request.requestId, workspaceTreeDigest: currentDigest },
      mutate: (current) => ({ projection: { ...current, approvals: { ...current.approvals, [request.requestId]: expired } }, value: expired }),
    });
    throw new ApprovalError("WSSPEC_APPROVAL_EXPIRED", "审批绑定的工作区已经变化，请重新请求审批。");
  }
  await verifyArtifact(path.join(worktree, request.artifactPath), { repositoryRoot: worktree, artifactType: path.basename(request.artifactPath, ".md"), workItemId: input.workItemId, stageId: request.stageId, attemptId: request.attemptId });
  const status = input.decision === "approve" ? "approved" : "rejected";
  const decided: RuntimeApproval = { ...request, status, decidedAt: new Date().toISOString() };
  return mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "approval.decided", idempotencyKey: `approval-decision:${request.requestId}`,
    stageId: request.stageId, attemptId: request.attemptId, actor: "interactive-user", operationInput: { requestId: request.requestId, decision: input.decision, reason: input.reason ?? null },
    mutate: (current) => {
      const pending = current.approvals[request.requestId];
      if (pending?.status !== "pending") throw new ApprovalError("WSSPEC_APPROVAL_NOT_PENDING", "审批请求不存在或已经处理。");
      const next = {
        ...current,
        workItem: transitionWorkItem(current.workItem, { type: "transition", to: "active" }),
        stages: { ...current.stages, [request.stageId]: transitionStage(current.stages[request.stageId]!, { type: "transition", to: input.decision === "approve" ? "succeeded" : "revision_required" }) },
        approvals: { ...current.approvals, [request.requestId]: decided },
      };
      return { projection: next, value: decided };
    },
  });
}
