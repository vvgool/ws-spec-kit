import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import type { ProfileDefinition, WorkflowDefinition } from "../workflow-package/types.js";
import { WorkflowPackageError } from "../workflow-package/types.js";
import { assertContainedPath } from "../workflow-package/path-boundary.js";
import { parseProfileV1, parseWorkflowV1 } from "../workflow-package/workflow-v1.js";

export interface BuiltinSkill { id: string; version: string; description: string; entry: string }
export type BuiltinProfile = ProfileDefinition;
export interface BuiltinWorkflow extends WorkflowDefinition { profiles: BuiltinProfile[] }
export interface BuiltinCatalog { version: 1; skills: BuiltinSkill[]; workflows: BuiltinWorkflow[] }

export function builtinResourcesRoot(): string {
  return path.resolve(import.meta.dirname, "../../resources");
}

function catalogError(message: string): never {
  throw new WorkflowPackageError("WSSPEC_BUILTIN_CATALOG_INVALID", message);
}

function record(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) catalogError(`${label} 必须是对象。`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) catalogError(`${label} 包含不支持字段。`);
  return result;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") catalogError(`${label} 必须是非空字符串。`);
  return value;
}

function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item))) catalogError(`${label} 必须是逻辑名称数组。`);
  return [...value];
}

function parseCatalog(value: unknown): { version: 1; skills: Array<Omit<BuiltinSkill, "entry">>; workflows: string[] } {
  const source = record(value, "catalog.yaml", ["version", "skills", "workflows"]);
  if (source.version !== 1) catalogError("只支持 Builtin Catalog v1。");
  if (!Array.isArray(source.skills)) catalogError("Catalog skills 必须是数组。");
  const skills = source.skills.map((value) => {
    const skill = record(value, "Catalog skill", ["id", "version", "description"]);
    return { id: string(skill.id, "Catalog skill.id"), version: string(skill.version, "Catalog skill.version"), description: string(skill.description, "Catalog skill.description") };
  });
  return { version: 1, skills, workflows: names(source.workflows, "Catalog workflows") };
}

export async function loadBuiltinCatalog(root = builtinResourcesRoot()): Promise<BuiltinCatalog> {
  const resourcesRoot = path.resolve(root);
  const codes = { invalid: "WSSPEC_BUILTIN_RESOURCE_PATH_INVALID", escape: "WSSPEC_BUILTIN_RESOURCE_PATH_ESCAPE" } as const;
  const workflowsRoot = path.join(resourcesRoot, "workflows");
  const skillsRoot = path.join(resourcesRoot, "skills");
  await Promise.all([
    assertContainedPath(resourcesRoot, workflowsRoot, codes, "Builtin workflows root"),
    assertContainedPath(resourcesRoot, skillsRoot, codes, "Builtin skills root"),
  ]);
  const source = parseCatalog(parse(await readFile(path.join(resourcesRoot, "catalog.yaml"), "utf8")));
  const skills = await Promise.all(source.skills.map(async (skill) => {
    const entry = path.join(skillsRoot, skill.id, "SKILL.md");
    await assertContainedPath(skillsRoot, entry, codes, `Builtin Skill ${skill.id}`);
    return { ...skill, entry };
  }));
  const workflows = await Promise.all(source.workflows.map(async (id) => {
    const directory = path.join(workflowsRoot, id);
    await assertContainedPath(workflowsRoot, directory, codes, `Builtin Workflow ${id}`);
    const workflow = parseWorkflowV1(parse(await readFile(path.join(directory, "workflow.yaml"), "utf8")));
    const profiles = await Promise.all(["quick", "standard", "governed"].map(async (profile) => {
      const value = parse(await readFile(path.join(directory, "profiles", `${profile}.yaml`), "utf8"));
      return parseProfileV1(value);
    }));
    return { ...workflow, profiles };
  }));
  return { version: source.version, skills, workflows };
}
