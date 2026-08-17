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
