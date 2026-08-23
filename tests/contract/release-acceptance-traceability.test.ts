import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const matrixFile = "docs/acceptance/requirements-traceability.yaml";
const expectedTickets = ["04", "05", "06", "07", "08"] as const;
const externalTiers = new Set(["real-host", "real-platform"]);
const allowedStatuses = new Set(["passed", "not_run", "no-go"]);

type TraceabilityRow = {
  readonly id: string;
  readonly ticket: string;
  readonly checklist: string;
  readonly evidenceTier: string;
  readonly sources: readonly string[];
  readonly status: string;
  readonly blocker: string | null;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} 必须是对象`);
  assert.notEqual(value, null, `${label} 不能为 null`);
  assert.equal(Array.isArray(value), false, `${label} 不能是数组`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") assert.fail(`${label} 必须是非空字符串`);
  return value;
}

function asSources(value: unknown, label: string): readonly string[] {
  assert.ok(Array.isArray(value), `${label} 必须是数组`);
  assert.ok(value.length > 0, `${label} 不能为空`);
  return value.map((source, index) => asString(source, `${label}[${index}]`));
}

function traceabilityRows(document: unknown): readonly TraceabilityRow[] {
  const matrix = asRecord(document, "矩阵根节点");
  assert.equal(matrix.version, 1, "矩阵必须使用 v1 格式");
  assert.ok(Array.isArray(matrix.requirements), "矩阵必须包含 requirements 数组");

  return matrix.requirements.map((value, index) => {
    const row = asRecord(value, `requirements[${index}]`);
    const blocker = row.blocker;
    assert.ok(blocker === null || typeof blocker === "string", `requirements[${index}].blocker 必须是字符串或 null`);
    return {
      id: asString(row.id, `requirements[${index}].id`),
      ticket: asString(row.ticket, `requirements[${index}].ticket`),
      checklist: asString(row.checklist, `requirements[${index}].checklist`),
      evidenceTier: asString(row.evidenceTier, `requirements[${index}].evidenceTier`),
      sources: asSources(row.sources, `requirements[${index}].sources`),
      status: asString(row.status, `requirements[${index}].status`),
      blocker,
    };
  });
}

test("Tickets 04-08 的每项验收清单均映射到可定位的分层证据", async () => {
  const document = parse(await readFile(path.join(root, matrixFile), "utf8"));
  const rows = traceabilityRows(document);

  assert.equal(rows.length, 15, "五张 Ticket 各需要三条清单映射");
  assert.deepEqual(new Set(rows.map(({ id }) => id)).size, rows.length, "映射 ID 必须唯一");
  for (const ticket of expectedTickets) assert.equal(rows.filter((row) => row.ticket === ticket).length, 3, `Ticket ${ticket} 必须覆盖三条清单`);

  for (const row of rows) {
    assert.ok(expectedTickets.includes(row.ticket as (typeof expectedTickets)[number]), `${row.id} 引用了范围外 Ticket`);
    assert.ok(["local-automated", "real-host", "real-platform"].includes(row.evidenceTier), `${row.id} 使用了未知 Evidence Tier`);
    assert.ok(allowedStatuses.has(row.status), `${row.id} 使用了未知状态`);
    if (row.status === "passed") assert.equal(row.blocker, null, `${row.id} 的 passed 状态不能保留 blocker`);
    if (row.status !== "passed") assert.match(row.blocker ?? "", /\S/u, `${row.id} 的未通过状态必须说明 blocker`);
    await Promise.all(row.sources.map(async (source) => access(path.join(root, source))));
  }
});

test("真实宿主和真实平台证据不能由 fixture 或本地自动化替代", async () => {
  const document = parse(await readFile(path.join(root, matrixFile), "utf8"));
  const rows = traceabilityRows(document);

  for (const row of rows.filter(({ evidenceTier }) => externalTiers.has(evidenceTier))) {
    assert.notEqual(row.status, "passed", `${row.id} 缺少本次真实外部执行时必须保持未通过`);
    assert.ok(row.status === "not_run" || row.status === "no-go", `${row.id} 必须明确标为 not_run 或 no-go`);
    assert.ok(row.sources.every((source) => !source.startsWith("tests/")), `${row.id} 不能将测试 fixture 作为真实外部证据`);
  }
});

test("追溯矩阵确认 Foundation 仍只暴露五个 Application 生命周期操作", async () => {
  const document = parse(await readFile(path.join(root, matrixFile), "utf8"));
  const matrix = asRecord(document, "矩阵根节点");
  const boundary = asRecord(matrix.foundationBoundary, "foundationBoundary");

  assert.deepEqual(boundary.lifecycleOperations, ["start", "acquire", "submit", "decide", "inspect"]);
  assert.equal(boundary.artifactCreate, "attempt-scoped-helper-not-lifecycle-operation");
});
