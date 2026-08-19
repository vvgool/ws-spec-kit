import assert from "node:assert/strict";
import test from "node:test";

import { redactText, redactValue } from "../../src/adapters/process/redaction.js";

test("text redaction removes GH, GitLab, authorization and cookie credentials", () => {
  const source = [
    "GH_TOKEN=gh-secret-value",
    "GITLAB_TOKEN=gitlab-secret-value",
    "Authorization: Bearer auth-secret-value",
    "Cookie: session=cookie-secret-value",
  ].join("\n");

  const redacted = redactText(source);

  for (const secret of ["gh-secret-value", "gitlab-secret-value", "auth-secret-value", "cookie-secret-value"]) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /GH_TOKEN=\[REDACTED\]/u);
  assert.match(redacted, /Authorization: \[REDACTED\]/u);
});

test("structured redaction sanitizes sensitive keys and explicit secrets after JSON parsing", () => {
  const secret = "opaque-structured-secret";
  const redacted = redactValue({
    GH_TOKEN: "gh-value",
    nested: { Authorization: "Bearer nested-value", Cookie: "sid=cookie-value" },
    ordinary: `prefix-${secret}-suffix`,
  }, [secret]);
  const serialized = JSON.stringify(redacted);

  for (const value of ["gh-value", "nested-value", "cookie-value", secret]) assert.equal(serialized.includes(value), false);
  assert.deepEqual(redacted, {
    GH_TOKEN: "[REDACTED]",
    nested: { Authorization: "[REDACTED]", Cookie: "[REDACTED]" },
    ordinary: "prefix-[REDACTED]-suffix",
  });
});

test("explicit secrets cannot hide credential labels or partially mask longer secrets", () => {
  const redacted = redactText(
    "GH_TOKEN=actual-token ordinary=abcdef",
    ["GH_TOKEN", "abc", "abcdef"],
  );

  assert.equal(redacted.includes("actual-token"), false);
  assert.equal(redacted.includes("def"), false);
});
