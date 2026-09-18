import { lstat } from "node:fs/promises";
import path from "node:path";
import { computeWorkspaceTreeDigest } from "../domain/digests.js";
import { matchesRepositoryPath } from "../domain/repository-path.js";
import { checkDocumentationIntegrity } from "../engine/docs-integrity.js";
import { evidenceRecordHash, type GateEvidence } from "../engine/verification.js";
import { runGitRaw } from "../storage/git.js";
import type { ApplicationState } from "./state.js";

/** Validate the complete delivery diff, including fixes since the first verification. */
export async function documentationGate(state: ApplicationState, attemptId: string, verificationAttemptId = attemptId): Promise<{ evidence?: GateEvidence; summary: string }> {
  const before = await computeWorkspaceTreeDigest(state.worktree);
  const files = [...new Set([
    ...(await runGitRaw(state.worktree, ["diff", "--name-only", "--no-renames", "-z", state.item.execution.baselineRevision, "--"])).split("\0"),
    ...(await runGitRaw(state.worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
  ])].filter(file => file !== "" && !file.startsWith(`.wsspec/work-items/${state.item.workItemId}/`)).sort();
  const present: string[] = [];
  for (const file of files) {
    if (!state.snapshot.changePolicy.allowedPaths.some(pattern => matchesRepositoryPath(pattern, file))) {
      return { summary: `WSSPEC_DOCUMENTATION_SCOPE_VIOLATION: ${file} 不在文档允许范围内。` };
    }
    try {
      await lstat(path.join(state.worktree, file));
      present.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const checked = await checkDocumentationIntegrity({ root: state.worktree, files: present, allowedPaths: state.snapshot.changePolicy.allowedPaths });
  if (!checked.ok) return { summary: checked.problems.map(problem => `${problem.code}: ${problem.file}: ${problem.message}`).join("\n") };
  if (await computeWorkspaceTreeDigest(state.worktree) !== before) return { summary: "文档校验期间工作区发生变化，请重新校验。" };
  const unsigned = {
    evidenceId: `evidence-docs-${verificationAttemptId}`,
    level: "trusted" as const,
    gateId: "docs.integrity",
    codeRevision: (await runGitRaw(state.worktree, ["rev-parse", "HEAD"])).trim(),
    baselineTreeDigest: state.item.execution.baselineTreeDigest,
    workspaceTreeDigest: before,
    configDigest: state.item.execution.configDigest,
    attemptId,
    result: "passed" as const,
  };
  return { summary: "引擎已校验完整文档交付差异并记录可信 Evidence。", evidence: { ...unsigned, recordHash: evidenceRecordHash(unsigned) } };
}
