import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { computeWorkspaceTreeDigest } from "../domain/digests.js";
import { transitionWorkItem } from "../domain/states.js";
import { readControlPlane, writeArchiveSnapshot, type RuntimeProjection } from "../storage/control-plane.js";
import { mutateControlPlane } from "./scheduler.js";
import type { TrustedEvidence } from "./verification.js";

export class ArchiveError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ArchiveError"; } }

async function worktreeFor(projection: RuntimeProjection): Promise<string> {
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryRoot: string };
  return path.join(cache.repositoryRoot, locator.worktree);
}

export async function closeWorkItem(input: { cwd: string; workItemId: string; simulateArchiveFailure?: boolean }): Promise<RuntimeProjection> {
  let projection = await readControlPlane(input.cwd, input.workItemId);
  if (projection.workItem.status !== "verified") throw new ArchiveError("WSSPEC_WORK_ITEM_NOT_VERIFIED", "只有 verified Work Item 可以关闭。");
  const worktree = await worktreeFor(projection);
  const workflow = parse(await readFile(path.join(worktree, ".wsspec/work-items", input.workItemId, "snapshot/workflow.yaml"), "utf8")) as { stages: Array<{ id: string; kind: string }> };
  const exempt = new Set(workflow.stages.filter((stage) => ["verify", "publish", "close"].includes(stage.kind)).map((stage) => stage.id));
  const incomplete = Object.entries(projection.stages).find(([stageId, stage]) => !exempt.has(stageId) && !["succeeded", "succeeded_with_warnings", "skipped"].includes(stage.status));
  if (incomplete !== undefined) throw new ArchiveError("WSSPEC_REQUIRED_STAGE_INCOMPLETE", `必需 Stage ${incomplete[0]} 尚未完成。`);
  if (Object.values(projection.approvals).some((approval) => approval.status === "pending")) throw new ArchiveError("WSSPEC_APPROVAL_PENDING", "仍存在未处理审批。");
  const digest = await computeWorkspaceTreeDigest(worktree);
  const evidence = Object.values(projection.evidence) as TrustedEvidence[];
  if (!evidence.some((entry) => entry.level === "trusted" && entry.result === "passed" && entry.workspaceTreeDigest === digest)) throw new ArchiveError("WSSPEC_TRUSTED_EVIDENCE_MISSING", "缺少绑定当前工作区的可信 Evidence。");
  const closedAt = new Date().toISOString();
  await mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "work-item.closed", idempotencyKey: `close:${projection.lastEventHash}`,
    operationInput: { workspaceTreeDigest: digest },
    mutate: async (current) => {
      if (current.workItem.status !== "verified") throw new ArchiveError("WSSPEC_WORK_ITEM_NOT_VERIFIED", "只有 verified Work Item 可以关闭。");
      const currentDigest = await computeWorkspaceTreeDigest(worktree);
      if (currentDigest !== digest) throw new ArchiveError("WSSPEC_WORKSPACE_CHANGED", "关闭前工作区发生变化。");
      const currentEvidence = Object.values(current.evidence) as TrustedEvidence[];
      if (!currentEvidence.some((entry) => entry.level === "trusted" && entry.result === "passed" && entry.workspaceTreeDigest === digest)) throw new ArchiveError("WSSPEC_TRUSTED_EVIDENCE_MISSING", "缺少绑定当前工作区的可信 Evidence。");
      return { projection: { ...current, workItem: transitionWorkItem(current.workItem, { type: "transition", to: "closed" }), readOnly: true }, value: { closedAt, workspaceTreeDigest: digest } };
    },
  });
  projection = await readControlPlane(input.cwd, input.workItemId);
  if (input.simulateArchiveFailure === true) throw new ArchiveError("WSSPEC_ARCHIVE_WRITE_FAILED", "已提交关闭事件，但模拟的归档写入失败。");
  await writeArchiveSnapshot({ projection, worktree, closedAt, workspaceTreeDigest: digest });
  return projection;
}
