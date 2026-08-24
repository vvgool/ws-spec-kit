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

async function renderHistory(value: unknown): Promise<void> {
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", `import { renderConnectorLiveMatrix } from ${JSON.stringify(renderer)}; renderConnectorLiveMatrix(JSON.parse(process.argv[1]));`, JSON.stringify(value)], { cwd: root });
}

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
        governedRun?: {
          workItemId: string;
          requestId: string;
          target: string;
          requestedEffectKind: string;
          contentDigest: string;
          hostAuthentication: string;
          doctorAuthentication: string;
          firstSubmit: string;
          approval: string;
          secondSubmit: string;
          publicReconcile: string;
          receipt: string;
        };
      }>;
    };
  };

  assert.equal(history.overall, "no-go");
  assert.equal(history.evidenceTiers.localFixtures, "local-automated-only");
  assert.equal(history.evidenceTiers.realPlatformEvidence, "authorized-dedicated-target-write-idempotency-readback-reconciliation-required");
  assert.equal(history.currentProbe.method, "command-v-plus-governed-run");
  assert.equal(history.currentProbe.realPlatformExecution, "gitlab-governed-run-reconciliation-required");

  const expectedAvailability = { github: "available-unverified", gitlab: "available-verified", feishu: "available-unverified" } as const;
  for (const [provider, availability] of Object.entries(expectedAvailability)) {
    const evidence = history.currentProbe.providers[provider]?.realPlatformEvidence;
    assert.equal(history.currentProbe.providers[provider]?.availability, availability);
    const expectedStatus = provider === "gitlab" ? "reconciliation-required-no-go" : "not-run-no-go";
    assert.equal(evidence?.status, expectedStatus);
    assert.equal(evidence?.receiptCount, 0);
    assert.deepEqual(evidence?.satisfiedChecks, provider === "gitlab" ? ["verified-authentication", "explicit-exact-write-authorization", "reconciliation-before-retry"] : []);
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

  const gitlab = history.currentProbe.providers.gitlab;
  assert.deepEqual(gitlab?.governedRun, {
    workItemId: "WSS-01M0S8S3CXJ1Q7M9TWMG3WE03A",
    requestId: "external-request-9c05777fdc6844ab58698afe49db4e40aba632c32e5f8e5f42deaaf3122d10aa",
    target: "gitlab:892",
    requestedEffectKind: "issue.comment",
    contentDigest: "sha256:2b3123f714d6cec7092fa66136b74333e9d1945a812b7f4557c7260a67715fef",
    hostAuthentication: "verified-host-scoped-glab-auth-status",
    doctorAuthentication: "false-negative-default-gitlab-com-unauthenticated",
    firstSubmit: "await_approval",
    approval: "exact-approved",
    secondSubmit: "reconciliation_required",
    publicReconcile: "remains-reconciliation-required",
    receipt: "absent-unverified",
  });

  assert.doesNotMatch(historyText, /\/Users\/|wiesenwang|Bearer\s|ghp_|glpat-|sk-|access_token|effectId|body\s*:/iu);
});

test("Connector renderer rejects a governed GitLab run that claims pass, a receipt, or sensitive fields", async (t) => {
  const history = parse(await readFile(historyFile, "utf8")) as {
    currentProbe: { providers: { gitlab: { realPlatformEvidence: { status: string; receiptCount: number }; governedRun: Record<string, string> } } };
  };

  await t.test("Given a reconciliation-required run When it claims pass Then rendering rejects it", async () => {
    const invalid = structuredClone(history);
    invalid.currentProbe.providers.gitlab.realPlatformEvidence.status = "passed";
    await assert.rejects(renderHistory(invalid), /reconciliation-required/u);
  });

  await t.test("Given a receipt-free run When it claims a receipt Then rendering rejects it", async () => {
    const invalid = structuredClone(history);
    invalid.currentProbe.providers.gitlab.realPlatformEvidence.receiptCount = 1;
    await assert.rejects(renderHistory(invalid), /伪造回执/u);
  });

  await t.test("Given a redacted run When it contains a forbidden field Then rendering rejects it", async () => {
    const invalid = structuredClone(history);
    invalid.currentProbe.providers.gitlab.governedRun.effectId = "redacted-test-value";
    await assert.rejects(renderHistory(invalid), /禁止记录/u);
  });

  await t.test("Given a redacted run When it contains a raw body Then rendering rejects it", async () => {
    const invalid = structuredClone(history);
    invalid.currentProbe.providers.gitlab.governedRun.body = "redacted-test-value";
    await assert.rejects(renderHistory(invalid), /禁止记录/u);
  });
});
