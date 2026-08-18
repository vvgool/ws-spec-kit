import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installDriverSkill, type DriverAgent } from "../../adapters/skills/install.js";
import { CliAdapterError } from "../../adapters/cli/output.js";
import { runWorkflowCommand } from "../../adapters/cli/workflow.js";
import { createApplication } from "../../application/application.js";
import type { DecisionInput, StartInput, SubmitInput } from "../../protocol/application.js";
import type { SkillProvider } from "../../registry/skills/types.js";
import { initRepository } from "../../storage/repository.js";

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
  const args = parseArguments(argv, 0, ["--prompt", "--file", "--workflow", "--profile", "--actor", "--provider"]);
  const prompt = args.values["--prompt"];
  const file = args.values["--file"];
  if ((prompt === undefined) === (file === undefined)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "start 必须且只能提供 --prompt 或 --file。 ");
  const workflowRef = args.values["--workflow"];
  const profile = args.values["--profile"];
  if (profile !== undefined && !["auto", "quick", "standard", "governed"].includes(profile)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Profile 必须是 auto、quick、standard 或 governed。");
  const input: StartInput = {
    root,
    source: prompt === undefined ? { type: "file", path: file! } : { type: "prompt", text: prompt },
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
  const args = parseArguments(argv.slice(1), 1, ["--target"], ["--dry-run"]);
  const name = args.positional[0]!;
  if (!(["codex", "claude", "cursor", "generic"] as string[]).includes(name)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Agent 必须是 codex、claude、cursor 或 generic。");
  const target = args.values["--target"];
  return installDriverSkill({ agent: name as DriverAgent, home, ...(target === undefined ? {} : { target }), dryRun: args.flags.has("--dry-run") });
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
  submit,
  decide,
  inspect,
  workflow: (cwd, args, home) => runWorkflowCommand({ root: cwd, argv: args, home, interactive: process.stdin.isTTY === true }),
  agent: async (_cwd, args, home) => agent(args, home),
});

export const publicRouteCommands = Object.freeze(Object.keys(routes));
