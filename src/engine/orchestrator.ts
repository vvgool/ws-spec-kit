import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { validate } from "../schemas/index.js";
import { readControlPlane } from "../storage/control-plane.js";
import { closeWorkItem } from "./archive.js";
import { transitionRuntime } from "./scheduler.js";
import { verifyWorkItem } from "./verification.js";

type LegacyStageKind = "define" | "design" | "plan" | "implement" | "review" | "verify" | "publish" | "close";
type LegacyStageOwner = "agent" | "engine";

export interface LegacyStage {
  id: string;
  owner: LegacyStageOwner;
  kind: LegacyStageKind;
  uses: string;
  needs?: string[];
  input?: string[];
  output?: string[];
  approval?: { required: boolean; provider?: "interactive" };
  gates?: string[];
}

export interface LegacyWorkflowSnapshot { stages: LegacyStage[] }
export interface LegacyProjectConfigSnapshot { quality: { gates: Record<string, { required: boolean }> } }

interface LegacyExecutorContract {
  owner: LegacyStageOwner;
  kinds: readonly LegacyStageKind[];
  inputs: readonly string[];
  outputs: readonly string[];
}

const legacyExecutors: Readonly<Record<string, LegacyExecutorContract>> = {
  "artifact.generate": { owner: "agent", kinds: ["define", "design"], inputs: ["intent", "specification"], outputs: ["specification", "design"] },
  "task.plan": { owner: "agent", kinds: ["plan"], inputs: ["specification", "design"], outputs: ["plan", "tasks"] },
  "engineering.implement": { owner: "agent", kinds: ["implement"], inputs: ["specification", "design", "plan", "tasks"], outputs: ["implementation-result"] },
  "engineering.review": { owner: "agent", kinds: ["review"], inputs: ["specification", "design", "implementation-result"], outputs: ["review-result"] },
  "quality.verify": { owner: "engine", kinds: ["verify"], inputs: ["implementation-result", "review-result"], outputs: ["verification-result"] },
  "issue.sync": { owner: "engine", kinds: ["publish"], inputs: [], outputs: [] },
  "knowledge.publish": { owner: "engine", kinds: ["publish"], inputs: ["specification", "design", "verification-result"], outputs: ["knowledge-entry"] },
  "work-item.close": { owner: "engine", kinds: ["close"], inputs: [], outputs: [] },
};

const expectedLegacyOwner: Record<LegacyStageKind, LegacyStageOwner> = {
  define: "agent", design: "agent", plan: "agent", implement: "agent", review: "agent", verify: "engine", publish: "engine", close: "engine",
};

const legacyKindOutputs: Record<LegacyStageKind, readonly string[]> = {
  define: ["specification"], design: ["design"], plan: ["plan", "tasks"], implement: ["implementation-result"], review: ["review-result"], verify: ["verification-result"], publish: ["knowledge-entry"], close: [],
};

export class LegacyWorkflowError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, readonly path: string, message: string) {
    super(`${code} ${path}: ${message}`);
    this.name = "LegacyWorkflowError";
  }
}

function legacyFail(code: `WSSPEC_${string}`, path: string, message: string): never {
  throw new LegacyWorkflowError(code, path, message);
}

function legacyArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function legacyDependencyClosure(stageId: string, byId: ReadonlyMap<string, LegacyStage>): Set<string> {
  const result = new Set<string>();
  const visit = (id: string): void => {
    for (const dependency of byId.get(id)?.needs ?? []) if (!result.has(dependency)) { result.add(dependency); visit(dependency); }
  };
  visit(stageId);
  return result;
}

export function validateLegacyWorkflowSnapshot(value: unknown, configValue: unknown): LegacyWorkflowSnapshot {
  const workflow = validate<LegacyWorkflowSnapshot>("builtin.workflow.v1", value);
  const config = validate<LegacyProjectConfigSnapshot>("builtin.project-config.v1", configValue);
  const byId = new Map<string, LegacyStage>();
  for (const [index, stage] of workflow.stages.entries()) {
    const stagePath = `/stages/${index}`;
    if (stage === null || typeof stage !== "object" || typeof stage.id !== "string" || stage.id === "" || typeof stage.kind !== "string" || typeof stage.owner !== "string" || typeof stage.uses !== "string" || !legacyArray(stage.needs ?? []) || !legacyArray(stage.input ?? []) || !legacyArray(stage.output ?? []) || !legacyArray(stage.gates ?? [])) legacyFail("WSSPEC_LEGACY_WORKFLOW_INVALID", stagePath, "Stage 字段无效。");
    if (byId.has(stage.id)) legacyFail("WSSPEC_COMPILE_DUPLICATE_STAGE", stagePath, `Stage ID 重复：${stage.id}。`);
    byId.set(stage.id, stage);
  }
  for (const [index, stage] of workflow.stages.entries()) {
    for (const dependency of stage.needs ?? []) if (!byId.has(dependency)) legacyFail("WSSPEC_COMPILE_UNKNOWN_DEPENDENCY", `/stages/${index}`, `未知依赖：${dependency}。`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) legacyFail("WSSPEC_COMPILE_CYCLE", `/stages/${workflow.stages.findIndex((stage) => stage.id === id)}`, `Stage ${id} 形成循环依赖。`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.needs ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);

  for (const [index, stage] of workflow.stages.entries()) {
    const stagePath = `/stages/${index}`;
    if (!(stage.kind in expectedLegacyOwner) || stage.owner !== expectedLegacyOwner[stage.kind]) legacyFail("WSSPEC_COMPILE_OWNER_KIND_MISMATCH", stagePath, `${stage.kind} 与 owner 不匹配。`);
    const executor = legacyExecutors[stage.uses];
    if (executor === undefined) legacyFail("WSSPEC_EXECUTOR_NOT_FOUND", stagePath, `未注册 Executor：${stage.uses}。`);
    if (!executor.kinds.includes(stage.kind) || executor.owner !== stage.owner) legacyFail("WSSPEC_EXECUTOR_CONTRACT_MISMATCH", stagePath, `${stage.uses} 不支持 ${stage.kind}/${stage.owner}。`);
    if ((stage.input ?? []).some((artifact) => !executor.inputs.includes(artifact)) || (stage.output ?? []).some((artifact) => !executor.outputs.includes(artifact)) || (stage.output ?? []).some((artifact) => !legacyKindOutputs[stage.kind].includes(artifact))) legacyFail("WSSPEC_EXECUTOR_CONTRACT_MISMATCH", stagePath, `${stage.uses} 的输入或输出不匹配。`);
    const ancestors = legacyDependencyClosure(stage.id, byId);
    const produced = new Set<string>(["intent"]);
    for (const ancestor of ancestors) for (const artifact of byId.get(ancestor)?.output ?? []) produced.add(artifact);
    const missing = (stage.input ?? []).find((artifact) => !produced.has(artifact));
    if (missing !== undefined) legacyFail("WSSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER", stagePath, `输入工件没有依赖生产者：${missing}。`);
    if (stage.kind === "implement") {
      for (const required of ["specification", "design", "plan"]) {
        const producer = [...ancestors].map((id) => byId.get(id)!).find((candidate) => candidate.output?.includes(required));
        if (producer === undefined || !producer.approval?.required || producer.approval.provider !== "interactive") legacyFail("WSSPEC_COMPILE_APPROVAL_REQUIRED", stagePath, `实现前必须交互批准 ${required}。`);
      }
    }
    if (stage.kind === "verify") {
      if (![...ancestors].some((id) => byId.get(id)?.kind === "review")) legacyFail("WSSPEC_COMPILE_REVIEW_PATH_REQUIRED", stagePath, "verify 没有 review 依赖路径。");
      const unknownGate = (stage.gates ?? []).find((gate) => config.quality!.gates[gate] === undefined);
      if (unknownGate !== undefined) legacyFail("WSSPEC_COMPILE_UNKNOWN_GATE", stagePath, `未知 Gate：${unknownGate}。`);
      if (!(stage.gates ?? []).some((gate) => config.quality!.gates[gate]?.required === true)) legacyFail("WSSPEC_COMPILE_REQUIRED_GATE_MISSING", stagePath, "verify 没有必需 Gate。");
    }
    if (stage.kind === "close" && ![...ancestors].some((id) => byId.get(id)?.kind === "verify")) legacyFail("WSSPEC_COMPILE_VERIFY_PATH_REQUIRED", stagePath, "close 没有 verify 依赖路径。");
  }
  return workflow;
}

export async function workflowFor(cwd: string, workItemId: string): Promise<LegacyWorkflowSnapshot> {
  const projection = await readControlPlane(cwd, workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryRoot: string };
  return parse(await readFile(path.join(cache.repositoryRoot, locator.worktree, ".wsspec/work-items", workItemId, "snapshot/workflow.yaml"), "utf8")) as LegacyWorkflowSnapshot;
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
