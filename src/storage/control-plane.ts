import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import type { StageState, WorkItemState } from "../domain/states.js";
import { sha256, type TreeEntry } from "../domain/digests.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { loadRepository } from "./repository.js";
import { appendEventUnlocked, EventStoreError, readEvents, recoverStaleControlPlaneLock, repairIncompleteEventTail, withControlPlaneLock, type DomainEvent, type StoredEvent } from "./events.js";
import { writeFileAtomic } from "./files.js";

export interface RuntimeProjection {
  version: 1;
  repositoryId: string;
  workItemId: string;
  workItem: WorkItemState;
  stages: Record<string, StageState>;
  lastSequence: number;
  lastEventHash: string | null;
  idempotency: Record<string, number>;
  claims: Record<string, RuntimeClaim>;
  contexts: Record<string, unknown>;
  approvals: Record<string, RuntimeApproval>;
  evidence: Record<string, unknown>;
  readOnly: boolean;
  controlPlane: string;
}

export interface RuntimeApproval {
  requestId: string;
  stageId: string;
  attemptId: string;
  artifactPath: string;
  contentHash: string;
  artifactDiff?: string;
  workspaceTreeDigest: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  decidedAt?: string;
}

export interface RuntimeClaim {
  stageId: string;
  attemptId: string;
  claimToken: string;
  actor: string;
  claimedAt: string;
  expiresAt: string;
  inputWorkspaceTreeDigest: string;
  allowedPaths: string[];
  workspaceSnapshot: TreeEntry[];
}

interface ProjectionEventResult {
  projection?: Pick<RuntimeProjection, "workItem" | "stages" | "claims" | "contexts" | "approvals" | "evidence" | "readOnly">;
  value?: unknown;
}

interface StoredProjection extends Omit<RuntimeProjection, "controlPlane"> {}

export class ControlPlaneStorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControlPlaneStorageError";
  }
}

async function resolveControlPlane(cwd: string, workItemId: string): Promise<{ directory: string; repositoryId: string; repositoryRoot: string; worktree: string }> {
  const repository = await loadRepository(cwd);
  const locatorPath = path.join(repository.commonDir, "wsspec", "work-items", workItemId, "locator.json");
  let locator: { repositoryId?: string; workItemId?: string; worktree?: string };
  try {
    locator = JSON.parse(await readFile(locatorPath, "utf8")) as { repositoryId?: string; workItemId?: string; worktree?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ControlPlaneStorageError("WSSPEC_WORK_ITEM_NOT_FOUND", `找不到 Work Item：${workItemId}`);
    }
    throw error;
  }
  if (locator.repositoryId !== repository.repositoryId || locator.workItemId !== workItemId || typeof locator.worktree !== "string") {
    throw new ControlPlaneStorageError("WSSPEC_REPOSITORY_ID_MISMATCH", "Work Item locator 与当前仓库身份不一致。");
  }
  const repositoryCache = JSON.parse(await readFile(path.join(repository.commonDir, "wsspec", "repository.json"), "utf8")) as {
    repositoryId?: string;
    repositoryRoot?: string;
  };
  if (repositoryCache.repositoryId !== repository.repositoryId || typeof repositoryCache.repositoryRoot !== "string") {
    throw new ControlPlaneStorageError("WSSPEC_REPOSITORY_ID_MISMATCH", "Git common-dir 仓库缓存身份不一致。");
  }
  return {
    directory: path.join(repository.commonDir, "wsspec", "work-items", workItemId, "control-plane"),
    repositoryId: repository.repositoryId,
    repositoryRoot: repositoryCache.repositoryRoot,
    worktree: locator.worktree,
  };
}

function withoutLocation(projection: RuntimeProjection): StoredProjection {
  const { controlPlane: _controlPlane, ...stored } = projection;
  return stored;
}

export async function writeProjection(projection: RuntimeProjection): Promise<void> {
  await writeFileAtomic(path.join(projection.controlPlane, "runtime.json"), `${JSON.stringify(withoutLocation(projection), null, 2)}\n`);
}

export async function writeArchiveSnapshot(input: { projection: RuntimeProjection; worktree: string; closedAt: string; workspaceTreeDigest: string }): Promise<void> {
  const { controlPlane: _controlPlane, ...publicProjection } = input.projection;
  const audit = {
    version: 1,
    repositoryId: input.projection.repositoryId,
    workItemId: input.projection.workItemId,
    closedAt: input.closedAt,
    workspaceTreeDigest: input.workspaceTreeDigest,
    terminalEventHash: input.projection.lastEventHash,
    projection: publicProjection,
  };
  await writeFileAtomic(path.join(input.worktree, ".wsspec", "archive", input.projection.workItemId, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
}

export async function initializeControlPlane(input: { cwd: string; workItemId: string; stages: string[] }): Promise<RuntimeProjection> {
  const resolved = await resolveControlPlane(input.cwd, input.workItemId);
  await mkdir(resolved.directory, { recursive: true });
  const projection: RuntimeProjection = {
    version: 1,
    repositoryId: resolved.repositoryId,
    workItemId: input.workItemId,
    workItem: { status: "draft" },
    stages: Object.fromEntries(input.stages.map((stage) => [stage, { status: "pending" }])),
    lastSequence: 0,
    lastEventHash: null,
    idempotency: {},
    claims: {},
    contexts: {},
    approvals: {},
    evidence: {},
    readOnly: false,
    controlPlane: resolved.directory,
  };
  await writeProjection(projection);
  return projection;
}

export async function readControlPlane(cwd: string, workItemId: string): Promise<RuntimeProjection> {
  const resolved = await resolveControlPlane(cwd, workItemId);
  const stored = JSON.parse(await readFile(path.join(resolved.directory, "runtime.json"), "utf8")) as StoredProjection;
  if (stored.repositoryId !== resolved.repositoryId || stored.workItemId !== workItemId) {
    throw new ControlPlaneStorageError("WSSPEC_REPOSITORY_ID_MISMATCH", "运行投影与当前仓库身份不一致。");
  }
  return { ...stored, claims: stored.claims ?? {}, contexts: stored.contexts ?? {}, approvals: stored.approvals ?? {}, evidence: stored.evidence ?? {}, readOnly: stored.readOnly ?? false, controlPlane: resolved.directory };
}

export function replayEvents(input: {
  repositoryId: string;
  workItemId: string;
  stageIds: string[];
  controlPlane: string;
  events: StoredEvent[];
}): RuntimeProjection {
  let recovered: RuntimeProjection = {
    version: 1,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    workItem: { status: "draft" },
    stages: Object.fromEntries(input.stageIds.map((stage) => [stage, { status: "pending" }])),
    lastSequence: 0,
    lastEventHash: null,
    idempotency: {},
    claims: {},
    contexts: {},
    approvals: {},
    evidence: {},
    readOnly: false,
    controlPlane: input.controlPlane,
  };
  for (const event of input.events) {
    if (event.repositoryId !== recovered.repositoryId || event.workItemId !== recovered.workItemId) {
      throw new ControlPlaneStorageError("WSSPEC_REPOSITORY_ID_MISMATCH", "事件与当前仓库或 Work Item 身份不一致。");
    }
    if (event.eventType === "work-item.transitioned") {
      recovered = { ...recovered, workItem: transitionWorkItem(recovered.workItem, { type: "transition", to: event.to as WorkItemState["status"] }) };
    } else if (event.eventType === "stage.transitioned") {
      const stageId = event.stageId;
      if (stageId === null || recovered.stages[stageId] === undefined) {
        throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "Stage 事件引用了未知 Stage。");
      }
      recovered = { ...recovered, stages: { ...recovered.stages, [stageId]: transitionStage(recovered.stages[stageId], { type: "transition", to: event.to as StageState["status"] }) } };
    } else {
      const result = event.result as ProjectionEventResult;
      if (result.projection === undefined) throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", `事件 ${event.eventType} 缺少可重放投影。`);
      recovered = { ...recovered, ...result.projection };
    }
    recovered.lastSequence = event.sequence;
    recovered.lastEventHash = event.eventHash;
    recovered.idempotency[event.idempotencyKey] = event.sequence;
  }
  recovered.readOnly = recovered.workItem.status === "closed";
  return recovered;
}

export async function recoverControlPlane(input: { cwd: string; workItemId: string }): Promise<RuntimeProjection> {
  const resolved = await resolveControlPlane(input.cwd, input.workItemId);
  await recoverStaleControlPlaneLock(resolved.directory);
  return withControlPlaneLock(resolved.directory, async () => {
  await repairIncompleteEventTail(resolved.directory);
  let durableProjection: StoredProjection | undefined;
  try {
    const stored = JSON.parse(await readFile(path.join(resolved.directory, "runtime.json"), "utf8")) as StoredProjection;
    if (stored.repositoryId !== resolved.repositoryId || stored.workItemId !== input.workItemId) {
      throw new ControlPlaneStorageError("WSSPEC_REPOSITORY_ID_MISMATCH", "运行投影与当前仓库身份不一致。");
    }
    durableProjection = stored;
  } catch (error) {
    if (error instanceof ControlPlaneStorageError) throw error;
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const workflowPath = path.join(resolved.repositoryRoot, resolved.worktree, ".wsspec", "work-items", input.workItemId, "snapshot", "workflow.yaml");
  const workflow = parse(await readFile(workflowPath, "utf8")) as { stages?: Array<{ id?: string }> };
  const stageIds = workflow.stages?.map((stage) => stage.id).filter((id): id is string => typeof id === "string") ?? [];
  const events = await readEvents(resolved.directory).catch((error: unknown) => {
    if (error instanceof EventStoreError) throw new ControlPlaneStorageError(error.code, error.message);
    throw error;
  });
  if (durableProjection !== undefined) {
    const anchoredEvent = durableProjection.lastSequence === 0 ? undefined : events[durableProjection.lastSequence - 1];
    if (
      durableProjection.lastSequence > events.length ||
      (durableProjection.lastSequence > 0 && anchoredEvent?.eventHash !== durableProjection.lastEventHash)
    ) {
      throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "事件日志短于或偏离持久化投影锚点。");
    }
  }
  let recovered = replayEvents({ repositoryId: resolved.repositoryId, workItemId: input.workItemId, stageIds, controlPlane: resolved.directory, events });
  const abandonedStages = Object.entries(recovered.stages).filter(([, stage]) => stage.status === "claimed" || stage.status === "running").map(([stageId]) => stageId);
  const approvalStages = Object.entries(recovered.stages).filter(([, stage]) => stage.status === "awaiting_approval").map(([stageId]) => stageId);
  const recoveryStages = [...new Set([...abandonedStages, ...approvalStages])];
  if (recoveryStages.length > 0 || recovered.workItem.status === "awaiting_approval") {
    const recoveryTime = new Date().toISOString();
    const next = { ...recovered, workItem: recovered.workItem.status === "awaiting_approval" ? { status: "active" as const } : recovered.workItem, stages: { ...recovered.stages }, claims: { ...recovered.claims }, contexts: { ...recovered.contexts }, approvals: { ...recovered.approvals } };
    for (const stageId of recoveryStages) {
      next.stages[stageId] = { status: "ready" };
      delete next.claims[stageId];
      delete next.contexts[stageId];
    }
    for (const [requestId, approval] of Object.entries(next.approvals)) {
      if (approval.status === "pending") next.approvals[requestId] = { ...approval, status: "expired", decidedAt: recoveryTime };
    }
    const previous = events.at(-1);
    if (previous === undefined) throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "活动 Claim 缺少对应事件历史。");
    const idempotencyKey = `recover-interrupted:${previous.eventHash}`;
    const event: DomainEvent = {
      eventId: `event-${crypto.randomUUID()}`, eventType: "projection.invalidated", occurredAt: new Date().toISOString(), actor: "recovery",
      repositoryId: recovered.repositoryId, workItemId: recovered.workItemId, stageId: null, attemptId: null,
      from: recovered.workItem.status, to: recovered.workItem.status, idempotencyKey,
      workflowDigest: previous.workflowDigest, configDigest: previous.configDigest, baselineTreeDigest: previous.baselineTreeDigest,
      inputWorkspaceTreeDigest: previous.outputWorkspaceTreeDigest ?? previous.inputWorkspaceTreeDigest, outputWorkspaceTreeDigest: null,
      inputDigest: sha256(recoveryStages.sort().join("\n")),
      result: { projection: { workItem: next.workItem, stages: next.stages, claims: next.claims, contexts: next.contexts, approvals: next.approvals, evidence: next.evidence, readOnly: next.readOnly }, value: { abandonedStages, approvalStages } },
    };
    const stored = await appendEventUnlocked(resolved.directory, event);
    next.lastSequence = stored.sequence; next.lastEventHash = stored.eventHash; next.idempotency = { ...next.idempotency, [idempotencyKey]: stored.sequence };
    recovered = next;
  }
  await writeProjection(recovered);
  if (recovered.workItem.status === "closed") {
    const closedEvent = [...events].reverse().find((event) => event.eventType === "work-item.closed");
    const value = (closedEvent?.result as { value?: { closedAt?: string; workspaceTreeDigest?: string } } | undefined)?.value;
    if (typeof value?.closedAt !== "string" || typeof value.workspaceTreeDigest !== "string") throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "关闭事件缺少归档重建数据。");
    await writeArchiveSnapshot({ projection: recovered, worktree: path.join(resolved.repositoryRoot, resolved.worktree), closedAt: value.closedAt, workspaceTreeDigest: value.workspaceTreeDigest });
  }
  return recovered;
  });
}
