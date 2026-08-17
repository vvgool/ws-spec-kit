import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

import { compileWorkflow } from "../../engine/compiler.js";
import { resolveSkill } from "../../registry/skills/resolver.js";
import type { SkillProvider } from "../../registry/skills/types.js";
import { loadBuiltinCatalog } from "../../resources/catalog.js";
import { validate } from "../../schemas/index.js";
import { writeFileAtomic } from "../../storage/files.js";
import { loadRepository } from "../../storage/repository.js";
import { loadWorkflowPackage } from "../../workflow-package/loader.js";
import { evaluateWorkflowTrust } from "../../workflow-package/trust.js";
import type { WorkflowPackage, WorkflowStep } from "../../workflow-package/types.js";
import { CliAdapterError } from "./output.js";

export interface WorkflowCommandInput { root: string; argv: string[]; home?: string; provider?: SkillProvider; interactive?: boolean; actor?: string }
export interface WorkflowListResult { workflows: Array<{ ref: string; id: string }> }
export interface WorkflowPackageResult { workflow: { ref: string; id: string; digest: string; profiles: string[]; capabilities: string[] } }

function fail(message: string): never { throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", message); }
function provider(value: string | undefined): SkillProvider {
  if (value === undefined) return "generic";
  if ((["codex", "claude", "cursor", "generic"] as string[]).includes(value)) return value as SkillProvider;
  return fail("Provider 必须是 codex、claude、cursor 或 generic。");
}
function parseArgs(argv: string[], positions: number, options: readonly string[]): { positional: string[]; options: Record<string, string | true> } {
  const positional: string[] = []; const found: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    if (!options.includes(value) || found[value] !== undefined) fail(`不支持或重复参数 ${value}。`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) fail(`缺少参数 ${value} 的值。`);
    found[value] = next; index += 1;
  }
  if (positional.length !== positions) fail("命令包含多余或缺少的位置参数。");
  return { positional, options: found };
}
async function exists(filename: string): Promise<boolean> { try { await access(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function allSteps(steps: readonly WorkflowStep[]): WorkflowStep[] { return steps.flatMap((step) => [step, ...allSteps(step.steps ?? [])]); }

async function validatePackage(root: string, ref: string, home: string, selectedProvider: SkillProvider): Promise<WorkflowPackage> {
  const pkg = await loadWorkflowPackage({ root, ref });
  const bindings = new Map(allSteps(pkg.workflow.steps).flatMap((step) => (step.skills ?? []).map((binding) => [binding.ref, binding])));
  const skills = (await Promise.all([...bindings.values()].map((binding) => resolveSkill(binding, { provider: selectedProvider, projectRoot: root, home, package: pkg, stepStatus: "not_started" })))).filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
  const defaultGate = pkg.workflow.workflow.id === "documentation-delivery" ? "docs.integrity" : "test";
  for (const id of ["quick", "standard", "governed"]) compileWorkflow(pkg, { id, skills }, { requiredGateIds: [defaultGate], configuredGateIds: [defaultGate] });
  return pkg;
}
function packageView(pkg: WorkflowPackage): WorkflowPackageResult { return { workflow: { ref: pkg.ref, id: pkg.workflow.workflow.id, digest: pkg.contentDigest, profiles: [...pkg.profiles.keys()].sort(), capabilities: [...new Set([...pkg.manifest.capabilities, ...pkg.manifest.externalSideEffects])].sort() } }; }

async function ejectBuiltin(root: string, ref: string, target: string): Promise<{ target: string }> {
  if (!ref.startsWith("builtin://")) throw new CliAdapterError("WSSPEC_WORKFLOW_EJECT_SOURCE_INVALID", "只能 eject 内置 Workflow Package。");
  const pkg = await loadWorkflowPackage({ root, ref }); const output = path.resolve(target);
  if (await exists(output)) throw new CliAdapterError("WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS", "Workflow Package 目标已存在，拒绝覆盖。");
  const parent = path.dirname(output); await mkdir(parent, { recursive: true }); const staging = path.join(parent, `.${path.basename(output)}.wsspec-${crypto.randomUUID()}`); await mkdir(staging);
  try { for (const file of pkg.files) { const destination = path.join(staging, file.path); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, await readFile(path.join(pkg.root, file.path), "utf8"), "utf8"); } await rename(staging, output); }
  catch (error) { if (await exists(staging)) await rm(staging, { recursive: true, force: true }); throw error; }
  return { target: output };
}

async function useWorkflow(input: WorkflowCommandInput, ref: string, requestedProfile: string | undefined): Promise<unknown> {
  const identity = await loadRepository(input.root);
  const current = validate<{ profile?: unknown }>("builtin.workflow-selection.v1", parse(await readFile(path.join(identity.repositoryRoot, ".wsspec", "workflow.yaml"), "utf8")));
  const profile = requestedProfile ?? (typeof current.profile === "string" ? current.profile : "auto");
  if (!(["auto", "quick", "standard", "governed"] as string[]).includes(profile)) fail("Profile 必须是 auto、quick、standard 或 governed。");
  const pkg = await validatePackage(identity.repositoryRoot, ref, input.home ?? process.env.HOME ?? "", input.provider ?? "generic");
  const trust = await evaluateWorkflowTrust({ root: identity.repositoryRoot, pkg, ...(input.interactive === true ? { interactive: true as const, actor: input.actor ?? "cli", channel: "interactive" as const } : { interactive: false as const }) });
  if (trust.status !== "trusted") return trust.status === "approval_required" ? { status: "blocked", trust: trust.summary } : { status: "blocked", problems: [{ code: "WSSPEC_WORKFLOW_TRUST_REJECTED", message: "Workflow Package 已被拒绝。", retryable: false }] };
  await writeFileAtomic(path.join(identity.repositoryRoot, ".wsspec", "workflow.yaml"), stringify({ version: 1, activeWorkflow: { ref, version: 1 }, profile }, { lineWidth: 0 }));
  return { status: "selected", workflowRef: ref, profile };
}

export async function runWorkflowCommand(input: WorkflowCommandInput): Promise<unknown> {
  const [command, ...args] = input.argv;
  if (command === "list") { parseArgs(args, 0, []); const catalog = await loadBuiltinCatalog(); return { workflows: catalog.workflows.map(({ workflow }) => ({ ref: `builtin://workflows/${workflow.id}`, id: workflow.id })).sort((left, right) => left.ref.localeCompare(right.ref)) } satisfies WorkflowListResult; }
  if (command === "show") { const parsed = parseArgs(args, 1, []); return packageView(await loadWorkflowPackage({ root: input.root, ref: parsed.positional[0]! })); }
  if (command === "validate") { const parsed = parseArgs(args, 1, ["--provider"]); const pkg = await validatePackage(input.root, parsed.positional[0]!, input.home ?? process.env.HOME ?? "", provider(parsed.options["--provider"] as string | undefined ?? input.provider)); return { valid: true, workflow: packageView(pkg).workflow }; }
  if (command === "eject") { const parsed = parseArgs(args, 2, []); return ejectBuiltin(input.root, parsed.positional[0]!, parsed.positional[1]!); }
  if (command === "use") { const parsed = parseArgs(args, 1, ["--profile", "--provider"]); return useWorkflow({ ...input, provider: provider(parsed.options["--provider"] as string | undefined ?? input.provider) }, parsed.positional[0]!, parsed.options["--profile"] as string | undefined); }
  throw new CliAdapterError("WSSPEC_COMMAND_UNKNOWN", `未知 Workflow 命令：${command ?? ""}`);
}
