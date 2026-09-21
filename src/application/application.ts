import { refreshTaskNavigationFor } from "./task-navigation.js";
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
  /** High-level continue must not renew or replace a previously granted lease. */
  preserveActiveClaim?: boolean;
  home?: string;
  terminal?: { isTTY?: boolean };
  now?: () => Date;
  executors?: ExecutorRegistry;
  externalExecutor?: (provider: string, action: import("../engine/external-effects/authorization.js").ExternalActionName) => ExternalActionExecutor;
  workflowTrust?: { interactive: boolean; actor: string };
  connectorRuntime?: BuiltinConnectorRuntime;
}

export function createApplication(input: ApplicationDependencies = {}): WSSpecApplication {
  const home = input.home ?? os.homedir();
  const connectorRuntime = input.connectorRuntime ?? createDefaultBuiltinConnectorRuntime(home);
  const dependencies = {
    provider: input.provider ?? "generic",
    ...(input.preserveActiveClaim === undefined ? {} : { preserveActiveClaim: input.preserveActiveClaim }),
    home,
    terminal: input.terminal ?? process.stdin,
    now: input.now ?? (() => new Date()),
    executors: input.executors ?? createDefaultExecutorRegistry(),
    externalExecutor: input.externalExecutor ?? ((provider, action) => createBuiltinExternalExecutor(connectorRuntime, provider, action)),
    connectorRuntime,
    ...(input.workflowTrust === undefined ? {} : { workflowTrust: input.workflowTrust }),
  };
  return {
    start: async (request) => {
      const result = await startApplication(request, dependencies);
      await refreshTaskNavigationFor(request.root, result.workItemId);
      return result;
    },
    acquire: async (request) => {
      const result = await acquireApplication(request, dependencies);
      await refreshTaskNavigationFor(request.root, request.workItemId);
      return result;
    },
    submit: async (request) => {
      const result = await submitApplication(request, dependencies);
      await refreshTaskNavigationFor(request.root, request.workItemId);
      return result;
    },
    decide: async (request) => {
      const result = await decideApplication(request, dependencies);
      if ("workItemId" in request) await refreshTaskNavigationFor(request.root, request.workItemId);
      return result;
    },
    inspect: async (request) => {
      const result = await inspectApplication(request);
      await refreshTaskNavigationFor(request.root, request.workItemId);
      return result;
    },
  };
}
