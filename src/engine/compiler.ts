import {
  type CompiledWorkflow,
  type NormalizedStage,
  type StageKind,
  type StageOwner,
  type Workflow,
} from "../domain/workflow.js";
import { validate } from "../schemas/index.js";

export type { CompiledWorkflow, Workflow } from "../domain/workflow.js";

export interface ProjectConfig {
  quality: { gates: Record<string, { required: boolean }> };
  publishing?: { targets: Record<string, unknown> };
}

interface ExecutorContract {
  kinds: StageKind[];
  owner: StageOwner;
  inputs: string[];
  outputs: string[];
}

const executors: Record<string, ExecutorContract> = {
  "artifact.generate": {
    kinds: ["define", "design"],
    owner: "agent",
    inputs: ["intent", "specification"],
    outputs: ["specification", "design"],
  },
  "task.plan": {
    kinds: ["plan"],
    owner: "agent",
    inputs: ["specification", "design"],
    outputs: ["plan", "tasks"],
  },
  "engineering.implement": {
    kinds: ["implement"],
    owner: "agent",
    inputs: ["specification", "design", "plan", "tasks"],
    outputs: ["implementation-result"],
  },
  "engineering.review": {
    kinds: ["review"],
    owner: "agent",
    inputs: ["specification", "design", "implementation-result"],
    outputs: ["review-result"],
  },
  "quality.verify": {
    kinds: ["verify"],
    owner: "engine",
    inputs: ["implementation-result", "review-result"],
    outputs: ["verification-result"],
  },
  "issue.sync": { kinds: ["publish"], owner: "engine", inputs: [], outputs: [] },
  "knowledge.publish": {
    kinds: ["publish"],
    owner: "engine",
    inputs: ["specification", "design", "verification-result"],
    outputs: ["knowledge-entry"],
  },
  "work-item.close": { kinds: ["close"], owner: "engine", inputs: [], outputs: [] },
};

const expectedOwner: Record<StageKind, StageOwner> = {
  define: "agent",
  design: "agent",
  plan: "agent",
  implement: "agent",
  review: "agent",
  verify: "engine",
  publish: "engine",
  close: "engine",
};

const kindOutputs: Record<StageKind, string[]> = {
  define: ["specification"],
  design: ["design"],
  plan: ["plan", "tasks"],
  implement: ["implementation-result"],
  review: ["review-result"],
  verify: ["verification-result"],
  publish: ["knowledge-entry"],
  close: [],
};

export class CompileError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
    readonly suggestion: string,
  ) {
    super(message);
    this.name = "CompileError";
  }
}

function fail(code: string, index: number, message: string, suggestion: string): never {
  throw new CompileError(code, `/stages/${index}`, message, suggestion);
}

function normalize(stage: Workflow["stages"][number]): NormalizedStage {
  return {
    ...stage,
    needs: [...(stage.needs ?? [])],
    input: [...(stage.input ?? [])],
    output: [...(stage.output ?? [])],
    approval: stage.approval ?? { required: false },
    gates: [...(stage.gates ?? [])],
    publish: [...(stage.publish ?? [])],
  };
}

function dependencyClosure(stageId: string, byId: Map<string, NormalizedStage>): Set<string> {
  const result = new Set<string>();
  const visit = (id: string): void => {
    const stage = byId.get(id);
    if (stage === undefined) return;
    for (const dependency of stage.needs) {
      if (!result.has(dependency)) {
        result.add(dependency);
        visit(dependency);
      }
    }
  };
  visit(stageId);
  return result;
}

function topologicalOrder(stages: NormalizedStage[], byId: Map<string, NormalizedStage>): string[] {
  const state = new Map<string, "visiting" | "visited">();
  const order: string[] = [];
  const visit = (stage: NormalizedStage): void => {
    if (state.get(stage.id) === "visiting") {
      fail("WSSPEC_COMPILE_CYCLE", stages.indexOf(stage), `Stage ${stage.id} 形成循环依赖。`, "移除 needs 中的循环引用。");
    }
    if (state.get(stage.id) === "visited") return;
    state.set(stage.id, "visiting");
    for (const dependency of stage.needs) visit(byId.get(dependency)!);
    state.set(stage.id, "visited");
    order.push(stage.id);
  };
  for (const stage of stages) visit(stage);
  return order;
}

export function compileWorkflow(input: Workflow, config: ProjectConfig): CompiledWorkflow {
  validate("builtin.workflow.v1", input);
  const stages = input.stages.map(normalize);
  const byId = new Map<string, NormalizedStage>();

  for (const [index, stage] of stages.entries()) {
    if (byId.has(stage.id)) {
      fail("WSSPEC_COMPILE_DUPLICATE_STAGE", index, `Stage ID 重复：${stage.id}`, "为每个 Stage 使用唯一 ID。");
    }
    byId.set(stage.id, stage);
  }
  for (const [index, stage] of stages.entries()) {
    for (const dependency of stage.needs) {
      if (!byId.has(dependency)) {
        fail("WSSPEC_COMPILE_UNKNOWN_DEPENDENCY", index, `未知依赖：${dependency}`, "引用当前工作流中已定义的 Stage ID。");
      }
    }
  }

  const order = topologicalOrder(stages, byId);
  for (const [index, stage] of stages.entries()) {
    if (stage.owner !== expectedOwner[stage.kind]) {
      fail("WSSPEC_COMPILE_OWNER_KIND_MISMATCH", index, `${stage.kind} 必须由 ${expectedOwner[stage.kind]} 所有。`, "修正 owner 字段。");
    }
    const executor = executors[stage.uses];
    if (executor === undefined) {
      fail("WSSPEC_EXECUTOR_NOT_FOUND", index, `未注册 Executor：${stage.uses}`, "使用 M1 内置 Executor。");
    }
    if (!executor.kinds.includes(stage.kind) || executor.owner !== stage.owner) {
      fail("WSSPEC_EXECUTOR_CONTRACT_MISMATCH", index, `${stage.uses} 不支持 ${stage.kind}/${stage.owner}。`, "选择匹配 Stage kind 的 Executor。");
    }
    if (stage.input.some((artifact) => !executor.inputs.includes(artifact)) || stage.output.some((artifact) => !executor.outputs.includes(artifact))) {
      fail("WSSPEC_EXECUTOR_CONTRACT_MISMATCH", index, `${stage.uses} 的输入或输出不匹配。`, "按 Executor Manifest 修正 input/output。");
    }
    if (stage.output.some((artifact) => !kindOutputs[stage.kind].includes(artifact))) {
      fail("WSSPEC_EXECUTOR_CONTRACT_MISMATCH", index, `${stage.kind} 不能输出声明的工件类型。`, "按 Stage kind 的内置契约修正 output。");
    }

    const ancestors = dependencyClosure(stage.id, byId);
    const produced = new Set<string>(["intent"]);
    for (const ancestor of ancestors) for (const artifact of byId.get(ancestor)!.output) produced.add(artifact);
    const missing = stage.input.find((artifact) => !produced.has(artifact));
    if (missing !== undefined) {
      fail("WSSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER", index, `输入工件没有依赖生产者：${missing}`, "增加产生该工件的 needs 依赖路径。");
    }

    if (stage.kind === "implement") {
      for (const required of ["specification", "design", "plan"]) {
        const producer = [...ancestors].map((id) => byId.get(id)!).find((candidate) => candidate.output.includes(required));
        if (producer === undefined || !producer.approval.required || producer.approval.provider !== "interactive") {
          fail("WSSPEC_COMPILE_APPROVAL_REQUIRED", index, `实现前必须交互批准 ${required}。`, "为对应生产 Stage 配置 interactive approval。");
        }
      }
    }
    if (stage.kind === "verify") {
      if (![...ancestors].some((id) => byId.get(id)?.kind === "review")) {
        fail("WSSPEC_COMPILE_REVIEW_PATH_REQUIRED", index, "verify 没有 review 依赖路径。", "让 verify 直接或间接依赖 review Stage。");
      }
      const unknownGate = stage.gates.find((gate) => config.quality.gates[gate] === undefined);
      if (unknownGate !== undefined) {
        fail("WSSPEC_COMPILE_UNKNOWN_GATE", index, `未知 Gate：${unknownGate}`, "在 Project Config 中定义该 Gate。");
      }
      if (!stage.gates.some((gate) => config.quality.gates[gate]?.required === true)) {
        fail("WSSPEC_COMPILE_REQUIRED_GATE_MISSING", index, "verify 没有必需 Gate。", "至少引用一个 required Gate。");
      }
    }
    if (stage.kind === "close" && ![...ancestors].some((id) => byId.get(id)?.kind === "verify")) {
      fail("WSSPEC_COMPILE_VERIFY_PATH_REQUIRED", index, "close 没有 verify 依赖路径。", "让 close 直接或间接依赖 verify Stage。");
    }
  }

  return { version: 1, id: input.workflow.id, stages, order };
}
