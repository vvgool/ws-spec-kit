import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDocumentationIntegrity } from "../../src/engine/docs-integrity.js";

test("文档完整性 Gate 接受允许路径内的 UTF-8 正文", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-docs-"));
  await writeFile(path.join(root, "README.md"), "# 使用说明\n\n有效正文。\n");
  assert.deepEqual(await checkDocumentationIntegrity({ root, files: ["README.md"], allowedPaths: ["README.md", "docs/**"] }), { ok: true, problems: [] });
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
