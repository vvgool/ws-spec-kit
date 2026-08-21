import type { CompiledStep, SecurityClass } from "../../domain/workflow.js";
import type { AgentAction, SubmitResult } from "../../protocol/application.js";
import type { WorkPackage } from "../../protocol/work-package.js";
import type { RuntimeProjection } from "../../storage/control-plane.js";
import type { StepExecutor, ValidatedStepResult } from "./types.js";

export class ExecutorRegistryError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExecutorRegistryError";
  }
}

export function executorId(step: Pick<CompiledStep, "uses" | "action">): string {
  return step.action === undefined ? step.uses : `${step.uses}/${step.action}`;
}

function workPackage(runtime: RuntimeProjection, stepId: string): WorkPackage {
  const value = runtime.contexts[stepId] as { workPackage?: WorkPackage } | undefined;
  if (value?.workPackage === undefined) {
    throw new ExecutorRegistryError("WSSPEC_EXECUTOR_CONTEXT_INVALID", `Step ${stepId} 缺少原子 Acquire 创建的 Work Package。`);
  }
  return value.workPackage;
}

function executor(id: string, securityClass: SecurityClass): StepExecutor {
  return {
    id,
    securityClass,
    async acquire(step, runtime): Promise<AgentAction> {
      return { action: "execute", workPackage: workPackage(runtime, step.id) };
    },
    async validate(_step, result): Promise<ValidatedStepResult> {
      return result.status === "failed"
        ? { status: "failed", artifacts: result.artifacts, failureCode: "WSSPEC_STEP_FAILED" }
        : { status: "completed", artifacts: result.artifacts };
    },
  };
}

export class ExecutorRegistry {
  readonly #executors = new Map<string, StepExecutor>();

  register(value: StepExecutor): this {
    if (this.#executors.has(value.id)) {
      throw new ExecutorRegistryError("WSSPEC_EXECUTOR_DUPLICATE", `Executor ${value.id} 已注册。`);
    }
    this.#executors.set(value.id, value);
    return this;
  }

  require(id: string): StepExecutor {
    const value = this.#executors.get(id);
    if (value === undefined) throw new ExecutorRegistryError("WSSPEC_EXECUTOR_NOT_FOUND", `找不到 Executor ${id}。`);
    return value;
  }

  assertStep(step: Pick<CompiledStep, "uses" | "action" | "securityClass">): StepExecutor {
    const value = this.require(executorId(step));
    if (value.securityClass !== step.securityClass) {
      throw new ExecutorRegistryError("WSSPEC_EXECUTOR_SECURITY_MISMATCH", `Executor ${value.id} 的安全类别与编译结果不一致。`);
    }
    return value;
  }
}

export function createDefaultExecutorRegistry(): ExecutorRegistry {
  return new ExecutorRegistry()
    .register(executor("agent.execute", "agent"))
    .register(executor("connector.execute/requirement.capture", "external-read"))
    .register(executor("connector.execute/git.commit", "local-write"))
    .register(executor("connector.execute/issue.update", "external-write"))
    .register(executor("connector.execute/knowledge.publish", "external-write"))
    .register(executor("connector.execute/issue.close", "external-write"))
    .register(executor("command.execute/quality.test", "local-write"))
    .register(executor("control.loop", "control"))
    .register(executor("control.close", "control"));
}

export type { StepExecutor } from "./types.js";
