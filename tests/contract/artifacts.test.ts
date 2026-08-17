import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import {
  ArtifactError,
  computeArtifactContentHash,
  verifyArtifact,
  type ArtifactExpectation,
  type ArtifactMetadata,
} from "../../src/domain/artifacts.js";

const requiredSections: Record<string, string[]> = {
  specification: ["目标与背景", "范围", "需求", "验收条件", "约束", "排除项", "开放问题"],
  design: ["上下文与架构", "组件职责和边界", "接口与数据契约", "安全与权限", "失败与恢复", "兼容或迁移", "测试策略", "已知权衡"],
  plan: ["有序交付任务", "任务依赖", "精确文件范围", "验证方式", "人工检查点", "回滚方式"],
  tasks: ["任务"],
  "implementation-result": ["实际改动", "修改文件", "计划偏差", "验证摘要", "未完成项", "残余风险"],
  "review-result": ["Findings"],
  "verification-result": ["Gate/Evidence 矩阵", "未通过项", "覆盖限制", "残余风险"],
  "knowledge-entry": ["背景", "需求或 Bug", "关键决策", "实现摘要", "验证证据", "适用范围", "限制", "相关引用"],
};

async function fixtureRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `wspec-artifact-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

function bodyFor(type: string, omitted?: string): string {
  return `${requiredSections[type]!
    .filter((section) => section !== omitted)
    .map((section) => {
      if (type === "tasks" && section === "任务") {
        return "## 任务\n\n```yaml\ntasks:\n  - id: task-1\n    dependencies: []\n    completion: 完成实现\n    status: pending\n```";
      }
      if (type === "review-result" && section === "Findings") {
        return "## Findings\n\n```yaml\nfindings:\n  - id: finding-1\n    severity: P2\n    description: 示例问题\n    evidence: 示例证据\n    path: src/example.ts\n    disposition: open\n```";
      }
      if (type === "verification-result" && section === "Gate/Evidence 矩阵") {
        return "## Gate/Evidence 矩阵\n\n```yaml\ngates:\n  - gateId: test\n    required: true\n    expectedLevel: trusted\n    evidenceId: evidence-1\n    workspaceTreeDigest: sha256:example\n    result: passed\n    occurredAt: 2026-08-16T10:00:00Z\n```";
      }
      return `## ${section}\n\n内容：${section}。`;
    })
    .join("\n\n")}\n`;
}

async function writeArtifact(
  root: string,
  type: string,
  options: { omitted?: string; extra?: Record<string, unknown>; bodySuffix?: string } = {},
): Promise<{ filename: string; expectation: ArtifactExpectation }> {
  const metadataWithoutHash = {
    artifactType: type,
    schemaVersion: 1,
    workItemId: "WSK-20260816-001",
    stageId: "define",
    attemptId: "attempt-1",
    revision: 1,
    ...options.extra,
  };
  const body = `${bodyFor(type, options.omitted)}${options.bodySuffix ?? ""}`;
  const metadata: ArtifactMetadata = {
    ...metadataWithoutHash,
    contentHash: computeArtifactContentHash(metadataWithoutHash, body),
  } as ArtifactMetadata;
  const filename = path.join(root, `${type}.md`);
  await writeFile(filename, `---\n${stringify(metadata, { lineWidth: 0 })}---\n${body}`, "utf8");
  return {
    filename,
    expectation: {
      repositoryRoot: root,
      artifactType: type,
      workItemId: "WSK-20260816-001",
      stageId: "define",
      attemptId: "attempt-1",
    },
  };
}

test("all built-in artifact types accept complete content contracts", async () => {
  const root = await fixtureRoot();
  for (const type of Object.keys(requiredSections)) {
    const { filename, expectation } = await writeArtifact(root, type);
    const reference = await verifyArtifact(filename, expectation);
    assert.equal(reference.artifactType, type);
    assert.equal(reference.path, `${type}.md`);
    assert.match(reference.contentHash, /^sha256:[0-9a-f]{64}$/);
  }
});

test("each built-in artifact rejects a missing required section", async () => {
  const root = await fixtureRoot();
  for (const [type, sections] of Object.entries(requiredSections)) {
    const { filename, expectation } = await writeArtifact(root, type, { omitted: sections[0]! });
    await assert.rejects(
      verifyArtifact(filename, expectation),
      (error: unknown) => error instanceof ArtifactError && error.code === "WSPEC_ARTIFACT_INCOMPLETE",
    );
  }
});

test("required sections cannot be empty", async () => {
  const root = await fixtureRoot();
  const type = "specification";
  const body = bodyFor(type).replace("## 范围\n\n内容：范围。", "## 范围\n\n");
  const metadataWithoutHash = {
    artifactType: type,
    schemaVersion: 1,
    workItemId: "WSK-20260816-001",
    stageId: "define",
    attemptId: "attempt-1",
    revision: 1,
  };
  const metadata = { ...metadataWithoutHash, contentHash: computeArtifactContentHash(metadataWithoutHash, body) };
  const filename = path.join(root, "empty-section.md");
  await writeFile(filename, `---\n${stringify(metadata)}---\n${body}`, "utf8");

  await assert.rejects(
    verifyArtifact(filename, {
      repositoryRoot: root,
      artifactType: type,
      workItemId: "WSK-20260816-001",
      stageId: "define",
      attemptId: "attempt-1",
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "WSPEC_ARTIFACT_INCOMPLETE",
  );
});

test("unknown front matter fields fail closed", async () => {
  const root = await fixtureRoot();
  const { filename, expectation } = await writeArtifact(root, "design", { extra: { approved: true } });
  await assert.rejects(
    verifyArtifact(filename, expectation),
    (error: unknown) => error instanceof ArtifactError && error.code === "WSPEC_ARTIFACT_SCHEMA_MISMATCH",
  );
});

test("review findings reject unknown severity values", async () => {
  const root = await fixtureRoot();
  const type = "review-result";
  const body = bodyFor(type).replace("severity: P2", "severity: P9");
  const metadataWithoutHash = {
    artifactType: type,
    schemaVersion: 1,
    workItemId: "WSK-20260816-001",
    stageId: "define",
    attemptId: "attempt-1",
    revision: 1,
  };
  const metadata = { ...metadataWithoutHash, contentHash: computeArtifactContentHash(metadataWithoutHash, body) };
  const filename = path.join(root, "invalid-review.md");
  await writeFile(filename, `---\n${stringify(metadata)}---\n${body}`, "utf8");

  await assert.rejects(
    verifyArtifact(filename, {
      repositoryRoot: root,
      artifactType: type,
      workItemId: "WSK-20260816-001",
      stageId: "define",
      attemptId: "attempt-1",
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "WSPEC_ARTIFACT_SCHEMA_MISMATCH",
  );
});

test("body tampering invalidates the declared content hash", async () => {
  const root = await fixtureRoot();
  const { filename, expectation } = await writeArtifact(root, "plan", { bodySuffix: "\n原始内容\n" });
  await writeFile(filename, `${await import("node:fs/promises").then(({ readFile }) => readFile(filename, "utf8"))}\n篡改\n`, "utf8");
  await assert.rejects(
    verifyArtifact(filename, expectation),
    (error: unknown) => error instanceof ArtifactError && error.code === "WSPEC_ARTIFACT_HASH_MISMATCH",
  );
});

test("producer identity mismatches are rejected", async () => {
  const root = await fixtureRoot();
  const { filename, expectation } = await writeArtifact(root, "specification");
  await assert.rejects(
    verifyArtifact(filename, { ...expectation, stageId: "other" }),
    (error: unknown) => error instanceof ArtifactError && error.code === "WSPEC_ARTIFACT_REFERENCE_INVALID",
  );
});

test("artifact paths cannot escape the repository", async () => {
  const root = await fixtureRoot();
  const outside = await fixtureRoot();
  const { filename } = await writeArtifact(outside, "design");
  await assert.rejects(
    verifyArtifact(filename, {
      repositoryRoot: root,
      artifactType: "design",
      workItemId: "WSK-20260816-001",
      stageId: "define",
      attemptId: "attempt-1",
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "WSPEC_ARTIFACT_REFERENCE_INVALID",
  );
});
