import assert from "node:assert/strict";
import test from "node:test";

import packageJson from "../../package.json" with { type: "json" };

test("发布 WSSpecKit 产品标识", async () => {
  const ids = (await import("../../src/domain/ids.js")) as Record<string, unknown>;
  assert.equal(packageJson.name, "ws-spec-kit");
  assert.equal(packageJson.bin.wspec, "./dist/cli/main.js");
  assert.equal(typeof ids.isWorkItemId, "function");
  const isWorkItemId = ids.isWorkItemId as (value: string) => boolean;
  assert.equal(isWorkItemId("WSS-login"), true);
  assert.equal(isWorkItemId("WSK-login"), false);
});

test("公开错误码使用 WSSPEC 前缀", async () => {
  const ids = (await import("../../src/domain/ids.js")) as Record<string, unknown>;
  assert.equal(typeof ids.isErrorCode, "function");
  const isErrorCode = ids.isErrorCode as (value: string) => boolean;
  assert.equal(isErrorCode("WSSPEC_COMMAND_UNKNOWN"), true);
  assert.equal(isErrorCode("WSPEC_INTERNAL_ERROR"), false);
});
