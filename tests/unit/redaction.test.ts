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
    nested: {
      Authorization: "Bearer nested-value",
      Cookie: "sid=cookie-value",
      accessToken: "access-value",
      refreshToken: "refresh-value",
      clientSecret: "client-value",
      apiKey: "api-value",
    },
    ordinary: `prefix-${secret}-suffix`,
  }, [secret]);
  const serialized = JSON.stringify(redacted);

  for (const value of ["nested-value", "cookie-value", "access-value", "refresh-value", "client-value", "api-value", secret]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.deepEqual(redacted, {
    nested: {},
    ordinary: "prefix-[REDACTED]-suffix",
  });
});

test("structured redaction fails closed on nested secret keys without key collisions", () => {
  const shortSecret = "R";
  const unicodeSecret = "密钥";
  const redacted = redactValue({
    short: { [`left${shortSecret}`]: "one", [`right${shortSecret}`]: "two", keep: "discarded" },
    unicode: { [`prefix-${unicodeSecret}-suffix`]: "hidden", keep: "discarded" },
    credential: { accessToken: "credential-value", keep: "discarded" },
    ordinary: { keep: "visible" },
  }, [shortSecret, unicodeSecret]);

  assert.deepEqual(redacted, {
    short: {},
    unicode: {},
    credential: {},
    ordinary: { keep: "visible" },
  });
  const serialized = JSON.stringify(redacted);
  for (const secret of [shortSecret, unicodeSecret, "accessToken", "credential-value"]) assert.equal(serialized.includes(secret), false);
});

test("short and overlapping explicit secrets never survive through the replacement marker", () => {
  const redacted = redactText("value=R abcXdef", ["R", "X", "abcdef"]);

  for (const secret of ["R", "X", "abcdef"]) assert.equal(redacted.includes(secret), false);
});

test("explicit secrets cannot hide credential labels or partially mask longer secrets", () => {
  const redacted = redactText(
    "GH_TOKEN=actual-token ordinary=abcdef",
    ["GH_TOKEN", "abc", "abcdef"],
  );

  assert.equal(redacted.includes("actual-token"), false);
  assert.equal(redacted.includes("def"), false);
});

test("label redaction preserves unrelated fields on the same line", () => {
  const redacted = redactText("token=token-value status=failed request=42 retry=no");

  assert.equal(redacted.includes("token-value"), false);
  assert.match(redacted, /status=failed/u);
  assert.match(redacted, /request=42/u);
  assert.match(redacted, /retry=no/u);
});

test("Authorization Basic and complete Cookie header values are removed", () => {
  const redacted = redactText([
    "Authorization: Basic dXNlcjpwYXNz",
    'Authorization: Digest username="user", realm="private", response="digest-secret"',
    "Authorization: Custom custom-secret-value",
    "Cookie: sid=first-secret; refresh=second-secret",
    "Set-Cookie: sid=first-secret; HttpOnly; refresh=second-secret",
  ].join("\n"));

  for (const secret of ["dXNlcjpwYXNz", "digest-secret", "custom-secret-value", "first-secret", "second-secret"]) {
    assert.equal(redacted.includes(secret), false);
  }
});
