import { mkdir, open, readFile, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";
import { parse } from "yaml";

import { parseApplicationSnapshot } from "../application/snapshot.js";
import { deriveInitialStages } from "../application/initial-stages.js";
import type { LoopProjection, RetryProjection, StageState, WorkItemState } from "../domain/states.js";
import { sha256, type TreeEntry } from "../domain/digests.js";
import { assertExternalReceipts } from "../domain/external-receipt.js";
import { parseTddCycleEvidence, parseTrustedEvidence, testAssetScopeManifest, testFileManifest } from "../engine/tdd/red-gate.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { interruptedRetry } from "../engine/control/retry.js";
import { emptyRuntimeRiskSignals, type RuntimeProfileProjection } from "../application/profile.js";
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
  profile: RuntimeProfileProjection;
  claims: Record<string, RuntimeClaim>;
  contexts: Record<string, unknown>;
  approvals: Record<string, RuntimeApproval>;
  evidence: Record<string, unknown>;
  loops: Record<string, LoopProjection>;
  retries: Record<string, RetryProjection>;
  readOnly: boolean;
  controlPlane: string;
}

export interface RuntimeApproval {
  requestId: string;
  stageId: string;
  attemptId: string;
  artifactPath?: string;
  contentHash: string;
  artifacts?: Array<{
    artifactType: string;
    schemaVersion: number;
    path: string;
    revision: number;
    contentHash: string;
    mediaType?: string;
  }>;
  artifactDiff?: string;
  workspaceTreeDigest: string;
  requestedBy?: string;
  decidedBy?: string;
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

export const applicationCloseEvidenceKey = "application.close";

export interface ApplicationCloseEvidence {
  closedAt: string;
  workspaceTreeDigest: string;
  artifactTreeDigest: string;
}

interface ProjectionEventResult {
  projection?: Pick<RuntimeProjection, "workItem" | "stages" | "profile" | "claims" | "contexts" | "approvals" | "evidence" | "loops" | "retries" | "readOnly">;
  value?: unknown;
}

interface StoredProjection extends Omit<RuntimeProjection, "controlPlane"> {}

export interface ApplicationAnchor {
  version: 1;
  workItemId: string;
  manifestDigest: string;
  ownerToken: string;
}

export class ControlPlaneStorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControlPlaneStorageError";
  }
}

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  const encoded = canonicalize(left);
  return encoded !== undefined && encoded === canonicalize(right);
}

function assertedTddEvidence(projection: RuntimeProjection): { red?: import("../engine/tdd/types.js").TrustedEvidence; cycle?: import("../engine/tdd/types.js").TddCycleEvidence } {
  const prefix = `tdd:${projection.workItemId}:`;
  const entries = Object.entries(projection.evidence).filter(([key]) => key.startsWith("tdd:"));
  if (entries.length === 0) return {};
  const red = parseTrustedEvidence(projection.evidence[`${prefix}red`]);
  if (red === undefined || red.phase !== "red" || red.taskId !== projection.workItemId) {
    throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "事件重放包含无效或不兼容的 Red Evidence。");
  }
  let cycle: import("../engine/tdd/types.js").TddCycleEvidence | undefined;
  const greens = new Map<string, import("../engine/tdd/types.js").TrustedEvidence>();
  for (const [key, value] of entries) {
    if (key === `${prefix}red`) continue;
    if (key === `${prefix}cycle`) {
      cycle = parseTddCycleEvidence(value);
      if (cycle === undefined || cycle.taskId !== projection.workItemId || cycle.redEvidenceId !== red.evidenceId
        || cycle.commandId !== red.commandId || cycle.testAssetsDigest !== red.testAssetsDigest
        || !sameCanonicalValue(cycle.testPaths, red.testPaths)
        || !sameCanonicalValue(cycle.testPathRules, red.testPathRules)
        || !sameCanonicalValue(cycle.testAssets, red.testAssets)
        || !sameCanonicalValue(cycle.testAssetPaths, red.testAssetPaths)
        || !sameCanonicalValue(cycle.productPaths, red.productPaths)) {
        throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "事件重放包含无效或不兼容的 TDD Cycle Evidence。");
      }
      continue;
    }
    if (!key.startsWith(`${prefix}green:`)) throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", `事件重放包含未知 TDD Evidence key：${key}`);
    const green = parseTrustedEvidence(value);
    if (green === undefined || green.phase !== "green" || green.taskId !== projection.workItemId
      || key !== `${prefix}green:${green.evidenceId}`
      || green.commandId !== red.commandId || green.commandDigest !== red.commandDigest
      || green.testPathsDigest !== red.testPathsDigest || green.testAssetsDigest !== red.testAssetsDigest
      || !sameCanonicalValue(green.testPaths, red.testPaths)
      || !sameCanonicalValue(green.testFiles, red.testFiles)
      || !sameCanonicalValue(green.testPathRules, red.testPathRules)
      || !sameCanonicalValue(green.testAssets, red.testAssets)
      || !sameCanonicalValue(green.testAssetPaths, red.testAssetPaths)
      || !sameCanonicalValue(green.productPaths, red.productPaths)) {
      throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "事件重放包含未绑定当前 Red 的 Green Evidence。");
    }
    greens.set(green.evidenceId, green);
  }
  if (cycle !== undefined && (!greens.has(cycle.greenEvidenceId)
    || (cycle.refactorEvidenceId !== undefined && !greens.has(cycle.refactorEvidenceId)))) {
    throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "事件重放的 TDD Cycle 引用了不存在或不兼容的 Green Evidence。");
  }
  return { red, ...(cycle === undefined ? {} : { cycle }) };
}

async function assertRecoveredTddScope(worktree: string, projection: RuntimeProjection): Promise<void> {
  const { red } = assertedTddEvidence(projection);
  if (red === undefined) return;
  let tests: Awaited<ReturnType<typeof testFileManifest>>;
  let assets: Awaited<ReturnType<typeof testAssetScopeManifest>>;
  try {
    [tests, assets] = await Promise.all([
      testFileManifest(worktree, red.testPaths, red.testPathRules),
      testAssetScopeManifest(worktree, { testAssetPaths: red.testAssetPaths, productPaths: red.productPaths }),
    ]);
  } catch {
    throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "事件恢复时测试资产作用域已新增、删除或修改，旧 Red Evidence 失效。");
  }
  if (tests.digest !== red.testPathsDigest || assets.digest !== red.testAssetsDigest) {
    throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", `事件恢复时测试资产作用域摘要失配（tests ${red.testPathsDigest} -> ${tests.digest}; assets ${red.testAssetsDigest} -> ${assets.digest}）。`);
  }
}

async function readApplicationAnchorFile(controlPlane: string): Promise<ApplicationAnchor | undefined> {
  try {
    const anchor = JSON.parse(await readFile(path.join(controlPlane, "application-anchor.json"), "utf8")) as Partial<ApplicationAnchor>;
    if (anchor.version !== 1 || typeof anchor.workItemId !== "string" || typeof anchor.manifestDigest !== "string" || typeof anchor.ownerToken !== "string") {
      throw new ControlPlaneStorageError("WSSPEC_APPLICATION_ANCHOR_INVALID", "Application 锚点不完整。");
    }
    return anchor as ApplicationAnchor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
  if (path.isAbsolute(locator.worktree) || locator.worktree.split(/[\\/]/u).includes("..")) {
    throw new ControlPlaneStorageError("WSSPEC_WORK_ITEM_LOCATION_INVALID", "Work Item locator 必须指向仓库内相对 worktree。");
  }
  let cachedRoot: string;
  let worktree: string;
  try {
    cachedRoot = await realpath(repositoryCache.repositoryRoot);
    worktree = await realpath(path.resolve(cachedRoot, locator.worktree));
  } catch {
    throw new ControlPlaneStorageError("WSSPEC_WORK_ITEM_LOCATION_INVALID", "Work Item locator 指向的 worktree 不存在。");
  }
  const worktreeRelative = path.relative(cachedRoot, worktree);
  if (worktreeRelative === "" || worktreeRelative.startsWith("..") || path.isAbsolute(worktreeRelative)) {
    throw new ControlPlaneStorageError("WSSPEC_WORK_ITEM_LOCATION_INVALID", "Work Item locator 的真实路径越出仓库边界。");
  }
  return {
    directory: path.join(repository.commonDir, "wsspec", "work-items", workItemId, "control-plane"),
    repositoryId: repository.repositoryId,
    repositoryRoot: cachedRoot,
    worktree: worktreeRelative,
  };
}

function withoutLocation(projection: RuntimeProjection): StoredProjection {
  const { controlPlane: _controlPlane, ...stored } = projection;
  return stored;
}

export async function writeProjection(projection: RuntimeProjection): Promise<void> {
  await writeFileAtomic(path.join(projection.controlPlane, "runtime.json"), `${JSON.stringify(withoutLocation(projection), null, 2)}\n`);
}

async function writeFileExclusive(target: string, content: string): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeApplicationAnchor(input: { cwd: string; workItemId: string; manifestDigest: string; ownerToken: string }): Promise<void> {
  const resolved = await resolveControlPlane(input.cwd, input.workItemId);
  await mkdir(resolved.directory);
  const anchor: ApplicationAnchor = { version: 1, workItemId: input.workItemId, manifestDigest: input.manifestDigest, ownerToken: input.ownerToken };
  try {
    await writeFileExclusive(path.join(resolved.directory, "application-anchor.json"), `${JSON.stringify(anchor, null, 2)}\n`);
  } catch (error) {
    await rmdir(resolved.directory).catch((cleanupError: unknown) => {
      if (!["ENOTEMPTY", "EEXIST"].includes((cleanupError as NodeJS.ErrnoException).code ?? "")) throw cleanupError;
    });
    throw error;
  }
}

export async function readApplicationAnchor(cwd: string, workItemId: string): Promise<ApplicationAnchor | undefined> {
  const resolved = await resolveControlPlane(cwd, workItemId);
  const anchor = await readApplicationAnchorFile(resolved.directory);
  if (anchor !== undefined && anchor.workItemId !== workItemId) {
    throw new ControlPlaneStorageError("WSSPEC_REPOSITORY_ID_MISMATCH", "Application 锚点与 Work Item 身份不一致。");
  }
  return anchor;
}

export async function writeArchiveSnapshot(input: { projection: RuntimeProjection; worktree: string; closedAt: string; workspaceTreeDigest: string; artifactTreeDigest: string }): Promise<void> {
  assertExternalReceipts(input.projection.evidence, "WSSPEC_EVENT_CHAIN_INVALID");
  const { controlPlane: _controlPlane, ...publicProjection } = input.projection;
  const audit = {
    version: 1,
    repositoryId: input.projection.repositoryId,
    workItemId: input.projection.workItemId,
    closedAt: input.closedAt,
    workspaceTreeDigest: input.workspaceTreeDigest,
    artifactTreeDigest: input.artifactTreeDigest,
    terminalEventHash: input.projection.lastEventHash,
    projection: publicProjection,
  };
  await writeFileAtomic(path.join(input.worktree, ".wsspec", "archive", input.projection.workItemId, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
}

export async function initializeControlPlane(input: {
  cwd: string;
  workItemId: string;
  stages: string[];
  initialWorkItem?: WorkItemState;
  initialStages?: Record<string, StageState>;
  initialProfile?: RuntimeProfileProjection;
}): Promise<RuntimeProjection> {
  const resolved = await resolveControlPlane(input.cwd, input.workItemId);
  await mkdir(resolved.directory, { recursive: true });
  const projection: RuntimeProjection = {
    version: 1,
    repositoryId: resolved.repositoryId,
    workItemId: input.workItemId,
    workItem: input.initialWorkItem ?? { status: "draft" },
    stages: input.initialStages ?? Object.fromEntries(input.stages.map((stage) => [stage, { status: "pending" }])),
    lastSequence: 0,
    lastEventHash: null,
    idempotency: {},
    profile: input.initialProfile ?? { mode: "quick", selected: "quick", provisional: false, reasonRuleIds: [], riskSignals: emptyRuntimeRiskSignals() },
    claims: {},
    contexts: {},
    approvals: {},
    evidence: {},
    loops: {},
    retries: {},
    readOnly: false,
    controlPlane: resolved.directory,
  };
  await writeFileExclusive(path.join(projection.controlPlane, "runtime.json"), `${JSON.stringify(withoutLocation(projection), null, 2)}\n`);
  return projection;
}

export async function readControlPlane(cwd: string, workItemId: string): Promise<RuntimeProjection> {
  const resolved = await resolveControlPlane(cwd, workItemId);
  const stored = JSON.parse(await readFile(path.join(resolved.directory, "runtime.json"), "utf8")) as StoredProjection;
  if (stored.repositoryId !== resolved.repositoryId || stored.workItemId !== workItemId) {
    throw new ControlPlaneStorageError("WSSPEC_REPOSITORY_ID_MISMATCH", "运行投影与当前仓库身份不一致。");
  }
  return {
    ...stored,
    profile: stored.profile === undefined
      ? { mode: "quick", selected: "quick", provisional: false, reasonRuleIds: [], riskSignals: emptyRuntimeRiskSignals() }
      : { ...stored.profile, riskSignals: stored.profile.riskSignals ?? emptyRuntimeRiskSignals() },
    claims: stored.claims ?? {},
    contexts: stored.contexts ?? {},
    approvals: stored.approvals ?? {},
    evidence: stored.evidence ?? {},
    loops: stored.loops ?? {},
    retries: stored.retries ?? {},
    readOnly: stored.readOnly ?? false,
    controlPlane: resolved.directory,
  };
}

export function replayEvents(input: {
  repositoryId: string;
  workItemId: string;
  stageIds: string[];
  controlPlane: string;
  events: StoredEvent[];
  initialWorkItem?: WorkItemState;
  initialStages?: Record<string, StageState>;
  initialProfile?: RuntimeProfileProjection;
}): RuntimeProjection {
  let recovered: RuntimeProjection = {
    version: 1,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    workItem: input.initialWorkItem ?? { status: "draft" },
    stages: input.initialStages ?? Object.fromEntries(input.stageIds.map((stage) => [stage, { status: "pending" }])),
    lastSequence: 0,
    lastEventHash: null,
    idempotency: {},
    profile: input.initialProfile ?? { mode: "quick", selected: "quick", provisional: false, reasonRuleIds: [], riskSignals: emptyRuntimeRiskSignals() },
    claims: {},
    contexts: {},
    approvals: {},
    evidence: {},
    loops: {},
    retries: {},
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
      assertExternalReceipts(recovered.evidence, "WSSPEC_EVENT_CHAIN_INVALID");
      assertedTddEvidence(recovered);
    }
    recovered.lastSequence = event.sequence;
    recovered.lastEventHash = event.eventHash;
    recovered.idempotency[event.idempotencyKey] = event.sequence;
  }
  recovered.profile = {
    ...recovered.profile,
    riskSignals: recovered.profile.riskSignals ?? emptyRuntimeRiskSignals(),
  };
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
  const events = await readEvents(resolved.directory).catch((error: unknown) => {
    if (error instanceof EventStoreError) throw new ControlPlaneStorageError(error.code, error.message);
    throw error;
  });
  const snapshotRoot = path.join(resolved.repositoryRoot, resolved.worktree, ".wsspec", "work-items", input.workItemId, "snapshot");
  let stageIds: string[];
  let initialWorkItem: WorkItemState | undefined;
  let initialStages: Record<string, StageState> | undefined;
  let initialProfile: RuntimeProfileProjection | undefined;
  const anchor = await readApplicationAnchorFile(resolved.directory);
  try {
    const applicationText = await readFile(path.join(snapshotRoot, "application.json"), "utf8");
    const manifestText = await readFile(path.join(resolved.repositoryRoot, resolved.worktree, ".wsspec", "work-items", input.workItemId, "work-item.yaml"), "utf8");
    if (anchor?.workItemId !== input.workItemId || sha256(manifestText) !== anchor.manifestDigest) {
      throw new ControlPlaneStorageError("WSSPEC_WORK_ITEM_MANIFEST_CHANGED", "Work Item manifest 与可信 Application 锚点不一致。");
    }
    const manifest = parse(manifestText) as { execution?: { workflowDigest?: unknown } };
    if (typeof manifest.execution?.workflowDigest !== "string" || sha256(applicationText) !== manifest.execution.workflowDigest) {
      throw new ControlPlaneStorageError("WSSPEC_APPLICATION_SNAPSHOT_CHANGED", "Application 快照摘要与 Work Item manifest 不一致。");
    }
    const application = parseApplicationSnapshot(JSON.parse(applicationText));
    const profile = application.profiles[application.selectedProfile];
    stageIds = profile.order;
    initialWorkItem = { status: "active" };
    initialStages = deriveInitialStages(profile);
    initialProfile = { mode: application.selectedProfile, selected: application.selectedProfile, provisional: false, reasonRuleIds: [], riskSignals: emptyRuntimeRiskSignals() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (anchor !== undefined) {
      throw new ControlPlaneStorageError("WSSPEC_APPLICATION_SNAPSHOT_CHANGED", "已锚定 Work Item 缺少 Application 快照，拒绝降级恢复。");
    }
    stageIds = durableProjection === undefined
      ? [...new Set(events.map((event) => event.stageId).filter((stageId): stageId is string => stageId !== null))]
      : Object.keys(durableProjection.stages);
  }
  if (durableProjection !== undefined) {
    const anchoredEvent = durableProjection.lastSequence === 0 ? undefined : events[durableProjection.lastSequence - 1];
    if (
      durableProjection.lastSequence > events.length ||
      (durableProjection.lastSequence > 0 && anchoredEvent?.eventHash !== durableProjection.lastEventHash)
    ) {
      throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "事件日志短于或偏离持久化投影锚点。");
    }
  }
  let recovered = replayEvents({
    repositoryId: resolved.repositoryId,
    workItemId: input.workItemId,
    stageIds,
    controlPlane: resolved.directory,
    events,
    ...(initialWorkItem === undefined ? {} : { initialWorkItem }),
    ...(initialStages === undefined ? {} : { initialStages }),
    ...(initialProfile === undefined ? {} : { initialProfile }),
  });
  await assertRecoveredTddScope(path.join(resolved.repositoryRoot, resolved.worktree), recovered);
  const recoveryTime = new Date();
  const abandonedStages = Object.entries(recovered.stages).filter(([stageId, stage]) => {
    if (stage.status === "running") return true;
    if (stage.status !== "claimed") return false;
    const expiresAt = Date.parse(recovered.claims[stageId]?.expiresAt ?? "");
    return !Number.isFinite(expiresAt) || expiresAt <= recoveryTime.getTime();
  }).map(([stageId]) => stageId);
  const durableApprovalIds = new Set(Object.entries(recovered.approvals)
    .filter(([, approval]) => approval.status === "pending"
      && recovered.workItem.status === "awaiting_approval"
      && recovered.stages[approval.stageId]?.status === "awaiting_approval")
    .map(([requestId]) => requestId));
  const durableApprovalStages = new Set([...durableApprovalIds].map((requestId) => recovered.approvals[requestId]!.stageId));
  const invalidPendingApprovalIds = new Set(Object.entries(recovered.approvals)
    .filter(([requestId, approval]) => approval.status === "pending" && !durableApprovalIds.has(requestId))
    .map(([requestId]) => requestId));
  const approvalStages = Object.entries(recovered.stages)
    .filter(([stageId, stage]) => stage.status === "awaiting_approval" && !durableApprovalStages.has(stageId))
    .map(([stageId]) => stageId);
  const recoveryStages = [...new Set([...abandonedStages, ...approvalStages])];
  const recoverWorkItem = recovered.workItem.status === "awaiting_approval" && durableApprovalIds.size === 0;
  if (recoveryStages.length > 0 || recoverWorkItem || invalidPendingApprovalIds.size > 0) {
    const recoveredAt = recoveryTime.toISOString();
    const next = {
      ...recovered,
      workItem: recoverWorkItem ? { status: "active" as const } : recovered.workItem,
      stages: { ...recovered.stages },
      claims: { ...recovered.claims },
      contexts: { ...recovered.contexts },
      approvals: { ...recovered.approvals },
      retries: { ...recovered.retries },
    };
    for (const stageId of recoveryStages) {
      const stepInstanceId = recovered.claims[stageId]?.stageId ?? stageId;
      const retry = Object.hasOwn(next.retries, stepInstanceId) ? next.retries[stepInstanceId] : undefined;
      if (retry !== undefined) next.retries[stepInstanceId] = interruptedRetry(retry);
      next.stages[stageId] = (Object.hasOwn(next.retries, stepInstanceId) ? next.retries[stepInstanceId] : undefined)?.status === "exhausted"
        ? { status: "failed" }
        : { status: "ready" };
      delete next.claims[stageId];
      delete next.contexts[stageId];
    }
    for (const requestId of invalidPendingApprovalIds) {
      const approval = next.approvals[requestId]!;
      next.approvals[requestId] = { ...approval, status: "expired", decidedAt: recoveredAt };
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
      result: {
        projection: {
          workItem: next.workItem,
          stages: next.stages,
          profile: next.profile,
          claims: next.claims,
          contexts: next.contexts,
          approvals: next.approvals,
          evidence: next.evidence,
          loops: next.loops,
          retries: next.retries,
          readOnly: next.readOnly,
        },
        value: { abandonedStages, approvalStages },
      },
    };
    const stored = await appendEventUnlocked(resolved.directory, event);
    next.lastSequence = stored.sequence; next.lastEventHash = stored.eventHash; next.idempotency = { ...next.idempotency, [idempotencyKey]: stored.sequence };
    recovered = next;
  }
  await writeProjection(recovered);
  if (recovered.workItem.status === "closed") {
    const closedEvent = [...events].reverse().find((event) => event.eventType === "work-item.closed");
    const value = (closedEvent?.result as { value?: { closedAt?: string; workspaceTreeDigest?: string } } | undefined)?.value;
    const applicationClose = recovered.evidence[applicationCloseEvidenceKey] as Partial<ApplicationCloseEvidence> | undefined;
    const closedAt = value?.closedAt ?? applicationClose?.closedAt;
    const workspaceTreeDigest = value?.workspaceTreeDigest ?? applicationClose?.workspaceTreeDigest;
    const artifactTreeDigest = applicationClose?.artifactTreeDigest;
    if (typeof closedAt !== "string" || typeof workspaceTreeDigest !== "string" || typeof artifactTreeDigest !== "string") throw new ControlPlaneStorageError("WSSPEC_EVENT_CHAIN_INVALID", "关闭事件缺少归档重建数据。");
    await writeArchiveSnapshot({ projection: recovered, worktree: path.join(resolved.repositoryRoot, resolved.worktree), closedAt, workspaceTreeDigest, artifactTreeDigest });
  }
  return recovered;
  });
}
