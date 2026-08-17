import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

import { compileWorkflow } from "../../engine/compiler.js";
import { resolveSkill } from "../../registry/skills/resolver.js";
import { loadBuiltinCatalog } from "../../resources/catalog.js";
import { writeFileAtomic } from "../../storage/files.js";
import { loadRepository } from "../../storage/repository.js";
import { loadWorkflowPackage } from "../../workflow-package/loader.js";
import { evaluateWorkflowTrust } from "../../workflow-package/trust.js";
import type { WorkflowPackage, WorkflowStep } from "../../workflow-package/types.js";
import { CliAdapterError } from "./output.js";

export interface WorkflowCommandInput { root: string; argv: string[]; home?: string; interactive?: boolean; actor?: string }
export interface WorkflowListResult { workflows: Array<{ ref: string; id: string; description?: string }> }
export interface WorkflowPackageResult { workflow: { ref: string; id: string; digest: string; profiles: string[]; capabilities: string[] } }

function required(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined || value === "") throw new CliAdapterError("WSSPEC_ARGUMENT_REQUIRED", `缺少参数 ${name}。`);
  return value;
}

async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function allSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [step, ...allSteps(step.steps ?? [])]);
}

async function validatePackage(root: string, ref: string, home: string): Promise<WorkflowPackage> {
  const pkg = await loadWorkflowPackage({ root, ref });
  const bindings = new Map(allSteps(pkg.workflow.steps).flatMap((step) => (step.skills ?? []).map((binding) => [binding.ref, binding])));
  const skills = (await Promise.all([...bindings.values()].map((binding) => resolveSkill(binding, {
    provider: "generic",
    projectRoot: root,
    home,
    package: pkg,
    stepStatus: "not_started",
  })))).filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
  const defaultGate = pkg.workflow.workflow.id === "documentation-delivery" ? "docs.integrity" : "test";
  for (const id of ["quick", "standard", "governed"]) compileWorkflow(pkg, { id, skills }, { requiredGateIds: [defaultGate], configuredGateIds: [defaultGate] });
  return pkg;
}

function packageView(pkg: WorkflowPackage): WorkflowPackageResult {
  return {
    workflow: {
      ref: pkg.ref,
      id: pkg.workflow.workflow.id,
      digest: pkg.contentDigest,
      profiles: [...pkg.profiles.keys()].sort(),
      capabilities: [...new Set([...pkg.manifest.capabilities, ...pkg.manifest.externalSideEffects])].sort(),
    },
  };
}

async function ejectBuiltin(root: string, ref: string, target: string): Promise<{ target: string }> {
  if (!ref.startsWith("builtin://")) throw new CliAdapterError("WSSPEC_WORKFLOW_EJECT_SOURCE_INVALID", "只能 eject 内置 Workflow Package。");
  const pkg = await loadWorkflowPackage({ root, ref });
  const output = path.resolve(target);
  if (await exists(output)) throw new CliAdapterError("WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS", "Workflow Package 目标已存在，拒绝覆盖。");
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(output)}.wsspec-${crypto.randomUUID()}`);
  await mkdir(staging);
  try {
    for (const file of pkg.files) {
      const destination = path.join(staging, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(pkg.root, file.path), "utf8"), "utf8");
    }
    await rename(staging, output);
  } catch (error) {
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { target: output };
}

async function useWorkflow(input: WorkflowCommandInput, ref: string, profile: string | undefined): Promise<unknown> {
  const identity = await loadRepository(input.root);
  const pkg = await validatePackage(identity.repositoryRoot, ref, input.home ?? process.env.HOME ?? "");
  const trust = await evaluateWorkflowTrust({
    root: identity.repositoryRoot,
    pkg,
    ...(input.interactive === true ? { interactive: true as const, actor: input.actor ?? "cli", channel: "interactive" as const } : { interactive: false as const }),
  });
  if (trust.status !== "trusted") return trust.status === "approval_required"
    ? { status: "blocked", trust: trust.summary }
    : { status: "blocked", problems: [{ code: "WSSPEC_WORKFLOW_TRUST_REJECTED", message: "Workflow Package 已被拒绝。", retryable: false }] };
  const filename = path.join(identity.repositoryRoot, ".wsspec", "workflow.yaml");
  const current = parse(await readFile(filename, "utf8")) as Record<string, unknown>;
  const selectedProfile = profile ?? (typeof current.profile === "string" ? current.profile : "auto");
  if (!(["auto", "quick", "standard", "governed"] as string[]).includes(selectedProfile)) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "Profile 必须是 auto、quick、standard 或 governed。");
  await writeFileAtomic(filename, stringify({ version: 1, activeWorkflow: { ref, version: 1 }, profile: selectedProfile }, { lineWidth: 0 }));
  return { status: "selected", workflowRef: ref, profile: selectedProfile };
}

export async function runWorkflowCommand(input: WorkflowCommandInput): Promise<WorkflowListResult | WorkflowPackageResult | { valid: true; workflow: WorkflowPackageResult["workflow"] } | { target: string } | unknown> {
  const [command, ...args] = input.argv;
  if (command === "list") {
    const catalog = await loadBuiltinCatalog();
    return { workflows: catalog.workflows.map(({ workflow }) => ({ ref: `builtin://workflows/${workflow.id}`, id: workflow.id })).sort((left, right) => left.ref.localeCompare(right.ref)) };
  }
  if (command === "show") return packageView(await loadWorkflowPackage({ root: input.root, ref: required(args, 0, "workflowRef") }));
  if (command === "validate") {
    const pkg = await validatePackage(input.root, required(args, 0, "workflowRef"), input.home ?? process.env.HOME ?? "");
    return { valid: true, workflow: packageView(pkg).workflow };
  }
  if (command === "eject") return ejectBuiltin(input.root, required(args, 0, "workflowRef"), required(args, 1, "target"));
  if (command === "use") {
    const profileIndex = args.indexOf("--profile");
    const profile = profileIndex < 0 ? undefined : required(args, profileIndex + 1, "profile");
    return useWorkflow(input, required(args, 0, "workflowRef"), profile);
  }
  throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知 Workflow 命令：${command ?? ""}`);
}
