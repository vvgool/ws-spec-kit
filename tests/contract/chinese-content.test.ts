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

test("公开协议文案 sink 覆盖 description、引号属性和变量结果，且忽略协议标识", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/example.ts",
      content: [
        'const message = "Unexpected public result";',
        'const descriptor = { description: "Unexpected public description", "message": "Unexpected quoted message", ref: "builtin://skills/example", code: "WSSPEC_SAMPLE" };',
        'return completed(workItemId, "closed", message);',
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/example.js",
      content: 'const description = "Unexpected built description"; return { description, ref: "global://vendor/test" };\n',
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/example.ts", line: 1, text: "Unexpected public result" },
    { filename: "src/application/example.ts", line: 2, text: "Unexpected public description" },
    { filename: "src/application/example.ts", line: 2, text: "Unexpected quoted message" },
  ]);
  assert.deepEqual(build, [{ filename: "dist/application/example.js", line: 1, text: "Unexpected built description" }]);
});

test("公开文案标识符按函数和嵌套块的真实词法绑定解析", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/scoped.ts",
      content: [
        "function publicResult() {",
        '  const message = "Unexpected scoped source message";',
        "  return completed(workItemId, status, message);",
        "}",
        "function unrelated() {",
        '  const message = "中文消息";',
        "  return { message };",
        "}",
        "{",
        '  const description = "Unexpected nested source description";',
        "  consume({ description });",
        "}",
        "{",
        '  const description = "中文描述";',
        "  consume({ description });",
        "}",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/scoped.js",
      content: [
        "function publicResult() {",
        '  const description = "Unexpected scoped built description";',
        "  return { description };",
        "}",
        "function unrelated() {",
        '  const description = "中文描述";',
        "  return { description };",
        "}",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/scoped.ts", line: 2, text: "Unexpected scoped source message" },
    { filename: "src/application/scoped.ts", line: 10, text: "Unexpected nested source description" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/scoped.js", line: 2, text: "Unexpected scoped built description" },
  ]);
});

test("公开文案标识符跟踪声明后赋值和多段别名链", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/assigned.ts",
      content: [
        "let original;",
        'original = "Unexpected assigned source message";',
        "const alias = original;",
        "const message = alias;",
        "completed(workItemId, status, message);",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/assigned.js",
      content: [
        "let original;",
        'original = "Unexpected assigned built description";',
        "const alias = original;",
        "const description = alias;",
        "consume({ description });",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/assigned.ts", line: 2, text: "Unexpected assigned source message" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/assigned.js", line: 2, text: "Unexpected assigned built description" },
  ]);
});

test("公开文案别名循环或无绑定时 fail closed，但协议标识不误报", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/unresolved.ts",
      content: [
        "let first = second;",
        "let second = first;",
        "completed(workItemId, status, second);",
        "consume({ description: missingDescription });",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/unresolved.js",
      content: [
        "let first = second;",
        "let second = first;",
        "completed(workItemId, status, second);",
        "consume({ description: missingDescription });",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/unresolved.ts", line: 3, text: "无法安全解析公开文案：second" },
    { filename: "src/application/unresolved.ts", line: 4, text: "无法安全解析公开文案：missingDescription" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/unresolved.js", line: 3, text: "无法安全解析公开文案：second" },
    { filename: "dist/application/unresolved.js", line: 4, text: "无法安全解析公开文案：missingDescription" },
  ]);
});

test("公开文案保守合并循环中可能到达的赋值", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/loop.ts",
      content: [
        'let message = "中文消息";',
        "while (more) {",
        '  message = "Unexpected loop source message";',
        "}",
        "completed(workItemId, status, message);",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/loop.js",
      content: [
        'let description = "中文描述";',
        "while (more) {",
        '  description = "Unexpected loop built description";',
        "}",
        "consume({ description });",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/loop.ts", line: 3, text: "Unexpected loop source message" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/loop.js", line: 3, text: "Unexpected loop built description" },
  ]);
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
