import os from "node:os";

import type { WSSpecApplication } from "../protocol/application.js";
import { createDefaultExecutorRegistry, type ExecutorRegistry } from "../registry/executors/registry.js";
import type { SkillProvider } from "../registry/skills/types.js";
import { createDefaultBuiltinConnectorRuntime, type BuiltinConnectorRuntime } from "../registry/connectors/runtime.js";
import { createBuiltinExternalExecutor } from "../registry/connectors/external-executor.js";
import { acquireApplication } from "./acquire.js";
import { decideApplication } from "./decide.js";
import { inspectApplication } from "./inspect.js";
import { startApplication } from "./start.js";
import { submitApplication } from "./submit.js";
import type { ExternalActionExecutor } from "./external-action.js";

export interface ApplicationDependencies {
  provider?: SkillProvider;
  home?: string;
  terminal?: { isTTY?: boolean };
  now?: () => Date;
  executors?: ExecutorRegistry;
  externalExecutor?: (provider: string, action: "issue.update" | "knowledge.publish" | "issue.close") => ExternalActionExecutor;
  workflowTrust?: { interactive: boolean; actor: string };
  connectorRuntime?: BuiltinConnectorRuntime;
}

export function createApplication(input: ApplicationDependencies = {}): WSSpecApplication {
  const home = input.home ?? os.homedir();
  const connectorRuntime = input.connectorRuntime ?? createDefaultBuiltinConnectorRuntime(home);
  const dependencies = {
    provider: input.provider ?? "generic",
    home,
    terminal: input.terminal ?? process.stdin,
    now: input.now ?? (() => new Date()),
    executors: input.executors ?? createDefaultExecutorRegistry(),
    externalExecutor: input.externalExecutor ?? ((provider, action) => createBuiltinExternalExecutor(connectorRuntime, provider, action)),
    connectorRuntime,
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
