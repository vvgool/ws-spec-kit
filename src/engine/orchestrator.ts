import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import type { Workflow } from "../domain/workflow.js";
import { readControlPlane } from "../storage/control-plane.js";
import { closeWorkItem } from "./archive.js";
import { transitionRuntime } from "./scheduler.js";
import { verifyWorkItem } from "./verification.js";

export async function workflowFor(cwd: string, workItemId: string): Promise<Workflow> {
  const projection = await readControlPlane(cwd, workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryRoot: string };
  return parse(await readFile(path.join(cache.repositoryRoot, locator.worktree, ".wsspec/work-items", workItemId, "snapshot/workflow.yaml"), "utf8")) as Workflow;
}

const satisfiesNeed = (status: string): boolean => ["succeeded", "succeeded_with_warnings", "skipped"].includes(status);

export async function advanceWorkflow(cwd: string, workItemId: string): Promise<{ workItemId: string; stageId?: string; status: string }> {
  const workflow = await workflowFor(cwd, workItemId);
  for (let iterations = 0; iterations < workflow.stages.length * 4 + 4; iterations += 1) {
    let projection = await readControlPlane(cwd, workItemId);
    if (projection.workItem.status === "closed" || projection.workItem.status === "cancelled") return { workItemId, status: projection.workItem.status };
    const agentReady = workflow.stages.find((stage) => stage.owner === "agent" && projection.stages[stage.id]?.status === "ready");
    if (agentReady !== undefined) return { workItemId, stageId: agentReady.id, status: "ready" };
    const schedulable = workflow.stages.find((stage) => projection.stages[stage.id]?.status === "pending" && (stage.needs ?? []).every((need) => satisfiesNeed(projection.stages[need]?.status ?? "pending")));
    if (schedulable === undefined) return { workItemId, status: projection.workItem.status };
    if (schedulable.kind === "publish") {
      await transitionRuntime({ cwd, workItemId, scope: "stage", stageId: schedulable.id, to: "skipped", idempotencyKey: `skip:${schedulable.id}` });
      continue;
    }
    projection = await transitionRuntime({ cwd, workItemId, scope: "stage", stageId: schedulable.id, to: "ready", idempotencyKey: `ready:${schedulable.id}` });
    if (schedulable.owner === "agent") return { workItemId, stageId: schedulable.id, status: "ready" };
    await transitionRuntime({ cwd, workItemId, scope: "stage", stageId: schedulable.id, to: "running", idempotencyKey: `engine-run:${schedulable.id}` });
    if (schedulable.kind === "verify") {
      await verifyWorkItem({ cwd, workItemId });
      await transitionRuntime({ cwd, workItemId, scope: "stage", stageId: schedulable.id, to: "validating", idempotencyKey: `engine-validate:${schedulable.id}` });
      await transitionRuntime({ cwd, workItemId, scope: "stage", stageId: schedulable.id, to: "succeeded", idempotencyKey: `engine-success:${schedulable.id}` });
      continue;
    }
    if (schedulable.kind === "close") {
      await transitionRuntime({ cwd, workItemId, scope: "stage", stageId: schedulable.id, to: "validating", idempotencyKey: `engine-validate:${schedulable.id}` });
      await transitionRuntime({ cwd, workItemId, scope: "stage", stageId: schedulable.id, to: "succeeded", idempotencyKey: `engine-success:${schedulable.id}` });
      const closed = await closeWorkItem({ cwd, workItemId });
      return { workItemId, status: closed.workItem.status };
    }
  }
  throw new Error("工作流调度超过安全迭代上限。");
}
