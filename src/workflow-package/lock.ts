import { sha256 } from "../domain/digests.js";
import type { WorkflowPackage, WorkflowPackageLock } from "./types.js";

export function lockWorkflowPackage(pkg: WorkflowPackage): WorkflowPackageLock {
  const files = [...pkg.files].sort((left, right) => left.path.localeCompare(right.path));
  const packageSkills = [...pkg.packageSkills.entries()]
    .map(([ref, skill]) => ({ ref, digest: skill.digest }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  return { version: 1, contentDigest: pkg.contentDigest, files, packageSkills };
}

export function workflowPackageContentDigest(files: Array<{ path: string; digest: string }>): string {
  return sha256(`${JSON.stringify({ version: 1, files: [...files].sort((left, right) => left.path.localeCompare(right.path)) })}\n`);
}
