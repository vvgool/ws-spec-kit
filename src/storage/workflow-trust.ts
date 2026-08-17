import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import type { WorkflowTrustRecord } from "../workflow-package/types.js";
import { gitCommonDir } from "./git.js";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const TRUST_LOCK_STALE_MILLISECONDS = 30_000;

export class WorkflowTrustStoreError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) { super(`${code}: ${message}`); this.name = "WorkflowTrustStoreError"; }
}

interface TrustLockOwner { version: 1; ownerToken: string; pid: number; hostname: string; createdAt: string }

export interface WorkflowTrustRequestedEvent {
  event: "requested";
  requestId: string;
  packageRef: string;
  packageDigest: string;
  capabilityDigest: string;
  actor: string;
  channel: "interactive";
  createdAt: string;
  expiresAt: string;
}

export interface WorkflowTrustDecidedEvent {
  event: "decided";
  requestId: string;
  decision: "trusted" | "rejected";
  actor: string;
  decidedAt: string;
}

interface WorkflowTrustJournalState {
  requests: Map<string, WorkflowTrustRequestedEvent>;
  decisions: Map<string, WorkflowTrustDecidedEvent>;
  records: WorkflowTrustRecord[];
}

function journalError(message: string): never {
  throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_JOURNAL_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseRequested(value: Record<string, unknown>, line: number): WorkflowTrustRequestedEvent {
  const keys = ["event", "requestId", "packageRef", "packageDigest", "capabilityDigest", "actor", "channel", "createdAt", "expiresAt"] as const;
  if (!hasExactKeys(value, keys)
    || value.event !== "requested"
    || !isNonEmptyString(value.requestId)
    || !isNonEmptyString(value.packageRef)
    || !isNonEmptyString(value.packageDigest)
    || !isNonEmptyString(value.capabilityDigest)
    || !isNonEmptyString(value.actor)
    || value.channel !== "interactive"
    || !isCanonicalIso(value.createdAt)
    || !isCanonicalIso(value.expiresAt)
    || value.createdAt >= value.expiresAt) journalError(`Workflow 信任 journal 第 ${line} 行 requested 事件无效。`);
  return {
    event: "requested",
    requestId: value.requestId,
    packageRef: value.packageRef,
    packageDigest: value.packageDigest,
    capabilityDigest: value.capabilityDigest,
    actor: value.actor,
    channel: "interactive",
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function parseDecided(value: Record<string, unknown>, line: number): WorkflowTrustDecidedEvent {
  const keys = ["event", "requestId", "decision", "actor", "decidedAt"] as const;
  if (!hasExactKeys(value, keys)
    || value.event !== "decided"
    || !isNonEmptyString(value.requestId)
    || (value.decision !== "trusted" && value.decision !== "rejected")
    || !isNonEmptyString(value.actor)
    || !isCanonicalIso(value.decidedAt)) journalError(`Workflow 信任 journal 第 ${line} 行 decided 事件无效。`);
  return { event: "decided", requestId: value.requestId, decision: value.decision, actor: value.actor, decidedAt: value.decidedAt };
}

function deriveRecord(request: WorkflowTrustRequestedEvent, decision: WorkflowTrustDecidedEvent): WorkflowTrustRecord {
  return {
    requestId: request.requestId,
    packageRef: request.packageRef,
    packageDigest: request.packageDigest,
    capabilityDigest: request.capabilityDigest,
    decision: decision.decision,
    actor: decision.actor,
    decidedAt: decision.decidedAt,
  };
}

async function readJournal(target: string): Promise<WorkflowTrustJournalState> {
  let content: string;
  try { content = await readFile(target, "utf8"); }
  catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return { requests: new Map(), decisions: new Map(), records: [] };
    throw caught;
  }
  if (content !== "" && !content.endsWith("\n")) journalError("Workflow 信任 journal 包含未完成的末尾事件。");
  const requests = new Map<string, WorkflowTrustRequestedEvent>();
  const decisions = new Map<string, WorkflowTrustDecidedEvent>();
  const records: WorkflowTrustRecord[] = [];
  const lines = content === "" ? [] : content.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    if (line === "") journalError(`Workflow 信任 journal 第 ${index + 1} 行为空。`);
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { journalError(`Workflow 信任 journal 第 ${index + 1} 行不是合法 JSON。`); }
    if (!isRecord(value) || (value.event !== "requested" && value.event !== "decided")) journalError(`Workflow 信任 journal 第 ${index + 1} 行包含未知事件。`);
    if (value.event === "requested") {
      const request = parseRequested(value, index + 1);
      if (requests.has(request.requestId)) journalError(`Workflow 信任 requestId ${request.requestId} 重复。`);
      requests.set(request.requestId, request);
      continue;
    }
    const decision = parseDecided(value, index + 1);
    const request = requests.get(decision.requestId);
    if (request === undefined) journalError(`Workflow 信任决定 ${decision.requestId} 缺少 requested 事件。`);
    if (decision.actor !== request.actor) journalError(`Workflow 信任决定 ${decision.requestId} 的 actor 不匹配。`);
    if (decision.decidedAt < request.createdAt || decision.decidedAt >= request.expiresAt) journalError(`Workflow 信任决定 ${decision.requestId} 不在有效时间内。`);
    const existing = decisions.get(decision.requestId);
    if (existing !== undefined) {
      if (existing.decision !== decision.decision || existing.actor !== decision.actor) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_DECISION_CONFLICT", "同一 Workflow 信任请求存在冲突决定。");
      continue;
    }
    decisions.set(decision.requestId, decision);
    records.push(deriveRecord(request, decision));
  }
  return { requests, decisions, records };
}

async function readTrustLock(lockPath: string): Promise<TrustLockOwner | undefined> {
  try {
    const content = await readFile(lockPath, "utf8");
    if (!content.endsWith("\n")) return undefined;
    const value = JSON.parse(content) as Partial<TrustLockOwner>;
    if (!isRecord(value)
      || !hasExactKeys(value, ["version", "ownerToken", "pid", "hostname", "createdAt"])
      || value.version !== 1
      || !isNonEmptyString(value.ownerToken)
      || typeof value.pid !== "number"
      || !Number.isSafeInteger(value.pid)
      || value.pid < 1
      || !isNonEmptyString(value.hostname)
      || !isCanonicalIso(value.createdAt)) return undefined;
    return value as unknown as TrustLockOwner;
  } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (caught) { return (caught as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function workflowTrustPath(root: string): Promise<string> {
  return path.join(await gitCommonDir(root), "wsspec", "trust", "workflow-packages.ndjson");
}

async function publishTrustLock(lockPath: string, owner: TrustLockOwner): Promise<boolean> {
  const temporaryPath = `${lockPath}.${owner.ownerToken}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    try {
      await link(temporaryPath, lockPath);
      return true;
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw caught;
    }
  } finally {
    await handle.close();
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function withTrustLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  await mkdir(path.dirname(target), { recursive: true });
  const deadline = Date.now() + 5_000;
  const owner: TrustLockOwner = { version: 1, ownerToken: crypto.randomUUID(), pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() };
  while (true) {
    try {
      if (await publishTrustLock(lockPath, owner)) break;
      const existing = await readTrustLock(lockPath);
      if (existing?.hostname === hostname() && !processIsAlive(existing.pid)) {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs >= TRUST_LOCK_STALE_MILLISECONDS) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_STALE_LOCK", "检测到异常退出遗留的 Workflow 信任锁，请先恢复。");
      }
    } catch (caught) {
      if (caught instanceof WorkflowTrustStoreError) throw caught;
      throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任记录当前被其他进程占用。");
    }
    if (Date.now() >= deadline) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任记录当前被其他进程占用。");
    await delay(10);
  }
  try { return await operation(); }
  finally {
    const current = await readTrustLock(lockPath);
    if (current?.ownerToken === owner.ownerToken) await unlink(lockPath).catch(() => undefined);
  }
}

async function appendJournalEvent(target: string, event: WorkflowTrustRequestedEvent | WorkflowTrustDecidedEvent): Promise<void> {
  const handle = await open(target, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function readWorkflowTrustRecords(root: string): Promise<WorkflowTrustRecord[]> {
  return (await readJournal(await workflowTrustPath(root))).records;
}

interface TrustLockFileState { dev: bigint; ino: bigint; mtimeMs: bigint; mtimeNs: bigint; size: bigint }

async function trustLockFileState(lockPath: string): Promise<TrustLockFileState | undefined> {
  try {
    const value = await stat(lockPath, { bigint: true });
    return { dev: value.dev, ino: value.ino, mtimeMs: value.mtimeMs, mtimeNs: value.mtimeNs, size: value.size };
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw caught;
  }
}

export async function recoverStaleWorkflowTrustLock(root: string): Promise<boolean> {
  const target = await workflowTrustPath(root);
  const lockPath = `${target}.lock`;
  const first = await trustLockFileState(lockPath);
  if (first === undefined) return false;
  if (Date.now() - Number(first.mtimeMs) < TRUST_LOCK_STALE_MILLISECONDS) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任锁尚未达到可恢复的 stale 阈值。");
  const owner = await readTrustLock(lockPath);
  await delay(10);
  const second = await trustLockFileState(lockPath);
  if (second === undefined || first.dev !== second.dev || first.ino !== second.ino || first.mtimeNs !== second.mtimeNs || first.size !== second.size) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任锁在恢复期间已经变化。");
  if (owner?.hostname === hostname() && processIsAlive(owner.pid)) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任锁的本机所有者仍然存活，不能抢占。");
  try { await unlink(lockPath); }
  catch { throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任锁在恢复期间已经变化。"); }
  return true;
}

export async function createWorkflowTrustRequest(root: string, request: WorkflowTrustRequestedEvent): Promise<void> {
  const target = await workflowTrustPath(root);
  await withTrustLock(target, async () => {
    const state = await readJournal(target);
    const existing = state.requests.get(request.requestId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(request)) return;
      throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID", "Workflow 信任 requestId 已绑定其他请求。");
    }
    parseRequested(request as unknown as Record<string, unknown>, state.requests.size + state.decisions.size + 1);
    await appendJournalEvent(target, request);
  });
}

export interface DecideWorkflowTrustRequestInput {
  requestId: string;
  packageRef: string;
  packageDigest: string;
  capabilityDigest: string;
  decision: "trusted" | "rejected";
  actor: string;
  decidedAt: string;
}

export async function decideWorkflowTrustRequest(root: string, input: DecideWorkflowTrustRequestInput): Promise<WorkflowTrustRecord> {
  const target = await workflowTrustPath(root);
  return withTrustLock(target, async () => {
    const state = await readJournal(target);
    const request = state.requests.get(input.requestId);
    if (request === undefined || request.packageRef !== input.packageRef || request.packageDigest !== input.packageDigest || request.capabilityDigest !== input.capabilityDigest) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID", "Workflow Package 信任请求不存在或已变化。");
    if (request.actor !== input.actor) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_ACTOR_INVALID", "Workflow Package 信任决定 actor 与请求不匹配。");
    const existing = state.decisions.get(input.requestId);
    if (existing !== undefined) {
      if (existing.decision !== input.decision) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_DECISION_CONFLICT", "同一 Workflow 信任请求不能记录冲突决定。");
      return deriveRecord(request, existing);
    }
    if (!isCanonicalIso(input.decidedAt) || input.decidedAt < request.createdAt || input.decidedAt >= request.expiresAt || request.expiresAt <= new Date().toISOString()) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID", "Workflow Package 信任请求已过期或时间无效。");
    const decision: WorkflowTrustDecidedEvent = { event: "decided", requestId: input.requestId, decision: input.decision, actor: input.actor, decidedAt: input.decidedAt };
    await appendJournalEvent(target, decision);
    return deriveRecord(request, decision);
  });
}
