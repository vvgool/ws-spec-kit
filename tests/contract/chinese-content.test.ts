import assert from "node:assert/strict";
import test from "node:test";

import { validateChineseContent } from "../../src/resources/chinese-content.js";

test("中文内容检查器报告未登记英文的文件、行号和文本，并忽略代码、路径与 URL", async () => {
  const findings = await validateChineseContent({
    files: [{
      filename: "resources/skills/fixture/SKILL.md",
      content: "# \u4e2d\u6587\n\nThis prose is not allowed.\n\n`npm test` https://example.com/path\n\n```text\nEnglish code is ignored\n```\n",
    }],
  });
  assert.deepEqual(findings, [{ filename: "resources/skills/fixture/SKILL.md", line: 3, text: "This prose is not allowed." }]);
});
