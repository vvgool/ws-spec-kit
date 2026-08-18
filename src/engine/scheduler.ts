import { readFile } from "node:fs/promises";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";
import { parse } from "yaml";

import { sha256 } from "../domain/digests.js";
import { assertExternalReceipts } from "../domain/external-receipt.js";
import { transitionStage, transitionWorkItem, type StageStatus, type WorkItemStatus } from "../domain/states.js";
import { appendEventUnlocked, readEvents, withControlPlaneLock, type DomainEvent } from "../storage/events.js";
import { readControlPlane, replayEvents, writeProjection, type RuntimeProjection } from "../storage/control-plane.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export class ControlPlaneError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export type TransitionInput = {
  cwd: string;
  workItemId: string;
  idempotencyKey: string;
  actor?: string;
  simulateProjectionFailure?: boolean;
} & (
  | { scope: "work-item"; to: WorkItemStatus; stageId?: never }
  | { scope: "stage"; stageId: string; to: StageStatus }
);

type MutationEventType = Exclude<DomainEvent["eventType"], "work-item.transitioned" | "stage.transitioned">;

export async function mutateControlPlane<T>(input: {
  cwd: string;
  workItemId: string;
  eventType: MutationEventType | ((value: T) => MutationEventType);
  idempotencyKey: string;
  actor?: string;
  stageId?: string | ((value: T) => string | undefined);
  attemptId?: string;
  operationInput: unknown;
  eventDetails?: (value: T) => Record<string, unknown>;
  simulateProjectionFailure?: boolean;
  mutate: (projection: RuntimeProjection) => Promise<{ projection: RuntimeProjection; value: T }> | { projection: RuntimeProjection; value: T };
}): Promise<T> {
  const initial = await readControlPlane(input.cwd, input.workItemId);
  return withControlPlaneLock(initial.controlPlane, async () => {
    const projection = await readControlPlane(input.cwd, input.workItemId);
    const encodedInput = canonicalize(input.operationInput);
    if (encodedInput === undefined) throw new ControlPlaneError("WSSPEC_EVENT_INVALID", "操作输入无法规范化。");
    const inputDigest = sha256(encodedInput);
    const previousSequence = projection.idempotency[input.idempotencyKey];
    if (previousSequence !== undefined) {
      const previous = (await readEvents(projection.controlPlane))[previousSequence - 1];
      if (previous?.inputDigest !== inputDigest) throw new ControlPlaneError("WSSPEC_IDEMPOTENCY_CONFLICT", "幂等键已被不同输入使用。");
      return (previous.result as { value: T }).value;
    }
    if (projection.readOnly) throw new ControlPlaneError("WSSPEC_CONTROL_PLANE_READ_ONLY", "Work Item 已关闭，运行控制面只读。");
    const mutation = await input.mutate(projection);
    assertExternalReceipts(mutation.projection.evidence, "WSSPEC_EVENT_INVALID");
    const metadata = await eventMetadata(projection);
    const snapshot = {
      workItem: mutation.projection.workItem,
      stages: mutation.projection.stages,
      profile: mutation.projection.profile,
      claims: mutation.projection.claims,
      contexts: mutation.projection.contexts,
      approvals: mutation.projection.approvals,
      evidence: mutation.projection.evidence,
      loops: mutation.projection.loops,
      retries: mutation.projection.retries,
      readOnly: mutation.projection.readOnly,
    };
    const event: DomainEvent = {
      eventId: `event-${crypto.randomUUID()}`,
      eventType: typeof input.eventType === "function" ? input.eventType(mutation.value) : input.eventType,
      occurredAt: new Date().toISOString(),
      actor: input.actor ?? "engine",
      repositoryId: projection.repositoryId,
      workItemId: projection.workItemId,
      stageId: (typeof input.stageId === "function" ? input.stageId(mutation.value) : input.stageId) ?? null,
      attemptId: input.attemptId ?? null,
      from: projection.workItem.status,
      to: mutation.projection.workItem.status,
      idempotencyKey: input.idempotencyKey,
      ...metadata,
      inputWorkspaceTreeDigest: metadata.baselineTreeDigest,
      outputWorkspaceTreeDigest: null,
      inputDigest,
      result: { projection: snapshot, value: mutation.value, ...(input.eventDetails?.(mutation.value) ?? {}) },
    };
    const stored = await appendEventUnlocked(projection.controlPlane, event);
    const next = mutation.projection;
    next.lastSequence = stored.sequence;
    next.lastEventHash = stored.eventHash;
    next.idempotency = { ...projection.idempotency, [input.idempotencyKey]: stored.sequence };
    if (input.simulateProjectionFailure === true) throw new ControlPlaneError("WSSPEC_PROJECTION_WRITE_FAILED", "已追加事件，但模拟的投影写入失败。");
    await writeProjection(next);
    return mutation.value;
  });
}

async function eventMetadata(projection: RuntimeProjection): Promise<{ workflowDigest: string; configDigest: string; baselineTreeDigest: string }> {
  const locatorRoot = path.dirname(projection.controlPlane);
  const locator = JSON.parse(await readFile(path.join(locatorRoot, "locator.json"), "utf8")) as { worktree: string };
  const repositoryCache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryId: string; repositoryRoot: string };
  if (repositoryCache.repositoryId !== projection.repositoryId) {
    throw new ControlPlaneError("WSSPEC_REPOSITORY_ID_MISMATCH", "控制面仓库缓存身份不一致。");
  }
  const manifestPath = path.join(repositoryCache.repositoryRoot, locator.worktree, ".wsspec", "work-items", projection.workItemId, "work-item.yaml");
  const manifest = parse(await readFile(manifestPath, "utf8")) as { execution: { workflowDigest: string; configDigest: string; baselineTreeDigest: string } };
  return manifest.execution;
}

function apply(projection: RuntimeProjection, input: TransitionInput): RuntimeProjection {
  if (input.scope === "work-item") {
    return { ...projection, workItem: transitionWorkItem(projection.workItem, { type: "transition", to: input.to }) };
  }
  const stage = projection.stages[input.stageId];
  if (stage === undefined) throw new ControlPlaneError("WSSPEC_STAGE_NOT_FOUND", `找不到 Stage：${input.stageId}`);
  return { ...projection, stages: { ...projection.stages, [input.stageId]: transitionStage(stage, { type: "transition", to: input.to }) } };
}

export async function transitionProjectionLocked(projection: RuntimeProjection, input: TransitionInput): Promise<RuntimeProjection> {
    if (projection.readOnly) throw new ControlPlaneError("WSSPEC_CONTROL_PLANE_READ_ONLY", "Work Item 已关闭，运行控制面只读。");
    const currentStage = input.scope === "stage" ? projection.stages[input.stageId] : undefined;
    if (input.scope === "stage" && currentStage === undefined) {
      throw new ControlPlaneError("WSSPEC_STAGE_NOT_FOUND", `找不到 Stage：${input.stageId}`);
    }
    const metadata = await eventMetadata(projection);
    const from = input.scope === "work-item" ? projection.workItem.status : currentStage!.status;
    const inputContent = canonicalize({ scope: input.scope, stageId: input.stageId ?? null, to: input.to });
    if (inputContent === undefined) throw new ControlPlaneError("WSSPEC_EVENT_INVALID", "状态转换输入无法规范化。");
    const inputDigest = sha256(inputContent);
    const previousSequence = projection.idempotency[input.idempotencyKey];
    if (previousSequence !== undefined) {
      const events = await readEvents(projection.controlPlane);
      const previous = events[previousSequence - 1];
      if (previous?.inputDigest !== inputDigest) throw new ControlPlaneError("WSSPEC_IDEMPOTENCY_CONFLICT", "幂等键已被不同输入使用。");
      return replayEvents({
        repositoryId: projection.repositoryId,
        workItemId: projection.workItemId,
        stageIds: Object.keys(projection.stages),
        controlPlane: projection.controlPlane,
        events: events.slice(0, previousSequence),
      });
    }
    const next = apply(projection, input);
    const event: DomainEvent = {
      eventId: `event-${crypto.randomUUID()}`,
      eventType: input.scope === "work-item" ? "work-item.transitioned" : "stage.transitioned",
      occurredAt: new Date().toISOString(),
      actor: input.actor ?? "engine",
      repositoryId: projection.repositoryId,
      workItemId: projection.workItemId,
      stageId: input.stageId ?? null,
      attemptId: null,
      from,
      to: input.to,
      idempotencyKey: input.idempotencyKey,
      ...metadata,
      inputWorkspaceTreeDigest: metadata.baselineTreeDigest,
      outputWorkspaceTreeDigest: null,
      inputDigest,
      result: input.scope === "work-item" ? next.workItem : next.stages[input.stageId],
    };
    const stored = await appendEventUnlocked(projection.controlPlane, event);
    next.lastSequence = stored.sequence;
    next.lastEventHash = stored.eventHash;
    next.idempotency = { ...projection.idempotency, [input.idempotencyKey]: stored.sequence };
    if (input.simulateProjectionFailure === true) {
      throw new ControlPlaneError("WSSPEC_PROJECTION_WRITE_FAILED", "已追加事件，但模拟的投影写入失败。");
    }
    return next;
}

export async function transitionRuntime(input: TransitionInput): Promise<RuntimeProjection> {
  const initial = await readControlPlane(input.cwd, input.workItemId);
  return withControlPlaneLock(initial.controlPlane, async () => {
    const projection = await readControlPlane(input.cwd, input.workItemId);
    const next = await transitionProjectionLocked(projection, input);
    if (next.lastSequence >= projection.lastSequence) await writeProjection(next);
    return next;
  });
}
