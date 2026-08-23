import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installDriverSkill, type DriverAgent } from "../../adapters/skills/install.js";
import { CliAdapterError } from "../../adapters/cli/output.js";
import { runWorkflowCommand } from "../../adapters/cli/workflow.js";
import { createApplication } from "../../application/application.js";
import { createApplicationArtifact } from "../../application/artifact.js";
import { doctorConnectors } from "../../application/doctor-connectors.js";
import type { ArtifactCreateInput, DecisionInput, StartInput, SubmitInput } from "../../protocol/application.js";
import type { SkillProvider } from "../../registry/skills/types.js";
import { initRepository } from "../../storage/repository.js";
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
    "--workflow", "--profile", "--actor", "--provider",
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
  const workflowRef = args.values["--workflow"];
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

async function agent(argv: string[], home: string): Promise<unknown> {
  if (argv[0] !== "install") throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知 Agent 命令：${argv[0] ?? ""}`);
  const usesClientOption = argv.includes("--client");
  const args = parseArguments(argv.slice(1), usesClientOption ? 0 : 1, ["--client", "--target"], ["--dry-run"]);
  const name = usesClientOption ? required(args.values["--client"], "--client") : args.positional[0]!;
  if (!(["codex", "claude", "cursor", "generic"] as string[]).includes(name)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Agent 必须是 codex、claude、cursor 或 generic。");
  const target = args.values["--target"];
  return installDriverSkill({ agent: name as DriverAgent, home, ...(target === undefined ? {} : { target }), dryRun: args.flags.has("--dry-run") });
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
  init: async (cwd, args) => { parseArguments(args, 0, []); return initRepository(cwd); },
  start,
  acquire,
  artifact,
  submit,
  decide,
  inspect,
  workflow: (cwd, args, home) => runWorkflowCommand({ root: cwd, argv: args, home, interactive: process.stdin.isTTY === true }),
  agent: async (_cwd, args, home) => agent(args, home),
  doctor: async (_cwd, args, home) => doctor(args, home),
});

export const publicRouteCommands = Object.freeze(Object.keys(routes));
