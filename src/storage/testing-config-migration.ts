import * as canonicalizeModule from "canonicalize";
import { sha256 } from "../domain/digests.js";
import { validate } from "../schemas/index.js";
import { VerificationError } from "../engine/tdd/types.js";
const canonicalize = canonicalizeModule.default as unknown as (value: unknown) => string | undefined;

export const testingConfigEvidenceKey = "testing.config-migration";

export interface TestingConfigMigration {
  version: 1;
  baseDigest: string;
  configDigest: string;
  config: unknown;
}

export function readTestingConfigMigration(value: unknown, baseDigest: string): TestingConfigMigration | undefined {
  if (value === undefined) return undefined;
  const record = value as TestingConfigMigration;
  const encoded = record?.config === undefined ? undefined : canonicalize(record.config);
  if (encoded === undefined || record === null || typeof record !== "object" || record.version !== 1 || record.baseDigest !== baseDigest
    || record.configDigest !== sha256(encoded)) {
    throw new VerificationError("WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "测试配置迁移记录绑定无效。");
  }
  validate("builtin.application-project-config.v1", record.config);
  return record;
}
