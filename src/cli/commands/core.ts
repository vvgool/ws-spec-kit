import { recoverApplication } from "../../application/recover.js";
import { createAgentActions, type AgentCompleteInput } from "../../application/agent-actions.js";
import { manageProjectGuidance } from "../../adapters/skills/project-guidance.js";
import { revalidateRed } from "../../application/revalidate-red.js";
import { retryTestGate } from "../../application/retry-test-gate.js";
import { parse } from "yaml";
import { suggestTestingConfig } from "../../storage/testing-config.js";
import { migrateTestingConfig } from "../../application/testing-config.js";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { inspectDriverSkill, installDriverSkill, setupDriverSkill, type DriverAgent } from "../../adapters/skills/install.js";
import { CliAdapterError } from "../../adapters/cli/output.js";
import { runWorkflowCommand } from "../../adapters/cli/workflow.js";
import { createApplication } from "../../application/application.js";
import { createApplicationArtifact } from "../../application/artifact.js";
import { doctorConnectors } from "../../application/doctor-connectors.js";
import type { ArtifactCreateInput, DecisionInput, StartInput, SubmitInput } from "../../protocol/application.js";
import type { SkillProvider } from "../../registry/skills/types.js";
import { initRepository, loadRepository } from "../../storage/repository.js";
import { loadBuiltinCatalog } from "../../resources/catalog.js";
import type { ConnectorExecutable } from "../../registry/connectors/types.js";

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "" || value.startsWith("--")) throw new CliAdapterError("WSSPEC_ARGUMENT_REQUIRED", `缺少参数 ${name}。`);
  return value;
}

interface ParsedArguments { positional: string[]; values: Record<string, string>; flags: Set<string> }

function parseArguments(argv: string[], positions: number, valueOptions: readonly string[], flags: readonly string[] = []): ParsedArguments {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const selectedFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    if (valueOptions.includes(value)) {
      if (values[value] !== undefined || selectedFlags.has(value)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", `不支持或重复参数 ${value}。`);
      values[value] = required(argv[index + 1], value);
      index += 1;
      continue;
    }
    if (flags.includes(value)) {
      if (selectedFlags.has(value) || values[value] !== undefined) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", `不支持或重复参数 ${value}。`);
      selectedFlags.add(value);
      continue;
    }
    throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", `不支持参数 ${value}。`);
  }
  if (positional.length !== positions) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "命令包含多余或缺少的位置参数。 ");
  return { positional, values, flags: selectedFlags };
}

function provider(value: string | undefined): SkillProvider {
  if (value === undefined) return "generic";
  if ((["codex", "claude", "cursor", "generic"] as string[]).includes(value)) return value as SkillProvider;
  throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Provider 必须是 codex、claude、cursor 或 generic。");
}

function application(home: string, actor: string | undefined, selectedProvider: SkillProvider) {
  return createApplication({ home, provider: selectedProvider, terminal: process.stdin, workflowTrust: { interactive: process.stdin.isTTY === true, actor: actor ?? "cli" } });
}

async function start(root: string, argv: string[], home: string): Promise<unknown> {
  const args = parseArguments(argv, 0, [
    "--prompt", "--file", "--source-provider", "--source-id", "--source-url",
    "--workflow", "--intent", "--profile", "--actor", "--provider",
  ]);
  const prompt = args.values["--prompt"];
  const file = args.values["--file"];
  const sourceProvider = args.values["--source-provider"];
  const sourceId = args.values["--source-id"];
  const sourceUrl = args.values["--source-url"];
  const hasExternalSource = sourceProvider !== undefined || sourceId !== undefined || sourceUrl !== undefined;
  const sourceKinds = Number(prompt !== undefined) + Number(file !== undefined) + Number(hasExternalSource);
  if (sourceKinds !== 1) {
    throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "start 必须且只能提供 --prompt、--file 或一组外部来源参数。 ");
  }
  if (hasExternalSource) {
    if (sourceProvider === undefined || sourceId === undefined
      || !["github", "gitlab", "feishu"].includes(sourceProvider)
      || (sourceUrl !== undefined && sourceUrl !== sourceId)) {
      throw new CliAdapterError(
        "WSSPEC_ARGUMENT_INVALID",
        "外部来源必须提供有效的 --source-provider github|gitlab|feishu 和 --source-id；--source-url 必须与 Source ID 相同。",
      );
    }
  }
  const intent = args.values["--intent"];
  const workflows: Record<string, string> = { feature: "feature-delivery", fix: "bugfix-delivery", assessment: "assessment", docs: "documentation-delivery" };
  if (intent !== undefined && (!Object.hasOwn(workflows, intent) || args.values["--workflow"] !== undefined)) {
    throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "--intent 支持 feature、fix、assessment、docs，不能同时提供 --workflow。");
  }
  const workflowRef = intent === undefined ? args.values["--workflow"] : "builtin://workflows/" + workflows[intent];
  const profile = args.values["--profile"];
  if (profile !== undefined && !["auto", "quick", "standard", "governed"].includes(profile)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Profile 必须是 auto、quick、standard 或 governed。");
  const input: StartInput = {
    root,
    source: prompt !== undefined
      ? { type: "prompt", text: prompt }
      : file !== undefined
        ? { type: "file", path: file }
        : {
            type: "issue",
            provider: sourceProvider!,
            id: sourceId!,
            ...(sourceUrl === undefined ? {} : { url: sourceUrl }),
          },
    ...(workflowRef === undefined ? {} : { workflowRef }),
    ...(profile === undefined ? {} : { profile: profile as NonNullable<StartInput["profile"]> }),
  };
  return application(home, args.values["--actor"], provider(args.values["--provider"])).start(input);
}

async function acquire(root: string, argv: string[], home: string): Promise<unknown> {
  const args = parseArguments(argv, 1, ["--actor"]);
  return application(home, args.values["--actor"], "generic").acquire({ root, workItemId: args.positional[0]! as `WSS-${string}`, actor: required(args.values["--actor"], "--actor") });
}

async function submit(root: string, argv: string[], home: string): Promise<unknown> {
  const args = parseArguments(argv, 1, ["--step", "--attempt", "--lease", "--result", "--actor"]);
  const resultPath = required(args.values["--result"], "--result");
  const result = JSON.parse(await readFile(path.resolve(root, resultPath), "utf8")) as SubmitInput["result"];
  return application(home, args.values["--actor"], "generic").submit({
    root,
    workItemId: args.positional[0]! as `WSS-${string}`,
    stepId: required(args.values["--step"], "--step"),
    attemptId: required(args.values["--attempt"], "--attempt"),
    leaseToken: required(args.values["--lease"], "--lease"),
    result,
  });
}

async function artifact(root: string, argv: string[]): Promise<unknown> {
  if (argv[0] !== "create") throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知 Artifact 命令：${argv[0] ?? ""}`);
  const args = parseArguments(argv.slice(1), 0, [
    "--work-item", "--step", "--attempt", "--lease-token", "--artifact-type", "--output", "--content-file",
  ]);
  const outputId = args.values["--output"];
  const input: ArtifactCreateInput = {
    root,
    workItemId: required(args.values["--work-item"], "--work-item") as `WSS-${string}`,
    stepId: required(args.values["--step"], "--step"),
    attemptId: required(args.values["--attempt"], "--attempt"),
    leaseToken: required(args.values["--lease-token"], "--lease-token"),
    artifactType: required(args.values["--artifact-type"], "--artifact-type"),
    ...(outputId === undefined ? {} : { outputId }),
    contentFile: required(args.values["--content-file"], "--content-file"),
  };
  return createApplicationArtifact(input, { now: () => new Date() });
}

async function decide(root: string, argv: string[], home: string): Promise<unknown> {
  const args = parseArguments(argv, 0, ["--input", "--actor"]);
  const input = JSON.parse(await readFile(path.resolve(root, required(args.values["--input"], "--input")), "utf8")) as Omit<DecisionInput, "root" | "actor">;
  return application(home, args.values["--actor"], "generic").decide({ ...input, root, actor: required(args.values["--actor"], "--actor") } as DecisionInput);
}

async function inspect(root: string, argv: string[], home: string): Promise<unknown> {
  const args = parseArguments(argv, 1, []);
  return application(home, undefined, "generic").inspect({ root, workItemId: args.positional[0]! as `WSS-${string}` });
}

async function readObject(root: string, filename: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path.resolve(root, filename), "utf8"));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Report an actionable CLI input error. */ }
  throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "输入文件必须是可读取的 JSON 对象。");
}

async function agentAction(root: string, argv: string[], home: string, command: "continue" | "complete"): Promise<unknown> {
  const args = parseArguments(argv, 1, command === "continue" ? ["--actor"] : ["--actor", "--package", "--input"]);
  const actor = required(args.values["--actor"], "--actor");
  const actions = createAgentActions({ home, provider: "generic", terminal: process.stdin,
    workflowTrust: { interactive: process.stdin.isTTY === true, actor } });
  const binding = { root, workItemId: args.positional[0]! as AgentCompleteInput["workItemId"], actor };
  if (command === "continue") return actions.continue(binding);
  const captured = await readObject(root, required(args.values["--package"], "--package"));
  const envelope = captured.result !== null && typeof captured.result === "object" ? captured.result as Record<string, unknown> : captured;
  const wp = envelope.workPackage ?? envelope;
  const input = await readObject(root, required(args.values["--input"], "--input"));
  if (Object.keys(input).some(key => key !== "outputs" && key !== "result")) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "complete 输入只接受 outputs 与 result。");
  return actions.complete({ ...binding, workPackage: wp as AgentCompleteInput["workPackage"],
    outputs: input.outputs as AgentCompleteInput["outputs"], result: input.result as AgentCompleteInput["result"] });
}

async function agent(argv: string[], home: string, root: string): Promise<unknown> {
  if (argv[0] === "project") {
    const operation = argv[1];
    if (operation !== "setup" && operation !== "remove") throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "agent project 支持 setup 或 remove。");
    const args = parseArguments(argv.slice(2), 0, [], ["--dry-run"]);
    const identity = await loadRepository(root);
    return manageProjectGuidance({ root: identity.repositoryRoot, operation, dryRun: args.flags.has("--dry-run") });
  }
  if (argv[0] !== "install" && argv[0] !== "status" && argv[0] !== "setup") throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知 Agent 命令：${argv[0] ?? ""}`);
  const usesClientOption = argv.includes("--client");
  const args = parseArguments(argv.slice(1), usesClientOption ? 0 : 1, ["--client", "--target"], argv[0] !== "status" ? ["--dry-run"] : []);
  const name = usesClientOption ? required(args.values["--client"], "--client") : args.positional[0]!;
  if (!(["codex", "claude", "cursor", "generic"] as string[]).includes(name)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Agent 必须是 codex、claude、cursor 或 generic。");
  const target = args.values["--target"];
  if (argv[0] === "status") return inspectDriverSkill({ agent: name as DriverAgent, home, ...(target === undefined ? {} : { target }) });
  const install = argv[0] === "setup" ? setupDriverSkill : installDriverSkill;
  return install({ agent: name as DriverAgent, home, ...(target === undefined ? {} : { target }), dryRun: args.flags.has("--dry-run") });
}

async function locateExecutable(executable: ConnectorExecutable): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(directory, executable);
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  return undefined;
}

async function doctor(argv: string[], home: string): Promise<unknown> {
  const args = parseArguments(argv, 1, []);
  if (args.positional[0] !== "connectors") throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "doctor 只支持 connectors。 ");
  const catalog = await loadBuiltinCatalog();
  return doctorConnectors({
    manifests: catalog.connectors,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GLAB_CONFIG_DIR: process.env.GLAB_CONFIG_DIR,
      LARK_CONFIG_DIR: process.env.LARK_CONFIG_DIR,
    },
    locateExecutable,
  });
}

export async function runCommand(cwd: string, argv: string[]): Promise<unknown> {
  const [command, ...args] = argv;
  const home = process.env.HOME ?? os.homedir();
  const handler = routes[command ?? ""];
  if (handler !== undefined) return handler(cwd, args, home);
  throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知命令：${command ?? ""}`);
}

const routes: Readonly<Record<string, (cwd: string, args: string[], home: string) => Promise<unknown>>> = Object.freeze({
  init: async (cwd, args) => { const parsed = parseArguments(args, 0, ["--test-root"]); return initRepository(cwd, parsed.values["--test-root"]); },
  config: async (root, argv) => {
    if (argv[0] === "suggest") { const args = parseArguments(argv.slice(1), 0, ["--test-root"]); return suggestTestingConfig(root, args.values["--test-root"]); }
    if (argv[0] !== "migrate") throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "config 支持 suggest 或 migrate。");
    const args = parseArguments(argv.slice(1), 1, ["--file", "--expected-digest", "--actor"]);
    return migrateTestingConfig({ root, workItemId: args.positional[0]!,
      config: parse(await readFile(path.resolve(root, required(args.values["--file"], "--file")), "utf8")),
      expectedDigest: required(args.values["--expected-digest"], "--expected-digest"), actor: required(args.values["--actor"], "--actor") });
  },
  recover: async (root, argv) => {
    const args = parseArguments(argv, 1, ["--actor", "--reason"]);
    return recoverApplication({ root, workItemId: args.positional[0]! as `WSS-${string}`, actor: required(args.values["--actor"], "--actor"), reason: required(args.values["--reason"], "--reason") });
  },
  "revalidate-red": async (root, argv) => {
    const args = parseArguments(argv, 1, ["--expected-evidence", "--actor", "--reason"]);
    return revalidateRed({ root, workItemId: args.positional[0]!, expectedEvidence: required(args.values["--expected-evidence"], "--expected-evidence"), actor: required(args.values["--actor"], "--actor"), reason: required(args.values["--reason"], "--reason") });
  },
  "retry-test-gate": async (root, argv) => {
    const args = parseArguments(argv, 1, ["--expected-attempt", "--actor", "--reason"]);
    return retryTestGate({ root, workItemId: args.positional[0]!, expectedAttempt: required(args.values["--expected-attempt"], "--expected-attempt"), actor: required(args.values["--actor"], "--actor"), reason: required(args.values["--reason"], "--reason") });
  },
  start,
  acquire,
  artifact,
  submit,
  decide,
  inspect,
  status: inspect,
  continue: (root, args, home) => agentAction(root, args, home, "continue"),
  complete: (root, args, home) => agentAction(root, args, home, "complete"),
  workflow: (cwd, args, home) => runWorkflowCommand({ root: cwd, argv: args, home, interactive: process.stdin.isTTY === true }),
  agent: async (cwd, args, home) => agent(args, home, cwd),
  doctor: async (_cwd, args, home) => doctor(args, home),
});

export const publicRouteCommands = Object.freeze(Object.keys(routes));
