import { computeWorkspaceTreeDigest, computeWorkspaceSnapshot } from "../domain/digests.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import { interruptedRetry } from "../engine/control/retry.js";
import { fixedTestGateForState, tddRedEvidenceKey } from "../engine/verification.js";
import { executeTrustedTestGate, fixedGateCommandIdentity, parseTrustedEvidence, testAssetScopeManifest, testFileManifest, isTrustedTestAssetPath, trustedTestAssetFiles } from "../engine/tdd/red-gate.js";
import { VerificationError } from "../engine/tdd/types.js";
import { loadApplicationState } from "./state.js";
import { implementationBaseline, workspaceSnapshotDigest } from "./implementation-baseline.js";
import { withRedBaseline } from "./red-baseline.js";

export async function revalidateRed(input: { root: string; workItemId: string; expectedEvidence: string; actor: string; reason: string }) {
  if (!input.actor.trim() || !input.reason.trim() || !input.expectedEvidence.trim()) throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "恢复必须提供原 Red Evidence、操作者和原因。");
  return mutateControlPlane({
    cwd: input.root, workItemId: input.workItemId, actor: input.actor,
    eventType: "evidence.recorded", idempotencyKey: `red-revalidation:${input.expectedEvidence}`,
    operationInput: { expectedEvidence: input.expectedEvidence, actor: input.actor, reason: input.reason },
    mutate: async projection => {
      const state = await loadApplicationState(input.root, input.workItemId);
      const key = tddRedEvidenceKey(input.workItemId);
      const old = parseTrustedEvidence(projection.evidence[key]);
      const profile = state.snapshot.profiles[projection.profile.selected];
      const index = profile.order.indexOf("implement");
      const stage = projection.stages.implement;
      if (old?.phase !== "red" || old.taskId !== input.workItemId || old.evidenceId !== input.expectedEvidence
        || projection.workItem.status !== "active" || index < 0 || !["ready", "claimed"].includes(stage?.status ?? "")
        || projection.stages["verify-red"]?.status !== "succeeded"
        || Object.keys(projection.externalActions).length > 0
        || Object.keys(projection.evidence).some(k => k.startsWith(`tdd:${input.workItemId}:`) && k !== key)
        || Object.values(projection.approvals).some(a => a.status === "pending")
        || Object.entries(projection.claims).some(([id, c]) => id !== "implement" || new Date(c.expiresAt).getTime() > Date.now())
        || profile.order.slice(index + 1).some(id => projection.stages[id]?.status !== "pending")) {
        throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "仅允许实现阶段、无活动租约或后续证据时重验当前 Red；请 inspect 后核对 Evidence ID。");
      }
      let baseline = await implementationBaseline(projection);
      if (baseline === undefined) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "缺少与当前 Red 绑定的原始实现基线，不能重验。");
      const gate = await fixedTestGateForState(state);
      if (JSON.stringify(gate.testAssetPaths) !== JSON.stringify(old.testAssetPaths)
        || JSON.stringify(gate.testAssetRoots) !== JSON.stringify(old.testAssetRoots)
        || JSON.stringify(gate.productPaths) !== JSON.stringify(old.productPaths)
        || JSON.stringify(gate.testPathRules) !== JSON.stringify(old.testPathRules)) {
        throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "测试资产配置已变化，不能用环境恢复修改测试范围。");
      }
      const tests = await testFileManifest(state.worktree, old.testPaths, old.testPathRules);
      const assets = await testAssetScopeManifest(state.worktree, gate);
      if (tests.digest !== old.testPathsDigest) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "原专项测试已变化，不能重验旧 Red。");
      const workspaceBefore = await computeWorkspaceTreeDigest(state.worktree);
      const changedAssets = assets.digest !== old.testAssetsDigest;
      if (changedAssets) {
        // Replace only trusted test assets. Product/configuration bytes stay bound
        // to the engine-recorded pre-implementation snapshot.
        const current = await computeWorkspaceSnapshot(state.worktree);
        const snapshot = [
          ...baseline.workspaceSnapshot.filter(entry => !isTrustedTestAssetPath(entry.path, gate)),
          ...current.filter(entry => isTrustedTestAssetPath(entry.path, gate)),
        ].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
        for (const asset of trustedTestAssetFiles(assets.files, gate)) {
          if (!snapshot.some(entry => entry.path === asset.path && entry.type === "file" && entry.digest === asset.digest)) {
            throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", `测试资产无法纳入隔离基线：${asset.path}`);
          }
        }
        baseline = { ...baseline, workspaceSnapshot: snapshot, inputWorkspaceTreeDigest: workspaceSnapshotDigest(snapshot) };
      }
      const unchangedTests = async () => {
        const currentTests = await testFileManifest(state.worktree, old.testPaths, old.testPathRules);
        const currentAssets = await testAssetScopeManifest(state.worktree, gate);
        if (currentTests.digest !== tests.digest || currentAssets.digest !== assets.digest) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "重验期间测试或辅助资产已变化。");
      };
      const identity = await fixedGateCommandIdentity(gate, state.worktree);
      const baselineDigest = baseline.inputWorkspaceTreeDigest;
      const evidence = await withRedBaseline({ worktree: state.worktree, revision: state.item.execution.baselineRevision, snapshot: baseline.workspaceSnapshot, digest: baselineDigest }, async (directory, dependencyRelocations) => {
        const result = await executeTrustedTestGate({ taskId: input.workItemId, phase: "red", stepId: "verify-red", gate,
          worktree: directory, bindingRoot: state.worktree, dependencyRelocations, workspaceDigest: baselineDigest, testPaths: old.testPaths,
          expectedCommandDigest: identity.commandDigest });
        if (result.testPathsDigest !== tests.digest || result.testAssetsDigest !== assets.digest
          || old.failedTests.some(name => !result.failedTests.includes(name))
          || (!changedAssets && JSON.stringify([...result.failedTests].sort()) !== JSON.stringify([...old.failedTests].sort()))) {
          throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "隔离基线未复现当前测试资产与原有断言失败，不能替换 Red。");
        }
        return result;
      });
      await unchangedTests();
      if (await computeWorkspaceTreeDigest(state.worktree) !== workspaceBefore
        || (await fixedGateCommandIdentity(gate, state.worktree)).commandDigest !== identity.commandDigest) {
        throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "重验期间实现工作区或执行环境发生变化。");
      }
      const claims = { ...projection.claims };
      const contexts = { ...projection.contexts };
      const retries = { ...projection.retries };
      if (claims.implement !== undefined) {
        if (retries.implement !== undefined) retries.implement = interruptedRetry(retries.implement);
        delete claims.implement;
        delete contexts.implement;
      }
      return {
        projection: { ...projection, claims, contexts, retries, stages: { ...projection.stages, implement: { status: "ready" as const } }, evidence: {
          ...projection.evidence, [key]: evidence,
          [`testing.red-revalidation:${old.evidenceId}`]: { actor: input.actor, reason: input.reason, previous: old, replacement: evidence },
          "testing.red-revalidation": { redEvidenceId: evidence.evidenceId, baseline },
        } },
        value: { workItemId: input.workItemId, previousEvidenceId: old.evidenceId, redEvidenceId: evidence.evidenceId, action: "inspect_then_acquire" },
      };
    },
  });
}
