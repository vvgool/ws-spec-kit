import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadBuiltinCatalog } from "../../src/resources/catalog.js";

test("内置目录提供两个完整中文工作流及其 Skill", async () => {
  const catalog = await loadBuiltinCatalog();
  assert.deepEqual(catalog.workflows.map((item) => item.id).sort(), ["documentation-delivery", "feature-delivery"]);
  assert.ok(catalog.skills.length >= 9);
  const skillRefs = new Set(catalog.skills.map((skill) => `builtin://skills/${skill.id}`));
  for (const skill of catalog.skills) {
    assert.match(skill.description, /[\u4e00-\u9fff]/u);
    assert.match(await readFile(skill.entry, "utf8"), /[\u4e00-\u9fff]/u);
  }
  for (const workflow of catalog.workflows) {
    assert.deepEqual(workflow.profiles.map((profile) => profile.id).sort(), ["governed", "quick", "standard"]);
    for (const step of workflow.steps) for (const ref of step.skills) assert.ok(skillRefs.has(ref), `${ref} 未注册`);
  }
});

test("功能交付绑定可信 Red/Green Gate，文档交付保持纯文档边界", async () => {
  const catalog = await loadBuiltinCatalog();
  const feature = catalog.workflows.find((item) => item.id === "feature-delivery")!;
  assert.ok(feature.gates.some((gate) => gate.id === "verify-red" && gate.evidence === "trusted"));
  assert.ok(feature.gates.some((gate) => gate.id === "verify-green" && gate.evidence === "trusted"));
  const docs = catalog.workflows.find((item) => item.id === "documentation-delivery")!;
  assert.deepEqual(docs.steps.flatMap((step) => step.skills), [
    "builtin://skills/documentation-exploration",
    "builtin://skills/documentation-editing",
    "builtin://skills/documentation-review",
  ]);
  assert.equal(docs.changePolicy.kind, "documentation-only");
  assert.deepEqual(docs.gates.find((gate) => gate.id === "docs.integrity")?.command, ["wspec", "gate", "docs.integrity"]);
});

