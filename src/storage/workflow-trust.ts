import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { gitCommonDir } from "./git.js";
import type { WorkflowTrustRecord } from "../workflow-package/types.js";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class WorkflowTrustStoreError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) { super(`${code}: ${message}`); this.name = "WorkflowTrustStoreError"; }
}

interface TrustLockOwner { version: 1; ownerToken: string; pid: number; hostname: string; createdAt: string }
export interface PendingWorkflowTrustRequest { requestId: string; packageRef: string; packageDigest: string; capabilityDigest: string; createdAt: string; expiresAt: string; status: "pending" | "consumed" }

async function readTrustLock(lockPath: string): Promise<TrustLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<TrustLockOwner>;
    if (value.version !== 1 || typeof value.ownerToken !== "string" || typeof value.pid !== "number" || typeof value.hostname !== "string" || typeof value.createdAt !== "string") return undefined;
    return value as TrustLockOwner;
  } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (caught) { return (caught as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function workflowTrustPath(root: string): Promise<string> {
  return path.join(await gitCommonDir(root), "wsspec", "trust", "workflow-packages.ndjson");
}

async function pendingTrustPath(root: string): Promise<string> { return `${await workflowTrustPath(root)}.pending.ndjson`; }

async function withTrustLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  await mkdir(path.dirname(target), { recursive: true });
  const deadline = Date.now() + 5_000;
  const owner: TrustLockOwner = { version: 1, ownerToken: crypto.randomUUID(), pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() };
  let handle;
  while (true) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await readTrustLock(lockPath);
        if (existing?.hostname === hostname() && !processIsAlive(existing.pid)) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_STALE_LOCK", "检测到异常退出遗留的 Workflow 信任锁，请先恢复。");
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任记录当前被其他进程占用。");
      await delay(10);
    }
  }
  try { return await operation(); }
  finally {
    await handle.close();
    const current = await readTrustLock(lockPath);
    if (current?.ownerToken === owner.ownerToken) await unlink(lockPath).catch(() => undefined);
  }
}

function validRecord(value: unknown): value is WorkflowTrustRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => ["packageRef", "packageDigest", "capabilityDigest", "decision", "actor", "decidedAt"].includes(key)) && typeof record.packageRef === "string" && typeof record.packageDigest === "string" && typeof record.capabilityDigest === "string" && (record.decision === "trusted" || record.decision === "rejected") && typeof record.actor === "string" && typeof record.decidedAt === "string";
}

export async function readWorkflowTrustRecords(root: string): Promise<WorkflowTrustRecord[]> {
  const target = await workflowTrustPath(root);
  try {
    return (await readFile(target, "utf8")).split("\n").filter(Boolean).map((line, index) => {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_RECORD_INVALID", `Workflow 信任记录第 ${index + 1} 行不是合法 JSON。`); }
      if (!validRecord(value)) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_RECORD_INVALID", `Workflow 信任记录第 ${index + 1} 行包含不支持字段。`);
      const record = value as WorkflowTrustRecord;
      return { packageRef: record.packageRef, packageDigest: record.packageDigest, capabilityDigest: record.capabilityDigest, decision: record.decision, actor: record.actor, decidedAt: record.decidedAt };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function recoverStaleWorkflowTrustLock(root: string): Promise<boolean> {
  const target = await workflowTrustPath(root);
  const lockPath = `${target}.lock`;
  const owner = await readTrustLock(lockPath);
  if (owner === undefined) {
    try { const handle = await open(lockPath, "r"); await handle.close(); }
    catch (caught) { if ((caught as NodeJS.ErrnoException).code === "ENOENT") return false; }
    throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任锁缺少可验证的所有者信息，不能自动清理。");
  }
  if (owner.hostname !== hostname() || processIsAlive(owner.pid)) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任锁的所有者仍可能存活，不能抢占。");
  const confirmed = await readTrustLock(lockPath);
  if (confirmed?.ownerToken !== owner.ownerToken) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_LOCKED", "Workflow 信任锁在恢复期间已经变化。");
  await unlink(lockPath);
  return true;
}

export async function appendWorkflowTrustRecord(root: string, record: WorkflowTrustRecord): Promise<WorkflowTrustRecord> {
  const target = await workflowTrustPath(root);
  return withTrustLock(target, async () => {
    const handle = await open(target, "a", 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return record;
  });
}

function parsePending(value: unknown): PendingWorkflowTrustRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["requestId", "packageRef", "packageDigest", "capabilityDigest", "createdAt", "expiresAt", "status"].includes(key))) return undefined;
  if (typeof item.requestId !== "string" || typeof item.packageRef !== "string" || typeof item.packageDigest !== "string" || typeof item.capabilityDigest !== "string" || typeof item.createdAt !== "string" || typeof item.expiresAt !== "string" || (item.status !== "pending" && item.status !== "consumed")) return undefined;
  return item as unknown as PendingWorkflowTrustRequest;
}

async function readPending(target: string): Promise<PendingWorkflowTrustRequest[]> {
  try {
    return (await readFile(target, "utf8")).split("\n").filter(Boolean).map((line) => parsePending(JSON.parse(line))).map((item) => {
      if (item === undefined) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID", "Workflow 信任待决记录无效。");
      return item;
    });
  } catch (caught) { if ((caught as NodeJS.ErrnoException).code === "ENOENT") return []; throw caught; }
}

export async function createWorkflowTrustRequest(root: string, request: PendingWorkflowTrustRequest): Promise<void> {
  const target = await workflowTrustPath(root);
  return withTrustLock(target, async () => {
    const pending = await pendingTrustPath(root);
    const handle = await open(pending, "a", 0o600);
    try { await handle.writeFile(`${JSON.stringify(request)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  });
}

export async function consumeWorkflowTrustRequest(root: string, requestId: string, packageRef: string, packageDigest: string, capabilityDigest: string, record: WorkflowTrustRecord): Promise<WorkflowTrustRecord> {
  const target = await workflowTrustPath(root);
  return withTrustLock(target, async () => {
    const pendingPath = await pendingTrustPath(root);
    const pending = await readPending(pendingPath);
    const index = pending.findIndex((item) => item.requestId === requestId);
    const request = pending[index];
    if (request === undefined || request.status !== "pending" || request.expiresAt <= new Date().toISOString() || request.packageRef !== packageRef || request.packageDigest !== packageDigest || request.capabilityDigest !== capabilityDigest) throw new WorkflowTrustStoreError("WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID", "Workflow Package 信任请求不存在、已消费、已过期或已变化。");
    pending[index] = { ...request, status: "consumed" };
    const rewrite = await open(pendingPath, "w", 0o600);
    try { await rewrite.writeFile(`${pending.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8"); await rewrite.sync(); } finally { await rewrite.close(); }
    const handle = await open(target, "a", 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    return record;
  });
}
