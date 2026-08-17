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

test("调用表达式流入公开文案时在源码和构建产物中 fail closed", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/call-expression.ts",
      content: [
        'const message = compose("Unexpected call source message");',
        "completed(workItemId, status, message);",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/call-expression.js",
      content: [
        'const message = compose("Unexpected call built message");',
        "completed(workItemId, status, message);",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/call-expression.ts", line: 2, text: "无法安全解析公开文案：message" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/call-expression.js", line: 2, text: "无法安全解析公开文案：message" },
  ]);
});

test("二元与模板拼接在源码和构建产物中保守解析", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/concatenation.ts",
      content: [
        'const binaryMessage = "Unexpected binary source message" + "中文";',
        "completed(workItemId, status, binaryMessage);",
        'const templateMessage = `中文：${compose("Unexpected template source message")}`;',
        "completed(workItemId, status, templateMessage);",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/concatenation.js",
      content: [
        'const binaryMessage = "Unexpected binary built message" + "中文";',
        "completed(workItemId, status, binaryMessage);",
        'const templateMessage = `中文：${compose("Unexpected template built message")}`;',
        "completed(workItemId, status, templateMessage);",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/concatenation.ts", line: 1, text: "Unexpected binary source message" },
    { filename: "src/application/concatenation.ts", line: 4, text: "无法安全解析公开文案：templateMessage" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/concatenation.js", line: 1, text: "Unexpected binary built message" },
    { filename: "dist/application/concatenation.js", line: 4, text: "无法安全解析公开文案：templateMessage" },
  ]);
});

test("运行时数据边界不掩盖未知调用或本地 helper 中的英文文案", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/runtime-copy.ts",
      content: [
        "function authoredCopy() {",
        '  return "Unexpected authored helper source message";',
        "}",
        "function publish(input) {",
        "  completed(workItemId, status, `任务 ${input.workItemId} 完成。`);",
        "  completed(workItemId, status, String(input.detail));",
        "  completed(workItemId, status, compose(input.detail));",
        "  completed(workItemId, status, authoredCopy());",
        "}",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/runtime-copy.js",
      content: [
        "function authoredCopy() {",
        '  return "Unexpected authored helper built message";',
        "}",
        "function publish(input) {",
        "  completed(workItemId, status, `任务 ${input.workItemId} 完成。`);",
        "  completed(workItemId, status, String(input.detail));",
        "  completed(workItemId, status, compose(input.detail));",
        "  completed(workItemId, status, authoredCopy());",
        "}",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/runtime-copy.ts", line: 2, text: "Unexpected authored helper source message" },
    { filename: "src/application/runtime-copy.ts", line: 7, text: "无法安全解析公开文案：compose(input.detail)" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/runtime-copy.js", line: 2, text: "Unexpected authored helper built message" },
    { filename: "dist/application/runtime-copy.js", line: 7, text: "无法安全解析公开文案：compose(input.detail)" },
  ]);
});

test("运行时数据模型不会把本地结构化文案误标为 external", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/local-structure.ts",
      content: [
        'const local = { value: "Unexpected local collection source message" };',
        "completed(workItemId, status, Object.values(local)[0]);",
        "function localResult() {",
        '  return { value: "Unexpected local helper source message" };',
        "}",
        "completed(workItemId, status, localResult().value);",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/local-structure.js",
      content: [
        'const local = { value: "Unexpected local collection built message" };',
        "completed(workItemId, status, Object.values(local)[0]);",
        "function localResult() {",
        '  return { value: "Unexpected local helper built message" };',
        "}",
        "completed(workItemId, status, localResult().value);",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/local-structure.ts", line: 2, text: "无法安全解析公开文案：Object.values(local)[0]" },
    { filename: "src/application/local-structure.ts", line: 6, text: "无法安全解析公开文案：localResult().value" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/local-structure.js", line: 2, text: "无法安全解析公开文案：Object.values(local)[0]" },
    { filename: "dist/application/local-structure.js", line: 6, text: "无法安全解析公开文案：localResult().value" },
  ]);
});

test("结构化 summary 容器不是文案 sink，但内部字符串字段仍会检查", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/structured-summary.ts",
      content: [
        "function complete(input) {",
        '  return { action: "completed", summary: { workItemId: input.workItemId, status: "closed", message: "中文" } };',
        "}",
        "function submit() {",
        '  return { result: { summary: "Unexpected nested source summary" } };',
        "}",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/structured-summary.js",
      content: [
        "function complete(input) {",
        '  return { action: "completed", summary: { workItemId: input.workItemId, status: "closed", message: "中文" } };',
        "}",
        "function submit() {",
        '  return { result: { summary: "Unexpected nested built summary" } };',
        "}",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/structured-summary.ts", line: 5, text: "Unexpected nested source summary" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/structured-summary.js", line: 5, text: "Unexpected nested built summary" },
  ]);
});

test("Error sink 按构造器语义检查 message 参数而不检查 options", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/errors.ts",
      content: [
        'const nativeMessage = "Unexpected variable error source message";',
        "new Error(nativeMessage, { cause });",
        'const adapterMessage = "Unexpected adapter error source message";',
        'new CliAdapterError("WSSPEC_TEST", adapterMessage);',
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/errors.js",
      content: [
        'const nativeMessage = "Unexpected variable error built message";',
        "new Error(nativeMessage, { cause });",
        'const adapterMessage = "Unexpected adapter error built message";',
        'new CliAdapterError("WSSPEC_TEST", adapterMessage);',
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/errors.ts", line: 1, text: "Unexpected variable error source message" },
    { filename: "src/application/errors.ts", line: 3, text: "Unexpected adapter error source message" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/errors.js", line: 1, text: "Unexpected variable error built message" },
    { filename: "dist/application/errors.js", line: 3, text: "Unexpected adapter error built message" },
  ]);
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

test("公开文案保守合并 switch 分支和 fallthrough 赋值", async () => {
  const source = await validateChineseContent({
    files: [{
      filename: "src/application/switch.ts",
      content: [
        'let selected = "中文";',
        'let message = "中文";',
        "switch (kind) {",
        '  case "a":',
        '    selected = "Unexpected switch source message";',
        '  case "b":',
        "    message = selected;",
        "    break;",
        "  default:",
        '    message = "中文";',
        "}",
        "completed(workItemId, status, message);",
      ].join("\n"),
    }],
  });
  const build = await validateChineseContent({
    files: [{
      filename: "dist/application/switch.js",
      content: [
        'let selected = "中文";',
        'let message = "中文";',
        "switch (kind) {",
        '  case "a":',
        '    selected = "Unexpected switch built message";',
        '  case "b":',
        "    message = selected;",
        "    break;",
        "  default:",
        '    message = "中文";',
        "}",
        "completed(workItemId, status, message);",
      ].join("\n"),
    }],
  });

  assert.deepEqual(source, [
    { filename: "src/application/switch.ts", line: 5, text: "Unexpected switch source message" },
  ]);
  assert.deepEqual(build, [
    { filename: "dist/application/switch.js", line: 5, text: "Unexpected switch built message" },
  ]);
});

test("Error message 中无法证明安全的模板插值会 fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-chinese-template-"));
  await mkdir(path.join(root, "src", "cli"), { recursive: true });
  await writeFile(path.join(root, "src", "cli", "core.ts"), "throw new CliAdapterError(\"WSSPEC_TEST\", `执行失败：${String(rollbackError)}`);\n", "utf8");

  const findings = await validateChineseContent({ root });

  assert.deepEqual(findings, [{
    filename: "src/cli/core.ts",
    line: 1,
    text: "无法安全解析公开文案：`执行失败：${String(rollbackError)}`",
  }]);
});

test("构建产物中的未登记英文用户文案会阻断检查", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-chinese-build-"));
  await mkdir(path.join(root, "dist", "cli"), { recursive: true });
  await writeFile(path.join(root, "dist", "cli", "core.js"), 'throw new CliAdapterError("WSSPEC_TEST", "This built error is English.");\n', "utf8");
  await writeFile(path.join(root, "dist", "cli", "core.js.map"), '{"sourcesContent":["This source map is not user-facing copy."]}\n', "utf8");

  const findings = await validateChineseContent({ root, includeBuild: true });

  assert.deepEqual(findings, [{ filename: "dist/cli/core.js", line: 1, text: "This built error is English." }]);
});
