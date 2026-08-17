import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadBuiltinCatalog } from "../../src/resources/catalog.js";

test("内置目录提供两个完整中文工作流及其 Skill", async () => {
  const catalog = await loadBuiltinCatalog();
  assert.deepEqual(catalog.workflows.map((item) => item.workflow.id).sort(), ["documentation-delivery", "feature-delivery"]);
  assert.ok(catalog.skills.length >= 9);
  const skillRefs = new Set(catalog.skills.map((skill) => `builtin://skills/${skill.id}`));
  for (const skill of catalog.skills) {
    assert.match(skill.description, /[\u4e00-\u9fff]/u);
    assert.match(await readFile(skill.entry, "utf8"), /[\u4e00-\u9fff]/u);
  }
  for (const workflow of catalog.workflows) {
    assert.equal(workflow.version, 1);
    assert.equal(workflow.workflow.version, 1);
    assert.deepEqual(workflow.profiles.map((profile) => profile.profile.id).sort(), ["governed", "quick", "standard"]);
    const visit = (steps: typeof workflow.steps): void => {
      for (const step of steps) {
        for (const binding of step.skills ?? []) assert.ok(skillRefs.has(binding.ref), `${binding.ref} 未注册`);
        visit(step.steps ?? []);
      }
    };
    visit(workflow.steps);
  }
});

test("功能交付绑定可信 Red/Green Gate，文档交付保持纯文档边界", async () => {
  const catalog = await loadBuiltinCatalog();
  const feature = catalog.workflows.find((item) => item.workflow.id === "feature-delivery")!;
  assert.deepEqual(feature.steps.map((step) => step.id), ["intake", "explore", "clarify", "design", "plan", "write-tests", "verify-red", "implement", "verify-green", "review-fix", "commit", "update-issue", "update-wiki", "close-issue", "close"]);
  assert.equal(feature.steps.find((step) => step.id === "review-fix")?.steps?.length, 3);
  assert.ok(feature.gates.some((gate) => gate.id === "verify-red" && gate.evidence === "trusted"));
  assert.ok(feature.gates.some((gate) => gate.id === "verify-green" && gate.evidence === "trusted"));
  const docs = catalog.workflows.find((item) => item.workflow.id === "documentation-delivery")!;
  assert.deepEqual(docs.steps.map((step) => step.id), ["intake", "explore", "clarify", "plan", "edit-document", "verify-document", "review-fix", "commit", "update-issue", "update-wiki", "close-issue", "close"]);
  assert.equal(docs.steps.find((step) => step.id === "review-fix")?.steps?.length, 3);
  assert.equal(docs.changePolicy.kind, "documentation-only");
  assert.deepEqual(docs.gates.find((gate) => gate.id === "docs.integrity")?.command, ["wspec", "gate", "docs.integrity"]);
});

test("六个内置 Profile 只使用正式 overlay 结构", async () => {
  const catalog = await loadBuiltinCatalog();
  for (const workflow of catalog.workflows) for (const profile of workflow.profiles) {
    assert.deepEqual(Object.keys(profile).sort(), ["audit", "profile", "publishing", "steps", "version"]);
    assert.equal(profile.profile.workflow, workflow.workflow.id);
    assert.ok(["standard", "complete"].includes(profile.audit.level));
  }
});
