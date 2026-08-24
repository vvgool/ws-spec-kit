import assert from "node:assert/strict";
import test from "node:test";

import { aggregateEvidenceTiers } from "../../scripts/check-release-baseline.mjs";
import { renderReleaseReport } from "../../scripts/render-release-report.mjs";

test("发布聚合仅在每个必需 Evidence Tier 的所有行均 passed 时给出 GO", () => {
  // Given: 所有本地、真实宿主和真实平台必需行都已有通过证据
  const rows = [
    { evidenceTier: "local-automated", status: "passed" },
    { evidenceTier: "real-host", status: "passed" },
    { evidenceTier: "real-platform", status: "passed" },
  ] as const;

  // When: 汇总发布证据
  const result = aggregateEvidenceTiers(rows);

  // Then: 只有所有层均通过才允许 GO
  assert.deepEqual(result, {
    localAutomated: "passed",
    realHost: "passed",
    realPlatform: "passed",
    overall: "go",
  });
});

for (const status of ["not_run", "no-go"] as const) {
  test(`发布聚合在真实宿主必需行是 ${status} 时保持 NO-GO`, () => {
    // Given: 本地与真实平台通过，但真实宿主尚未满足发布级证据
    const rows = [
      { evidenceTier: "local-automated", status: "passed" },
      { evidenceTier: "real-host", status },
      { evidenceTier: "real-platform", status: "passed" },
    ] as const;

    // When: 汇总发布证据
    const result = aggregateEvidenceTiers(rows);

    // Then: 未运行或明确 NO-GO 都不能被聚合器升级为 GO
    assert.equal(result.realHost, "no-go");
    assert.equal(result.overall, "no-go");
  });
}

test("发布聚合在必需 Evidence Tier 缺行时保持 NO-GO", () => {
  // Given: 追溯矩阵遗漏了真实平台必需行
  const rows = [
    { evidenceTier: "local-automated", status: "passed" },
    { evidenceTier: "real-host", status: "passed" },
  ] as const;

  // When: 汇总发布证据
  const result = aggregateEvidenceTiers(rows);

  // Then: 缺失层被视为未通过，而不是被忽略
  assert.equal(result.realPlatform, "no-go");
  assert.equal(result.overall, "no-go");
});

test("最终中文发布报告将本地通过与真实宿主和平台 NO-GO 分开呈现", () => {
  // Given: 一个本地通过但外部必需层尚未通过的权威追溯矩阵
  const matrix = {
    version: 1,
    baselineCommit: "8b15381",
    overallStatus: "no-go",
    foundationBoundary: {
      lifecycleOperations: ["start", "acquire", "submit", "decide", "inspect"],
      artifactCreate: "attempt-scoped-helper-not-lifecycle-operation",
    },
    requirements: [
      { id: "T08-01", ticket: "08", evidenceTier: "local-automated", status: "passed", sources: ["tests/e2e/package-install.test.ts"] },
      { id: "T06-01", ticket: "06", evidenceTier: "real-host", status: "no-go", sources: ["docs/acceptance/agent-live-matrix.yaml"] },
      { id: "T07-01", ticket: "07", evidenceTier: "real-platform", status: "no-go", sources: ["docs/acceptance/connector-live-matrix.yaml"] },
    ],
  };

  // When: 渲染最终发布报告
  const report = renderReleaseReport(matrix);

  // Then: 报告不能把本地通过表述成发布 GO
  assert.match(report, /本地 RC 门禁：通过/u);
  assert.match(report, /首版总体发布结论：BLOCKED-NO-GO/u);
  assert.match(report, /真实 Agent 宿主验收/u);
  assert.match(report, /真实 Connector 平台验收/u);
  assert.match(report, /reconciliation_required/u);
  assert.match(report, /receiptCount 为 0/u);
});
