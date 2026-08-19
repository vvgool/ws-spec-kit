import os from "node:os";

import type { WSSpecApplication } from "../protocol/application.js";
import { createDefaultExecutorRegistry, type ExecutorRegistry } from "../registry/executors/registry.js";
import type { SkillProvider } from "../registry/skills/types.js";
import { acquireApplication } from "./acquire.js";
import { decideApplication } from "./decide.js";
import { inspectApplication } from "./inspect.js";
import { startApplication } from "./start.js";
import { submitApplication } from "./submit.js";
import { ExternalActionError, type ExternalActionExecutor } from "./external-action.js";

export interface ApplicationDependencies {
  provider?: SkillProvider;
  home?: string;
  terminal?: { isTTY?: boolean };
  now?: () => Date;
  executors?: ExecutorRegistry;
  externalExecutor?: (provider: string, action: "issue.update" | "knowledge.publish" | "issue.close") => ExternalActionExecutor;
  workflowTrust?: { interactive: boolean; actor: string };
}

export function createApplication(input: ApplicationDependencies = {}): WSSpecApplication {
  const dependencies = {
    provider: input.provider ?? "generic",
    home: input.home ?? os.homedir(),
    terminal: input.terminal ?? process.stdin,
    now: input.now ?? (() => new Date()),
    executors: input.executors ?? createDefaultExecutorRegistry(),
    externalExecutor: input.externalExecutor ?? ((provider, action) => {
      throw new ExternalActionError("WSSPEC_EXTERNAL_EXECUTOR_NOT_FOUND", `找不到外部动作 Executor ${provider}/${action}。`);
    }),
    ...(input.workflowTrust === undefined ? {} : { workflowTrust: input.workflowTrust }),
  };
  return {
    start: (request) => startApplication(request, dependencies),
    acquire: (request) => acquireApplication(request, dependencies),
    submit: (request) => submitApplication(request, dependencies),
    decide: (request) => decideApplication(request, dependencies),
    inspect: inspectApplication,
  };
}
