import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import type { ProfileDefinition, WorkflowDefinition } from "../workflow-package/types.js";
import { WorkflowPackageError } from "../workflow-package/types.js";
import { assertContainedPath } from "../workflow-package/path-boundary.js";
import { parseProfileV1, parseWorkflowV1 } from "../workflow-package/workflow-v1.js";
import { gitCommitManifest } from "../registry/connectors/git-commit.js";
import { loadIssueConnectorManifests } from "../registry/connectors/issue.js";
import { loadLarkConnectorManifest } from "../registry/connectors/feishu-document.js";
import type { ConnectorManifest } from "../registry/connectors/types.js";

export interface BuiltinSkill { id: string; version: string; description: string; entry: string }
export type BuiltinProfile = ProfileDefinition;
export interface BuiltinWorkflow extends WorkflowDefinition { profiles: BuiltinProfile[] }
export interface BuiltinCatalog { version: 1; skills: BuiltinSkill[]; workflows: BuiltinWorkflow[]; connectors: ConnectorManifest[] }

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

function parseCatalog(value: unknown): { version: 1; skills: Array<Omit<BuiltinSkill, "entry">>; workflows: string[]; connectors: string[] } {
  const source = record(value, "catalog.yaml", ["version", "skills", "workflows", "connectors"]);
  if (source.version !== 1) catalogError("只支持 Builtin Catalog v1。");
  if (!Array.isArray(source.skills)) catalogError("Catalog skills 必须是数组。");
  const skills = source.skills.map((value) => {
    const skill = record(value, "Catalog skill", ["id", "version", "description"]);
    return { id: string(skill.id, "Catalog skill.id"), version: string(skill.version, "Catalog skill.version"), description: string(skill.description, "Catalog skill.description") };
  });
  return {
    version: 1,
    skills,
    workflows: names(source.workflows, "Catalog workflows"),
    connectors: source.connectors === undefined ? [] : names(source.connectors, "Catalog connectors"),
  };
}

export async function loadBuiltinCatalog(root = builtinResourcesRoot()): Promise<BuiltinCatalog> {
  const resourcesRoot = path.resolve(root);
  const codes = { invalid: "WSSPEC_BUILTIN_RESOURCE_PATH_INVALID", escape: "WSSPEC_BUILTIN_RESOURCE_PATH_ESCAPE" } as const;
  const workflowsRoot = path.join(resourcesRoot, "workflows");
  const skillsRoot = path.join(resourcesRoot, "skills");
  const connectorsRoot = path.join(resourcesRoot, "connectors");
  await Promise.all([
    assertContainedPath(resourcesRoot, workflowsRoot, codes, "Builtin workflows root"),
    assertContainedPath(resourcesRoot, skillsRoot, codes, "Builtin skills root"),
  ]);
  const catalogFilename = path.join(resourcesRoot, "catalog.yaml");
  await assertContainedPath(resourcesRoot, catalogFilename, codes, "Builtin catalog.yaml");
  const source = parseCatalog(parse(await readFile(catalogFilename, "utf8")));
  const skills = await Promise.all(source.skills.map(async (skill) => {
    const entry = path.join(skillsRoot, skill.id, "SKILL.md");
    await assertContainedPath(resourcesRoot, entry, codes, `Builtin Skill ${skill.id}`);
    return { ...skill, entry };
  }));
  const workflows = await Promise.all(source.workflows.map(async (id) => {
    const directory = path.join(workflowsRoot, id);
    await assertContainedPath(resourcesRoot, directory, codes, `Builtin Workflow ${id}`);
    const workflowFilename = path.join(directory, "workflow.yaml");
    await assertContainedPath(resourcesRoot, workflowFilename, codes, `Builtin Workflow ${id} workflow.yaml`);
    const workflow = parseWorkflowV1(parse(await readFile(workflowFilename, "utf8")));
    if (workflow.workflow.id !== id) {
      throw new WorkflowPackageError("WSSPEC_BUILTIN_WORKFLOW_ID_MISMATCH", "Builtin Catalog 引用、目录与 Workflow id 必须一致。");
    }
    const profiles = await Promise.all(["quick", "standard", "governed"].map(async (profile) => {
      const profileFilename = path.join(directory, "profiles", `${profile}.yaml`);
      await assertContainedPath(resourcesRoot, profileFilename, codes, `Builtin Workflow ${id} Profile ${profile}`);
      const definition = parseProfileV1(parse(await readFile(profileFilename, "utf8")));
      if (definition.profile.id !== profile) {
        throw new WorkflowPackageError("WSSPEC_BUILTIN_PROFILE_ID_MISMATCH", "Builtin Profile 文件名与 Profile id 必须一致。");
      }
      if (definition.profile.workflow !== workflow.workflow.id) {
        throw new WorkflowPackageError("WSSPEC_BUILTIN_PROFILE_WORKFLOW_MISMATCH", "Builtin Profile 必须绑定当前 Workflow id。");
      }
      return definition;
    }));
    return { ...workflow, profiles };
  }));
  const connectorCandidates = source.connectors.length === 0
    ? []
    : [
        gitCommitManifest,
        ...await loadIssueConnectorManifests(connectorsRoot),
        await loadLarkConnectorManifest(connectorsRoot),
      ];
  const connectorsById = new Map(connectorCandidates.map((manifest) => [manifest.id, manifest]));
  const connectors = source.connectors.map((id) => {
    const manifest = connectorsById.get(id);
    if (manifest === undefined) catalogError(`Catalog Connector ${id} 不存在。`);
    return manifest;
  });
  if (new Set(source.connectors).size !== source.connectors.length || connectorsById.size !== connectors.length) {
    catalogError("Builtin Connector Catalog 必须精确注册全部受审计 Manifest。 ");
  }
  return { version: source.version, skills, workflows, connectors };
}
