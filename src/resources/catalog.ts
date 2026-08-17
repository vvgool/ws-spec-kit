import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export interface BuiltinSkill { id: string; version: string; description: string; entry: string }
export interface BuiltinProfile { id: string }
export interface BuiltinWorkflow {
  id: string;
  steps: Array<{ id: string; skills: string[] }>;
  gates: Array<{ id: string; evidence: "trusted" | "attested"; command: string[] }>;
  changePolicy: { kind: "feature" | "documentation-only"; allowedPaths: string[] };
  profiles: BuiltinProfile[];
}
export interface BuiltinCatalog { version: 1; skills: BuiltinSkill[]; workflows: BuiltinWorkflow[] }

export function builtinResourcesRoot(): string {
  return path.resolve(import.meta.dirname, "../../resources");
}

export async function loadBuiltinCatalog(root = builtinResourcesRoot()): Promise<BuiltinCatalog> {
  const source = parse(await readFile(path.join(root, "catalog.yaml"), "utf8")) as {
    version: 1; skills: Array<Omit<BuiltinSkill, "entry">>; workflows: string[];
  };
  const skills = source.skills.map((skill) => ({ ...skill, entry: path.join(root, "skills", skill.id, "SKILL.md") }));
  const workflows = await Promise.all(source.workflows.map(async (id) => {
    const directory = path.join(root, "workflows", id);
    const workflow = parse(await readFile(path.join(directory, "workflow.yaml"), "utf8")) as Omit<BuiltinWorkflow, "profiles">;
    const profiles = await Promise.all(["quick", "standard", "governed"].map(async (profile) =>
      parse(await readFile(path.join(directory, "profiles", `${profile}.yaml`), "utf8")) as BuiltinProfile));
    return { ...workflow, profiles };
  }));
  return { version: source.version, skills, workflows };
}

