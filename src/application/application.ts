import os from "node:os";

import type { WSSpecApplication } from "../protocol/application.js";
import { createDefaultExecutorRegistry, type ExecutorRegistry } from "../registry/executors/registry.js";
import type { SkillProvider } from "../registry/skills/types.js";
import { acquireApplication } from "./acquire.js";
import { decideApplication } from "./decide.js";
import { inspectApplication } from "./inspect.js";
import { startApplication } from "./start.js";
import { submitApplication } from "./submit.js";

export interface ApplicationDependencies {
  provider?: SkillProvider;
  home?: string;
  terminal?: { isTTY?: boolean };
  now?: () => Date;
  executors?: ExecutorRegistry;
  workflowTrust?: { interactive: boolean; actor: string };
}

export function createApplication(input: ApplicationDependencies = {}): WSSpecApplication {
  const dependencies = {
    provider: input.provider ?? "generic",
    home: input.home ?? os.homedir(),
    terminal: input.terminal ?? process.stdin,
    now: input.now ?? (() => new Date()),
    executors: input.executors ?? createDefaultExecutorRegistry(),
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
