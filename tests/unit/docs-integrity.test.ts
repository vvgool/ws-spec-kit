import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDocumentationIntegrity } from "../../src/engine/docs-integrity.js";

test("文档完整性 Gate 接受允许路径内的 UTF-8 正文", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-docs-"));
  await writeFile(path.join(root, "README.md"), "# 使用说明\n\n有效正文。\n");
  assert.deepEqual(await checkDocumentationIntegrity({ root, files: ["README.md"], allowedPaths: ["README.md", "docs/**"] }), { ok: true, problems: [] });
});

test("文档完整性 Gate 按标准 glob 接受 docs 根目录和子目录 Markdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-docs-"));
  await mkdir(path.join(root, "docs", "guides"), { recursive: true });
  await writeFile(path.join(root, "docs", "local-guide.md"), "# Local Guide\n");
  await writeFile(path.join(root, "docs", "guides", "advanced.md"), "# Advanced\n");

  assert.deepEqual(await checkDocumentationIntegrity({
    root,
    files: ["docs/local-guide.md", "docs/guides/advanced.md"],
    allowedPaths: ["docs/**/*.md"],
  }), { ok: true, problems: [] });
});

test("文档完整性 Gate 拒绝空正文、冲突标记、非法 UTF-8 和越界路径", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-docs-"));
  await writeFile(path.join(root, "empty.md"), "  \n");
  await writeFile(path.join(root, "conflict.md"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n");
  await writeFile(path.join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(root, "source.ts"), "export {};\n");
  const result = await checkDocumentationIntegrity({ root, files: ["empty.md", "conflict.md", "invalid.md", "source.ts"], allowedPaths: ["*.md"] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((problem) => problem.code).sort(), [
    "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION", "WSSPEC_DOC_CONFLICT_MARKER", "WSSPEC_DOC_EMPTY", "WSSPEC_DOC_INVALID_UTF8",
  ]);
});

test("文档完整性 Gate 拒绝 symlink 和非普通文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-docs-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wsspec-docs-outside-"));
  await mkdir(path.join(root, "docs", "directory.md"), { recursive: true });
  await writeFile(path.join(outside, "outside.md"), "# Outside\n");
  await symlink(path.join(outside, "outside.md"), path.join(root, "docs", "escape.md"));

  const result = await checkDocumentationIntegrity({
    root,
    files: ["docs/escape.md", "docs/directory.md"],
    allowedPaths: ["docs/**/*.md"],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map(({ code, file }) => ({ code, file })), [
    { code: "WSSPEC_DOCUMENTATION_FILE_INVALID", file: "docs/escape.md" },
    { code: "WSSPEC_DOCUMENTATION_FILE_INVALID", file: "docs/directory.md" },
  ]);
});
