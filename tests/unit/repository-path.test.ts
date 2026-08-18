import assert from "node:assert/strict";
import test from "node:test";

import { isRepositoryRelativePattern, matchesRepositoryPath } from "../../src/domain/repository-path.js";

test("共享 repository-relative matcher 保留有限 glob 语义", () => {
  const cases = [
    ["**", "README.md", true],
    ["**", "docs/guides/readme.md", true],
    ["docs/**/*.md", "docs/readme.md", true],
    ["docs/**/*.md", "docs/guides/readme.md", true],
    ["docs/*.md", "docs/guides/readme.md", false],
    ["src/*.?s", "src/index.ts", true],
    ["src/*.?s", "src/nested/index.ts", false],
    ["README?.md", "README1.md", true],
    ["README?.md", "README12.md", false],
  ] as const;
  for (const [pattern, candidate, expected] of cases) {
    assert.equal(matchesRepositoryPath(pattern, candidate), expected, `${pattern} -> ${candidate}`);
  }
});

test("共享 matcher 拒绝非仓库相对或无界输入", () => {
  for (const pattern of ["", "/docs/**", "../docs/**", "docs\\**", "docs//**", `docs/${"a".repeat(1025)}`]) {
    assert.equal(isRepositoryRelativePattern(pattern), false, pattern);
  }
  assert.equal(matchesRepositoryPath("docs/**", "../docs/readme.md"), false);
  assert.equal(matchesRepositoryPath("docs/**", "docs\\readme.md"), false);
});
