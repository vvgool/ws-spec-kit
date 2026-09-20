import { workItemPrefix } from "../domain/work-item-paths.js";
import { readTestingConfigMigration, testingConfigEvidenceKey, type TestingConfigMigration } from "../storage/testing-config-migration.js";
import * as canonicalizeModule from "canonicalize";
import { parse } from "yaml";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { computeWorkspaceSnapshot, sha256 } from "../domain/digests.js";
import { transitionStage } from "../domain/states.js";
import { fixedTestGateFromConfig } from "../engine/verification.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import { validate } from "../schemas/index.js";
import { loadApplicationState } from "./state.js";
import { VerificationError } from "../engine/tdd/types.js";

const canonicalize = canonicalizeModule.default as unknown as (value: unknown) => string;

interface TestingProjectConfig extends Record<string, unknown> {
  quality: { gates: { test?: { required: boolean; evidence: string } } };
}

export async function migrateTestingConfig(input: { root: string; workItemId: string; config: unknown; expectedDigest: string; actor: string }) {
  if (!input.actor.trim()) throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "迁移必须记录 actor。");
  validate("builtin.application-project-config.v1", input.config);
  fixedTestGateFromConfig(input.config);
  const configDigest = sha256(canonicalize(input.config));
  return mutateControlPlane({
    cwd: input.root, workItemId: input.workItemId, actor: input.actor,
    eventType: "projection.invalidated", idempotencyKey: `testing-config:${input.expectedDigest}:${configDigest}`,
    operationInput: { expectedDigest: input.expectedDigest, configDigest, actor: input.actor },
    mutate: async (projection) => {
      const state = await loadApplicationState(input.root, input.workItemId);
      const baseDigest = state.item.execution.configDigest;
      const previous = readTestingConfigMigration(projection.evidence[testingConfigEvidenceKey], baseDigest);
      if ((previous?.configDigest ?? baseDigest) !== input.expectedDigest) {
        throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "测试配置版本已变化，请 inspect 后重试。");
      }
      const original = parse(await readFile(path.join(state.itemRoot, "snapshot/config.yaml"), "utf8")) as TestingProjectConfig;
      const candidate = input.config as TestingProjectConfig;
      // Migration changes only testing ownership and the fixed test gate, not policy or other gates.
      const withoutTesting = (config: TestingProjectConfig) => {
        const copy = structuredClone(config);
        delete copy.testing;
        delete copy.quality.gates.test;
        return canonicalize(copy);
      };
      if (withoutTesting(original) !== withoutTesting(candidate)
        || JSON.stringify(candidate.quality.gates.test!.required) !== JSON.stringify(original.quality.gates.test!.required)
        || candidate.quality.gates.test!.evidence !== original.quality.gates.test!.evidence) {
        throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "迁移只能修改固定测试命令、报告器和测试路径，不能修改门禁策略。");
      }
      const profile = state.snapshot.profiles[projection.profile.selected];
      const index = profile.order.indexOf("write-tests");
      if (projection.workItem.status !== "active" || index < 0
        || Object.keys(projection.externalActions).length > 0
        || Object.keys(projection.evidence).some(key => key.startsWith("tdd:"))
        || Object.values(projection.approvals).some(approval => approval.status === "pending")
        || profile.order.slice(index + 1).some(id => projection.stages[id]?.status !== "pending")
        || !["pending", "ready", "claimed"].includes(projection.stages["write-tests"]?.status ?? "")) {
        throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "仅允许测试提交前迁移；已有审批、测试证据或外部动作时必须重新建项。");
      }
      const context = projection.contexts["write-tests"] as { result?: unknown } | undefined;
      if (context?.result !== undefined) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "测试步骤已有提交结果，不能迁移。");
      const claims = { ...projection.claims };
      const contexts = { ...projection.contexts };
      const stages = { ...projection.stages };
      const retries = { ...projection.retries };
      for (const claim of Object.values(claims)) {
        if (claim.stageId !== "write-tests" || claim.actor !== input.actor) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "其他步骤有活动 Claim，不能迁移。");
        const prefixes = [`${workItemPrefix(state.item)}/drafts/`, `.wsspec/work-items/${input.workItemId}/drafts/`];
        const baseline = claim.workspaceSnapshot.filter(entry => !prefixes.some(prefix => entry.path.startsWith(prefix)));
        const current = (await computeWorkspaceSnapshot(state.worktree)).filter(entry => !prefixes.some(prefix => entry.path.startsWith(prefix)));
        if (canonicalize(current) !== canonicalize(baseline)) throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "活动 Attempt 已修改工作区，不能迁移并重置基线。");
        delete claims[claim.stageId];
        delete contexts[claim.stageId];
        delete retries[claim.stageId];
        stages[claim.stageId] = transitionStage(stages[claim.stageId]!, { type: "transition", to: "ready" });
      }
      delete contexts["write-tests"];
      delete retries["write-tests"];
      const migration: TestingConfigMigration = { version: 1, baseDigest, configDigest, config: input.config };
      return {
        projection: { ...projection, claims, contexts, stages, retries, evidence: { ...projection.evidence, [testingConfigEvidenceKey]: migration } },
        value: { workItemId: input.workItemId, previousDigest: input.expectedDigest, configDigest, action: "inspect_then_acquire" },
      };
    },
  });
}
