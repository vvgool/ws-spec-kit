import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const renderer = path.join(root, "scripts", "acceptance", "render-connector-live-matrix.mjs");
const historyFile = path.join(root, "docs", "acceptance", "connector-live-history.yaml");

test("真实 Connector 验收矩阵拒绝把 fixture 或 command -v 可用性提升为平台 PASS", async () => {
  await execFileAsync(process.execPath, [renderer, "--check"], { cwd: root });

  const historyText = await readFile(historyFile, "utf8");
  const history = parse(historyText) as {
    overall: string;
    evidenceTiers: { localFixtures: string; realPlatformEvidence: string };
    currentProbe: {
      method: string;
      realPlatformExecution: string;
      providers: Record<string, {
        availability: string;
        realPlatformEvidence: {
          status: string;
          receiptCount: number;
          requiredChecks: readonly string[];
          satisfiedChecks: readonly string[];
        };
      }>;
    };
  };

  assert.equal(history.overall, "no-go");
  assert.equal(history.evidenceTiers.localFixtures, "local-automated-only");
  assert.equal(history.evidenceTiers.realPlatformEvidence, "authorized-dedicated-target-write-idempotency-readback-reconciliation-required");
  assert.equal(history.currentProbe.method, "command-v-only");
  assert.equal(history.currentProbe.realPlatformExecution, "not-authorized-not-run");

  const expectedAvailability = { github: "available-unverified", gitlab: "missing", feishu: "available-unverified" } as const;
  for (const [provider, availability] of Object.entries(expectedAvailability)) {
    const evidence = history.currentProbe.providers[provider]?.realPlatformEvidence;
    assert.equal(history.currentProbe.providers[provider]?.availability, availability);
    assert.equal(evidence?.status, "not-run-no-go");
    assert.equal(evidence?.receiptCount, 0);
    assert.deepEqual(evidence?.satisfiedChecks, []);
    assert.deepEqual(evidence?.requiredChecks, [
      "verified-authentication",
      "dedicated-non-production-target",
      "explicit-exact-write-authorization",
      "idempotency-key",
      "readback-summary",
      "reconciliation-before-retry",
      "redacted-audit-receipt",
    ]);
  }

  assert.doesNotMatch(historyText, /\/Users\/|wiesenwang|Bearer\s|ghp_|glpat-|sk-|access_token/iu);
});
