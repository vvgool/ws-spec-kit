import { open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";

import { sha256 } from "../domain/digests.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export interface DomainEvent {
  eventId: string;
  eventType:
    | "work-item.transitioned"
    | "stage.transitioned"
    | "claim.created"
    | "claim.renewed"
    | "claim.released"
    | "context.created"
    | "attempt.acquired"
    | "step.skipped"
    | "attempt.submitted"
    | "approval.requested"
    | "approval.decided"
    | "approval.expired"
    | "evidence.recorded"
    | "source.captured"
    | "profile.selected"
    | "profile.upgraded"
    | "projection.invalidated"
    | "work-item.closed"
    | "lock.recovered";
  occurredAt: string;
  actor: string;
  repositoryId: string;
  workItemId: string;
  stageId: string | null;
  attemptId: string | null;
  from: string;
  to: string;
  idempotencyKey: string;
  workflowDigest: string;
  configDigest: string;
  baselineTreeDigest: string;
  inputWorkspaceTreeDigest: string;
  outputWorkspaceTreeDigest: string | null;
  inputDigest: string;
  result: unknown;
}

export interface StoredEvent extends DomainEvent {
  sequence: number;
  previousHash: string | null;
  eventHash: string;
}

export class EventStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EventStoreError";
  }
}

function eventHash(event: Omit<StoredEvent, "eventHash">): string {
  const content = canonicalize(event);
  if (content === undefined) throw new EventStoreError("WSSPEC_EVENT_INVALID", "事件无法规范化。");
  return sha256(content);
}

export async function readEvents(controlPlane: string): Promise<StoredEvent[]> {
  let text: string;
  try {
    text = await readFile(path.join(controlPlane, "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: StoredEvent[] = [];
  let previousHash: string | null = null;
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "") continue;
    let event: StoredEvent;
    try {
      event = JSON.parse(line) as StoredEvent;
    } catch {
      throw new EventStoreError("WSSPEC_EVENT_CHAIN_INVALID", `事件日志第 ${index + 1} 行不是合法 JSON。`);
    }
    const { eventHash: actualHash, ...unsigned } = event;
    if (event.sequence !== events.length + 1 || event.previousHash !== previousHash || eventHash(unsigned) !== actualHash) {
      throw new EventStoreError("WSSPEC_EVENT_CHAIN_INVALID", `事件日志在序号 ${event.sequence} 处断链。`);
    }
    events.push(event);
    previousHash = event.eventHash;
  }
  return events;
}

export async function repairIncompleteEventTail(controlPlane: string): Promise<boolean> {
  const eventPath = path.join(controlPlane, "events.jsonl");
  let content: string;
  try { content = await readFile(eventPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (content === "" || content.endsWith("\n")) return false;
  const lastNewline = content.lastIndexOf("\n");
  const tail = content.slice(lastNewline + 1);
  try { JSON.parse(tail); return false; } catch { /* An interrupted append is the only repairable corruption. */ }
  const handle = await open(eventPath, "r+");
  try { await handle.truncate(lastNewline + 1); await handle.sync(); }
  finally { await handle.close(); }
  return true;
}

async function appendEventUnlocked(controlPlane: string, event: DomainEvent): Promise<StoredEvent> {
  const current = await readEvents(controlPlane);
  const unsigned = {
    ...event,
    sequence: current.length + 1,
    previousHash: current.at(-1)?.eventHash ?? null,
  };
  const stored: StoredEvent = { ...unsigned, eventHash: eventHash(unsigned) };
  const handle = await open(path.join(controlPlane, "events.jsonl"), "a", 0o600);
  try {
    const content = canonicalize(stored);
    if (content === undefined) throw new EventStoreError("WSSPEC_EVENT_INVALID", "事件无法规范化。");
    await handle.writeFile(`${content}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return stored;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

interface LockOwner {
  version: 1;
  ownerToken: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

async function readLock(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    if (value.version !== 1 || typeof value.ownerToken !== "string" || typeof value.pid !== "number" || typeof value.hostname !== "string" || typeof value.createdAt !== "string") return undefined;
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function recoverStaleControlPlaneLock(controlPlane: string): Promise<boolean> {
  const lockPath = path.join(controlPlane, "runtime.lock");
  const owner = await readLock(lockPath);
  if (owner === undefined) {
    try { const handle = await open(lockPath, "r"); await handle.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; }
    throw new EventStoreError("WSSPEC_CONTROL_PLANE_LOCKED", "控制面锁缺少可验证的所有者信息，不能自动清理。");
  }
  if (owner.hostname !== hostname() || processIsAlive(owner.pid)) throw new EventStoreError("WSSPEC_CONTROL_PLANE_LOCKED", "控制面锁的所有者仍可能存活，不能抢占。");
  const confirmed = await readLock(lockPath);
  if (confirmed?.ownerToken !== owner.ownerToken) throw new EventStoreError("WSSPEC_CONTROL_PLANE_LOCKED", "控制面锁在恢复期间已经变化。");
  await unlink(lockPath);
  return true;
}

export async function withControlPlaneLock<T>(controlPlane: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(controlPlane, "runtime.lock");
  const deadline = Date.now() + 5_000;
  const owner: LockOwner = { version: 1, ownerToken: crypto.randomUUID(), pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() };
  let handle;
  while (true) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await readLock(lockPath);
        if (existing?.hostname === hostname() && !processIsAlive(existing.pid)) {
          throw new EventStoreError("WSSPEC_CONTROL_PLANE_STALE_LOCK", "检测到异常退出遗留的控制面锁，请在确认所有者已退出后执行受控恢复。");
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw new EventStoreError("WSSPEC_CONTROL_PLANE_LOCKED", "共享控制面当前被其他进程占用。");
      }
      await delay(10);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    const current = await readLock(lockPath);
    if (current?.ownerToken === owner.ownerToken) await unlink(lockPath).catch(() => undefined);
  }
}

export async function appendEvent(controlPlane: string, event: DomainEvent): Promise<StoredEvent> {
  return withControlPlaneLock(controlPlane, () => appendEventUnlocked(controlPlane, event));
}

export { appendEventUnlocked };
