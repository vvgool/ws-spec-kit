import { readFile } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../domain/digests.js";
import { authenticateApplicationSourceAuthority, readControlPlane, resolveWorkItemContext, type RuntimeProjection } from "../storage/control-plane.js";
import type { WorkItem } from "../storage/work-items.js";
import type { ApplicationSnapshot, SnapshotProfile } from "./snapshot.js";

export type { ApplicationSnapshot, SnapshotProfile, SnapshotStep } from "./snapshot.js";

export interface ApplicationState {
  projection: RuntimeProjection;
  worktree: string;
  authorityRoot: string;
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

async function verifySnapshots(itemRoot: string, item: WorkItem, snapshot: ApplicationSnapshot): Promise<void> {
  const config = await readFile(path.join(itemRoot, "snapshot", "config.yaml"), "utf8");
  if (sha256(config) !== item.execution.configDigest) {
    throw new ApplicationStateError("WSSPEC_CONFIG_SNAPSHOT_CHANGED", "Project Config 快照已变化。 ");
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
}

export async function loadApplicationState(root: string, workItemId: string): Promise<ApplicationState> {
  const projection = await readControlPlane(root, workItemId);
  const context = await resolveWorkItemContext(root, workItemId);
  if (context.repositoryId !== projection.repositoryId) {
    throw new ApplicationStateError("WSSPEC_REPOSITORY_ID_MISMATCH", "Application locator 与仓库身份不一致。 ");
  }
  const authority = await authenticateApplicationSourceAuthority({
    controlPlane: projection.controlPlane,
    worktree: context.executionWorktree,
    authorityRoot: context.authorityRoot,
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
  return { projection, worktree: context.executionWorktree, authorityRoot: context.authorityRoot, itemRoot, item, snapshot };
}

export function selectedProfile(snapshot: ApplicationSnapshot): SnapshotProfile {
  return snapshot.profiles[snapshot.selectedProfile];
}
