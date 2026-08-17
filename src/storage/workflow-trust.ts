import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { gitCommonDir } from "./git.js";
import type { WorkflowTrustRecord } from "../workflow-package/types.js";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function workflowTrustPath(root: string): Promise<string> {
  return path.join(await gitCommonDir(root), "wsspec", "trust", "workflow-packages.ndjson");
}

async function withTrustLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  await mkdir(path.dirname(target), { recursive: true });
  const deadline = Date.now() + 5_000;
  let handle;
  while (true) {
    try { handle = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
}

function validRecord(value: unknown): value is WorkflowTrustRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.packageRef === "string" && typeof record.packageDigest === "string" && typeof record.capabilityDigest === "string" && (record.decision === "trusted" || record.decision === "rejected") && typeof record.actor === "string" && typeof record.decidedAt === "string";
}

export async function readWorkflowTrustRecords(root: string): Promise<WorkflowTrustRecord[]> {
  const target = await workflowTrustPath(root);
  try {
    return (await readFile(target, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter(validRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
