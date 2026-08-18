import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const designFile = "docs/superpowers/specs/2026-08-17-wsspeckit-workflow-design.md";
const plans: Record<string, string> = {
  Foundation: "docs/superpowers/plans/2026-08-17-wsspeckit-foundation.md",
  Control: "docs/superpowers/plans/2026-08-17-wsspeckit-control-runtime.md",
  Connector: "docs/superpowers/plans/2026-08-17-wsspeckit-connectors.md",
  Release: "docs/superpowers/plans/2026-08-17-wsspeckit-release-acceptance.md",
};

function traceabilityRows(design: string): string[][] {
  const section = /^## 20\. 需求追踪矩阵\n([\s\S]*?)^## /mu.exec(design)?.[1];
  assert.notEqual(section, undefined, "设计规格缺少需求追踪矩阵");
  return section!.split("\n")
    .filter((line) => /^\| `REQ-\d{2}` \|/u.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

test("REQ-01 至 REQ-20 连续、唯一，并具备设计落点、实施 Task 与验收证据", async () => {
  const rows = traceabilityRows(await readFile(path.join(root, designFile), "utf8"));
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map((row) => row[0]), Array.from({ length: 20 }, (_, index) => `\`REQ-${String(index + 1).padStart(2, "0")}\``));
  for (const row of rows) {
    assert.equal(row.length, 5);
    for (const cell of row.slice(2)) assert.notEqual(cell, "", `${row[0]} 缺少追踪字段`);
  }
});

test("需求矩阵引用的实施 Task 在对应计划中有真实标题", async () => {
  const documents = Object.fromEntries(await Promise.all(Object.entries(plans).map(async ([phase, filename]) => [phase, await readFile(path.join(root, filename), "utf8")]))) as Record<string, string>;
  const rows = traceabilityRows(await readFile(path.join(root, designFile), "utf8"));
  for (const row of rows) {
    const implementation = row[3]!;
    const references = [...implementation.matchAll(/(Foundation|Control|Connector|Release) Task (\d+)(?:-(\d+))?/gu)];
    assert.ok(references.length > 0, `${row[0]} 没有可解析的实施 Task`);
    for (const match of references) {
      const phase = match[1]!;
      const first = Number(match[2]);
      const last = Number(match[3] ?? match[2]);
      for (let task = first; task <= last; task += 1) assert.match(documents[phase]!, new RegExp(`^### Task ${task}：`, "mu"), `${row[0]} 引用了不存在的 ${phase} Task ${task}`);
    }
  }
});
