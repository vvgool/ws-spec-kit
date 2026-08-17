import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installDriverSkill, type DriverAgent } from "../../adapters/skills/install.js";
import { CliAdapterError } from "../../adapters/cli/output.js";
import { runWorkflowCommand } from "../../adapters/cli/workflow.js";
import { createApplication } from "../../application/application.js";
import type { DecisionInput, StartInput, SubmitInput } from "../../protocol/application.js";
import { initRepository } from "../../storage/repository.js";

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new CliAdapterError("WSSPEC_ARGUMENT_REQUIRED", `缺少参数 ${name}。`);
  return value;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : required(argv[index + 1], name);
}

function noUnknownOptions(argv: string[], allowed: readonly string[]): void {
  for (const value of argv) if (value.startsWith("--") && !allowed.includes(value)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", `不支持参数 ${value}。`);
}

function positional(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index]!.startsWith("--")) { index += 1; continue; }
    values.push(argv[index]!);
  }
  return values;
}

function application(home: string, actor: string | undefined) {
  return createApplication({ home, terminal: process.stdin, workflowTrust: { interactive: process.stdin.isTTY === true, actor: actor ?? "cli" } });
}

async function start(root: string, argv: string[], home: string): Promise<unknown> {
  noUnknownOptions(argv, ["--prompt", "--file", "--workflow", "--profile", "--actor"]);
  const prompt = option(argv, "--prompt");
  const file = option(argv, "--file");
  if ((prompt === undefined) === (file === undefined)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "start 必须且只能提供 --prompt 或 --file。 ");
  const workflowRef = option(argv, "--workflow");
  const profile = option(argv, "--profile");
  if (profile !== undefined && !["auto", "quick", "standard", "governed"].includes(profile)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Profile 必须是 auto、quick、standard 或 governed。");
  const input: StartInput = {
    root,
    source: prompt === undefined ? { type: "file", path: file! } : { type: "prompt", text: prompt },
    ...(workflowRef === undefined ? {} : { workflowRef }),
    ...(profile === undefined ? {} : { profile: profile as NonNullable<StartInput["profile"]> }),
  };
  return application(home, option(argv, "--actor")).start(input);
}

async function acquire(root: string, argv: string[], home: string): Promise<unknown> {
  noUnknownOptions(argv, ["--actor"]);
  return application(home, option(argv, "--actor")).acquire({ root, workItemId: required(positional(argv)[0], "workItemId") as `WSS-${string}`, actor: required(option(argv, "--actor"), "--actor") });
}

async function submit(root: string, argv: string[], home: string): Promise<unknown> {
  noUnknownOptions(argv, ["--step", "--attempt", "--lease", "--result", "--actor"]);
  const resultPath = required(option(argv, "--result"), "--result");
  const result = JSON.parse(await readFile(path.resolve(root, resultPath), "utf8")) as SubmitInput["result"];
  return application(home, option(argv, "--actor")).submit({
    root,
    workItemId: required(positional(argv)[0], "workItemId") as `WSS-${string}`,
    stepId: required(option(argv, "--step"), "--step"),
    attemptId: required(option(argv, "--attempt"), "--attempt"),
    leaseToken: required(option(argv, "--lease"), "--lease"),
    result,
  });
}

async function decide(root: string, argv: string[], home: string): Promise<unknown> {
  noUnknownOptions(argv, ["--input", "--actor"]);
  const input = JSON.parse(await readFile(path.resolve(root, required(option(argv, "--input"), "--input")), "utf8")) as Omit<DecisionInput, "root" | "actor">;
  return application(home, option(argv, "--actor")).decide({ ...input, root, actor: required(option(argv, "--actor"), "--actor") } as DecisionInput);
}

async function inspect(root: string, argv: string[], home: string): Promise<unknown> {
  noUnknownOptions(argv, []);
  return application(home, undefined).inspect({ root, workItemId: required(positional(argv)[0], "workItemId") as `WSS-${string}` });
}

async function agent(argv: string[], home: string): Promise<unknown> {
  if (argv[0] !== "install") throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知 Agent 命令：${argv[0] ?? ""}`);
  noUnknownOptions(argv, ["--target", "--dry-run"]);
  const name = required(argv[1], "agent");
  if (!(["codex", "claude", "cursor", "generic"] as string[]).includes(name)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Agent 必须是 codex、claude、cursor 或 generic。");
  const target = option(argv, "--target");
  return installDriverSkill({ agent: name as DriverAgent, home, ...(target === undefined ? {} : { target }), dryRun: argv.includes("--dry-run") });
}

export async function runCommand(cwd: string, argv: string[]): Promise<unknown> {
  const [command, ...args] = argv;
  const home = process.env.HOME ?? os.homedir();
  if (command === "init") { noUnknownOptions(args, []); return initRepository(cwd); }
  if (command === "start") return start(cwd, args, home);
  if (command === "acquire") return acquire(cwd, args, home);
  if (command === "submit") return submit(cwd, args, home);
  if (command === "decide") return decide(cwd, args, home);
  if (command === "inspect") return inspect(cwd, args, home);
  if (command === "workflow") {
    const actor = option(args, "--actor");
    return runWorkflowCommand({ root: cwd, argv: args, home, interactive: process.stdin.isTTY === true, ...(actor === undefined ? {} : { actor }) });
  }
  if (command === "agent") return agent(args, home);
  throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知命令：${command ?? ""}`);
}
