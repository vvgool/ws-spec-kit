import assert from "node:assert/strict";
import test from "node:test";
import { artifactFilename, isArtifactFilename } from "../../src/domain/artifact-names.js";
import { createArtifactDocument } from "../../src/domain/artifacts.js";

const hash = `sha256:${"a".repeat(64)}`;
test("artifact labels are readable and review history identifies the round", () => {
  for (const [artifactType, label] of Object.entries({ "exploration-report": "02-现状分析", specification: "03-需求规格", design: "04-技术方案", plan: "05-实施计划", "implementation-result": "实现结果", "review-result": "第02轮-评审结果" })) {
    assert.equal(artifactFilename({ artifactType, stageId: "delivery:2:review", contentHash: hash }), `${label}-${"a".repeat(12)}.md`);
  }
});
test("producer attempts and output identities retain separate historical files", () => {
  const filenames = [ ["attempt-1", "output-a"], ["attempt-2", "output-a"], ["attempt-1", "output-b"] ].map(([attemptId, outputId]) => {
    const document = createArtifactDocument({ artifactType: "exploration-report", workItemId: "work-1", stageId: "explore", attemptId: attemptId!, outputId: outputId!, body: "# Same body\n" });
    return artifactFilename({ artifactType: "exploration-report", stageId: "explore", contentHash: document.reference.contentHash });
  });
  assert.equal(new Set(filenames).size, 3);
});
test("artifact writer names accept legacy hashes and exclude traversal, controls and special files", () => {
  assert.ok(isArtifactFilename(`${"a".repeat(64)}.md`));
  assert.ok(isArtifactFilename(artifactFilename({ artifactType: "../../evil\\file\0\n", stageId: "explore", contentHash: hash })));
  for (const value of ["../bad.md", "/bad.md", ".hidden-aaaaaaaaaaaa.md", "x/aaaaaaaaaaaa.md", "x\\aaaaaaaaaaaa.md", "x\0-aaaaaaaaaaaa.md", "x\n-aaaaaaaaaaaa.md", `${"字".repeat(100)}-aaaaaaaaaaaa.md`]) assert.equal(isArtifactFilename(value), false);
});
