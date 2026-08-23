import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const traceabilityFile = "docs/acceptance/requirements-traceability.yaml";

const requiredTiers = ["local-automated", "real-host", "real-platform"];
const allowedStatuses = ["passed", "not_run", "no-go"];
const execute = promisify(execFile);

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function statusForTier(rows, tier) {
  const tierRows = rows.filter((row) => row.evidenceTier === tier);
  return tierRows.length > 0 && tierRows.every((row) => row.status === "passed") ? "passed" : "no-go";
}

export function aggregateEvidenceTiers(rows) {
  const localAutomated = statusForTier(rows, "local-automated");
  const realHost = statusForTier(rows, "real-host");
  const realPlatform = statusForTier(rows, "real-platform");
  return {
    localAutomated,
    realHost,
    realPlatform,
    overall: localAutomated === "passed" && realHost === "passed" && realPlatform === "passed" ? "go" : "no-go",
  };
}

export function parseTraceability(document) {
  const matrix = record(document, "追溯矩阵");
  if (matrix.version !== 1) throw new Error("追溯矩阵必须使用 v1 格式");
  const boundary = record(matrix.foundationBoundary, "foundationBoundary");
  if (JSON.stringify(boundary.lifecycleOperations) !== JSON.stringify(["start", "acquire", "submit", "decide", "inspect"])
    || boundary.artifactCreate !== "attempt-scoped-helper-not-lifecycle-operation") {
    throw new Error("Foundation Application Protocol 边界不符合冻结基线");
  }
  if (!Array.isArray(matrix.requirements)) throw new Error("追溯矩阵必须包含 requirements 数组");
  const rows = matrix.requirements.map((value, index) => {
    const row = record(value, `requirements[${index}]`);
    const evidenceTier = text(row.evidenceTier, `requirements[${index}].evidenceTier`);
    const status = text(row.status, `requirements[${index}].status`);
    if (!requiredTiers.includes(evidenceTier)) throw new Error(`requirements[${index}] 使用未知 Evidence Tier`);
    if (!allowedStatuses.includes(status)) throw new Error(`requirements[${index}] 使用未知状态`);
    if (!Array.isArray(row.sources) || row.sources.length === 0) throw new Error(`requirements[${index}].sources 不能为空`);
    return {
      id: text(row.id, `requirements[${index}].id`),
      ticket: text(row.ticket, `requirements[${index}].ticket`),
      evidenceTier,
      status,
      sources: row.sources.map((source, sourceIndex) => text(source, `requirements[${index}].sources[${sourceIndex}]`)),
    };
  });
  const summary = aggregateEvidenceTiers(rows);
  if (text(matrix.overallStatus, "overallStatus") !== summary.overall) throw new Error("overallStatus 必须由全部必需 Evidence Tier 聚合得出");
  return { matrix, rows, summary };
}

export async function checkReleaseBaseline(root = repositoryRoot) {
  const document = parse(await readFile(path.join(root, traceabilityFile), "utf8"));
  const traceability = parseTraceability(document);
  const baselineCommit = text(traceability.matrix.baselineCommit, "baselineCommit");
  await execute("git", ["cat-file", "-e", `${baselineCommit}^{commit}`], { cwd: root });
  await execute("git", ["merge-base", "--is-ancestor", baselineCommit, "HEAD"], { cwd: root });
  await Promise.all(traceability.rows.flatMap((row) => row.sources.map((source) => access(path.join(root, source)))));
  return traceability;
}

async function main() {
  const result = await checkReleaseBaseline();
  process.stdout.write(`Foundation baseline、Schema/文档引用与追溯矩阵已校验；本地=${result.summary.localAutomated}，真实宿主=${result.summary.realHost}，真实平台=${result.summary.realPlatform}，总体=${result.summary.overall}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
