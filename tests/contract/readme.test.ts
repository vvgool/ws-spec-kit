import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const readmePath = path.join(root, "README.md");

test("root README exposes the documented stable anchors", async () => {
  const readme = await readFile(readmePath, "utf8");

  const chineseOverview = "中文概述";
  const englishIntroduction = "English introduction";
  assert.ok(readme.includes(chineseOverview));
  assert.ok(readme.includes(englishIntroduction));
  assert.ok(readme.indexOf(chineseOverview) < readme.indexOf(englishIntroduction));

  assert.match(readme, /WSSpecKit/u);
  assert.match(readme, /ws-spec-kit/u);
  assert.match(readme, /\bwspec\b/u);
  assert.match(readme, /docs\/reference\/application-protocol\.md/u);
  assert.match(readme, /docs\/reference\/workflow-language\.md/u);
  assert.match(readme, /Apache-2\.0/u);
  assert.match(readme, /LICENSE/u);
});
