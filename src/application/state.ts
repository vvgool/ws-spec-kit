import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../domain/digests.js";
import { authenticateApplicationSourceAuthority, readControlPlane, type RuntimeProjection } from "../storage/control-plane.js";
import type { WorkItem } from "../storage/work-items.js";
import type { ApplicationSnapshot, SnapshotProfile } from "./snapshot.js";

export type { ApplicationSnapshot, SnapshotProfile, SnapshotStep } from "./snapshot.js";

export interface ApplicationState {
  projection: RuntimeProjection;
  worktree: string;
  itemRoot: string;
  item: WorkItem;
  snapshot: ApplicationSnapshot;
}

export class ApplicationStateError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ApplicationStateError";
  }
}

async function relativeFiles(root: string, directory = root): Promise<Array<{ path: string; digest: string }>> {
  const files: Array<{ path: string; digest: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const target = await stat(absolute);
    if (target.isDirectory()) files.push(...await relativeFiles(root, absolute));
    else if (target.isFile()) files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), digest: sha256(await readFile(absolute)) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifySnapshots(itemRoot: string, item: WorkItem, snapshot: ApplicationSnapshot): Promise<void> {
  const config = await readFile(path.join(itemRoot, "snapshot", "config.yaml"), "utf8");
  if (sha256(config) !== item.execution.configDigest) {
    throw new ApplicationStateError("WSSPEC_CONFIG_SNAPSHOT_CHANGED", "Project Config 快照已变化。 ");
  }
  const schemaRoot = path.join(itemRoot, "snapshot", "schemas");
  const schemaNames = (await readdir(schemaRoot)).filter((name) => name.endsWith(".schema.json")).sort();
  const schemaContents = await Promise.all(schemaNames.map(async (name) => `${name}\0${await readFile(path.join(schemaRoot, name), "utf8")}`));
  if (sha256(schemaContents.join("\0")) !== item.execution.schemaDigest) {
    throw new ApplicationStateError("WSSPEC_SCHEMA_SNAPSHOT_CHANGED", "Public Schema 快照已变化。 ");
  }
  const workflowFiles = await relativeFiles(path.join(itemRoot, "snapshot", "workflow"));
  if (JSON.stringify(workflowFiles) !== JSON.stringify(snapshot.workflowPackageLock.files)) {
    throw new ApplicationStateError("WSSPEC_WORKFLOW_SNAPSHOT_CHANGED", "Workflow Package 快照与 Lock 不一致。 ");
  }
  const [workflowLock, skillLock] = await Promise.all([
    readFile(path.join(itemRoot, "snapshot", "workflow.lock.json"), "utf8"),
    readFile(path.join(itemRoot, "snapshot", "skill.lock.json"), "utf8"),
  ]);
  if (JSON.stringify(JSON.parse(workflowLock)) !== JSON.stringify(snapshot.workflowPackageLock)) {
    throw new ApplicationStateError("WSSPEC_WORKFLOW_SNAPSHOT_CHANGED", "Workflow Lock 快照已变化。 ");
  }
  if (JSON.stringify(JSON.parse(skillLock)) !== JSON.stringify(snapshot.skillLock)) {
    throw new ApplicationStateError("WSSPEC_SKILL_SNAPSHOT_CHANGED", "Skill Lock 快照已变化。 ");
  }
  const verifiedSkills = new Set<string>();
  for (const lock of snapshot.skillLock.skills) {
    const selected = lock.selected;
    if (selected.source !== "builtin" && selected.source !== "project") continue;
    const id = selected.ref.split("/").at(-1)!;
    const skillRoot = path.join(itemRoot, "snapshot", "skills", selected.source, id);
    if (verifiedSkills.has(skillRoot)) continue;
    verifiedSkills.add(skillRoot);
    const files = await relativeFiles(skillRoot);
    const digest = sha256(`${JSON.stringify({ version: 1, files })}\n`);
    if (digest !== selected.digest) {
      throw new ApplicationStateError("WSSPEC_SKILL_SNAPSHOT_CHANGED", `Skill ${selected.ref} 快照与 Lock 不一致。 `);
    }
  }
}

export async function loadApplicationState(root: string, workItemId: string): Promise<ApplicationState> {
  const projection = await readControlPlane(root, workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree?: unknown };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryId?: unknown; repositoryRoot?: unknown };
  if (cache.repositoryId !== projection.repositoryId || typeof cache.repositoryRoot !== "string" || typeof locator.worktree !== "string") {
    throw new ApplicationStateError("WSSPEC_REPOSITORY_ID_MISMATCH", "Application locator 与仓库身份不一致。 ");
  }
  const worktree = path.join(cache.repositoryRoot, locator.worktree);
  const authority = await authenticateApplicationSourceAuthority({
    controlPlane: projection.controlPlane,
    worktree,
    workItemId,
    repositoryId: projection.repositoryId,
  });
  const { itemRoot, manifest: item } = authority;
  let snapshot: ApplicationSnapshot = authority.application;
  await verifySnapshots(itemRoot, item, snapshot);
  snapshot = {
    ...snapshot,
    selectedProfile: projection.profile.selected,
    changePolicy: snapshot.profiles[projection.profile.selected].changePolicy,
  };
  return { projection, worktree, itemRoot, item, snapshot };
}

export function selectedProfile(snapshot: ApplicationSnapshot): SnapshotProfile {
  return snapshot.profiles[snapshot.selectedProfile];
}
