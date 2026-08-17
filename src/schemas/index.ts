import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import { schemaIds, schemas, type SchemaId } from "./definitions.js";

export { schemaIds, type SchemaId } from "./definitions.js";

export class SchemaValidationError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
    readonly suggestion: string,
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = formatsModule.default as unknown as FormatsPlugin;
addFormats(ajv);

const validators = new Map<SchemaId, ValidateFunction>();
for (const schemaId of schemaIds) {
  validators.set(schemaId, ajv.compile(schemas[schemaId]));
}

export function getSchema(id: SchemaId): object {
  const schema = schemas[id];
  if (schema === undefined) {
    throw new SchemaValidationError(
      "WSPEC_SCHEMA_UNSUPPORTED_VERSION",
      "/schemaId",
      `不支持 Schema：${id}`,
      "请使用受支持的 v1 Schema ID，或先执行显式迁移。",
    );
  }
  return schema;
}

function diagnostic(error: ErrorObject): SchemaValidationError {
  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty);
    return new SchemaValidationError(
      "WSPEC_SCHEMA_UNKNOWN_FIELD",
      `${error.instancePath}/${property}`,
      `存在未知字段：${property}`,
      `删除未知字段 ${property}，或升级到明确支持它的 Schema。`,
    );
  }
  if (error.keyword === "required") {
    const property = String(error.params.missingProperty);
    return new SchemaValidationError(
      "WSPEC_SCHEMA_REQUIRED_FIELD",
      `${error.instancePath}/${property}`,
      `缺少必填字段：${property}`,
      `补充字段 ${property}，并按照对应 v1 参考规范填写。`,
    );
  }
  return new SchemaValidationError(
    "WSPEC_SCHEMA_INVALID_VALUE",
    error.instancePath || "/",
    error.message ?? "字段值不符合 Schema",
    "检查字段类型、格式和允许值。",
  );
}

export function validate<T>(id: SchemaId, value: unknown): T {
  getSchema(id);
  const validator = validators.get(id);
  if (validator === undefined) {
    throw new Error(`Schema validator missing: ${id}`);
  }
  if (!validator(value)) {
    throw diagnostic(validator.errors?.[0] ?? { keyword: "unknown", instancePath: "", schemaPath: "", params: {} });
  }
  return value as T;
}

export { generatePublicSchemas } from "./generate.js";
