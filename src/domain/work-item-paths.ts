import { createHash } from "node:crypto";

interface WorkItemLocation {
  workItemId: string;
  execution?: { directoryName?: string };
}

export function readableWorkItemDirectory(title: string, workItemId: string): string {
  const label = [...title.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "")]
    .slice(0, 36).join("").replace(/-+$/u, "") || "任务";
  return `${label}-${createHash("sha256").update(workItemId).digest("hex").slice(0, 12)}`;
}

export function workItemDirectory(item: WorkItemLocation): string {
  const name = item.execution?.directoryName ?? item.workItemId;
  if (item.execution?.directoryName === undefined && /^WSS-[A-Za-z0-9-]+$/u.test(name)) return name;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}-]{0,100}$/u.test(name)) throw new Error("Invalid Work Item directory name");
  return name;
}

export function workItemPrefix(item: WorkItemLocation): string {
  return `.wsspec/work-items/${workItemDirectory(item)}`;
}
