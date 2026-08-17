import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import path from "node:path";

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

test("发布资源与当前中文用户内容目录通过真实仓库扫描", async () => {
  const findings = await validateChineseContent({ root: path.resolve(import.meta.dirname, "../..") });
  assert.deepEqual(findings, []);
});

test("真实 CLI 源码中的未登记英文用户文案会阻断检查", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-chinese-source-"));
  await mkdir(path.join(root, "src", "cli"), { recursive: true });
  await writeFile(path.join(root, "src", "cli", "core.ts"), 'throw new CliAdapterError("WSSPEC_TEST", "This public error is English.");\n', "utf8");

  const findings = await validateChineseContent({ root });

  assert.deepEqual(findings, [{ filename: "src/cli/core.ts", line: 1, text: "This public error is English." }]);
});

test("真实 CLI 帮助中的未登记英文文案会阻断检查", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-chinese-help-"));
  await mkdir(path.join(root, "src", "cli"), { recursive: true });
  await writeFile(path.join(root, "src", "cli", "main.ts"), 'const help = { usage: "This public help is English." };\n', "utf8");

  const findings = await validateChineseContent({ root });

  assert.deepEqual(findings, [{ filename: "src/cli/main.ts", line: 1, text: "This public help is English." }]);
});

test("Driver front matter 与正文中的未登记英文都会被阻断", async () => {
  const findings = await validateChineseContent({
    files: [{ filename: "src/adapters/skills/install.ts", content: 'function skill() { return "This Driver description is English."; }\n' }],
  });

  assert.deepEqual(findings, [{ filename: "src/adapters/skills/install.ts", line: 1, text: "This Driver description is English." }]);
});

test("公开完成结果的英文参数在源码和构建产物中都会被阻断", async () => {
  const source = await validateChineseContent({
    files: [{ filename: "src/application/acquire.ts", content: 'return completed(workItemId, "closed", "Unexpected terminal result");\n' }],
  });
  const build = await validateChineseContent({
    files: [{ filename: "dist/application/acquire.js", content: 'return completed(workItemId, "closed", "Unexpected built terminal result");\n' }],
  });

  assert.deepEqual(source, [{ filename: "src/application/acquire.ts", line: 1, text: "Unexpected terminal result" }]);
  assert.deepEqual(build, [{ filename: "dist/application/acquire.js", line: 1, text: "Unexpected built terminal result" }]);
});

test("源码用户文案中的模板插值属于运行时代码而非英文文案", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-chinese-template-"));
  await mkdir(path.join(root, "src", "cli"), { recursive: true });
  await writeFile(path.join(root, "src", "cli", "core.ts"), "throw new CliAdapterError(\"WSSPEC_TEST\", `执行失败：${String(rollbackError)}`);\n", "utf8");

  const findings = await validateChineseContent({ root });

  assert.deepEqual(findings, []);
});

test("构建产物中的未登记英文用户文案会阻断检查", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-chinese-build-"));
  await mkdir(path.join(root, "dist", "cli"), { recursive: true });
  await writeFile(path.join(root, "dist", "cli", "core.js"), 'throw new CliAdapterError("WSSPEC_TEST", "This built error is English.");\n', "utf8");
  await writeFile(path.join(root, "dist", "cli", "core.js.map"), '{"sourcesContent":["This source map is not user-facing copy."]}\n', "utf8");

  const findings = await validateChineseContent({ root, includeBuild: true });

  assert.deepEqual(findings, [{ filename: "dist/cli/core.js", line: 1, text: "This built error is English." }]);
});
