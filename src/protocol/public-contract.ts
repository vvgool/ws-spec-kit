export const applicationInternalError = {
  code: "WSSPEC_INTERNAL_ERROR",
  message: "发生未预期的内部错误。",
} as const;

export const applicationPublicErrorGroups = {
  internal: [applicationInternalError.code],
  dispatch: ["WSSPEC_COMMAND_UNKNOWN"],
  arguments: ["WSSPEC_ARGUMENT_INVALID", "WSSPEC_ARGUMENT_REQUIRED"],
  repository: [
    "WSSPEC_GIT_REPOSITORY_REQUIRED", "WSSPEC_REPOSITORY_ID_INVALID", "WSSPEC_REPOSITORY_ID_MISMATCH", "WSSPEC_REPOSITORY_NOT_INITIALIZED",
  ],
  schema: [
    "WSSPEC_SCHEMA_INVALID_VALUE", "WSSPEC_SCHEMA_REQUIRED_FIELD", "WSSPEC_SCHEMA_UNKNOWN_FIELD", "WSSPEC_SCHEMA_UNSUPPORTED_VERSION",
  ],
  builtin: [
    "WSSPEC_BUILTIN_CATALOG_INVALID", "WSSPEC_BUILTIN_PROFILE_ID_MISMATCH", "WSSPEC_BUILTIN_PROFILE_WORKFLOW_MISMATCH",
    "WSSPEC_BUILTIN_RESOURCE_PATH_ESCAPE", "WSSPEC_BUILTIN_RESOURCE_PATH_INVALID", "WSSPEC_BUILTIN_WORKFLOW_ID_MISMATCH",
  ],
  workflowPackage: [
    "WSSPEC_WORKFLOW_PACKAGE_BUILTIN_PROVENANCE_INVALID", "WSSPEC_WORKFLOW_PACKAGE_FILE_INVALID", "WSSPEC_WORKFLOW_PACKAGE_FILE_MISSING",
    "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "WSSPEC_WORKFLOW_PACKAGE_LOCK_MISSING", "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID",
    "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING", "WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND", "WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE",
    "WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID", "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID", "WSSPEC_WORKFLOW_PACKAGE_PROFILE_MISSING",
    "WSSPEC_WORKFLOW_PACKAGE_SKILL_MISSING", "WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED", "WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED",
    "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID", "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_MISSING",
  ],
  workflowTrust: [
    "WSSPEC_WORKFLOW_TRUST_ACTOR_INVALID", "WSSPEC_WORKFLOW_TRUST_BUILTIN_MANAGED", "WSSPEC_WORKFLOW_TRUST_CHANGED",
    "WSSPEC_WORKFLOW_TRUST_CHANNEL_INVALID", "WSSPEC_WORKFLOW_TRUST_DECISION_CONFLICT", "WSSPEC_WORKFLOW_TRUST_JOURNAL_INVALID",
    "WSSPEC_WORKFLOW_TRUST_LOCKED", "WSSPEC_WORKFLOW_TRUST_RECORDED", "WSSPEC_WORKFLOW_TRUST_REJECTED",
    "WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID", "WSSPEC_WORKFLOW_TRUST_REQUIRED", "WSSPEC_WORKFLOW_TRUST_STALE_LOCK",
  ],
  skill: [
    "WSSPEC_GLOBAL_ROOT_NOT_CONFIGURED", "WSSPEC_SKILL_AMBIGUOUS", "WSSPEC_SKILL_CONTEXT_INVALID", "WSSPEC_SKILL_FALLBACK_INVALID",
    "WSSPEC_SKILL_LOCK_CHANGED", "WSSPEC_SKILL_LOCK_INVALID", "WSSPEC_SKILL_NOT_FOUND", "WSSPEC_SKILL_PATH_ESCAPE",
    "WSSPEC_SKILL_PATH_INVALID", "WSSPEC_SKILL_REF_INVALID",
  ],
  projectConfig: [
    "WSSPEC_PROJECT_CONFIG_INVALID", "WSSPEC_PROJECT_CONFIG_MISSING", "WSSPEC_PROJECT_GATE_POLICY_INVALID",
  ],
  compiler: [
    "WSSPEC_CHANGE_POLICY_EXPANSION", "WSSPEC_CHANGE_POLICY_OVERRIDE_FORBIDDEN", "WSSPEC_CHANGE_POLICY_PATH_INVALID",
    "WSSPEC_COMPILE_CONFIGURED_GATE_MISSING", "WSSPEC_COMPILE_CYCLE", "WSSPEC_COMPILE_DISABLED_OUTPUT_REQUIRED",
    "WSSPEC_COMPILE_DOCUMENTATION_GATE_REQUIRED", "WSSPEC_COMPILE_DOCUMENTATION_TDD_FORBIDDEN", "WSSPEC_COMPILE_DUPLICATE_GATE",
    "WSSPEC_COMPILE_DUPLICATE_STEP", "WSSPEC_COMPILE_EXPRESSION_INVALID", "WSSPEC_COMPILE_EXPRESSION_PROPERTY_UNKNOWN",
    "WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNAVAILABLE", "WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN", "WSSPEC_COMPILE_EXPRESSION_TYPE_MISMATCH",
    "WSSPEC_COMPILE_GATE_POLICY_INVALID", "WSSPEC_COMPILE_GATE_POLICY_UNKNOWN", "WSSPEC_COMPILE_MANIFEST_CAPABILITY_MISSING",
    "WSSPEC_COMPILE_MANIFEST_CONNECTOR_MISSING", "WSSPEC_COMPILE_MANIFEST_SIDE_EFFECT_MISSING", "WSSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER",
    "WSSPEC_COMPILE_OUTPUT_NOT_GUARANTEED", "WSSPEC_COMPILE_PLAN_REQUIRED", "WSSPEC_COMPILE_PROFILE_ARTIFACT_UNKNOWN",
    "WSSPEC_COMPILE_PROFILE_MISMATCH", "WSSPEC_COMPILE_PROFILE_NOT_FOUND", "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN",
    "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE", "WSSPEC_COMPILE_PROFILE_STEP_UNKNOWN", "WSSPEC_COMPILE_QUICK_PROFILE_INVALID",
    "WSSPEC_COMPILE_REQUIRED_GATE_MISSING", "WSSPEC_COMPILE_REQUIRED_SKILL_MISSING", "WSSPEC_COMPILE_SECURITY_OVERRIDE",
    "WSSPEC_COMPILE_SKILL_AMBIGUOUS", "WSSPEC_COMPILE_SKILL_MISMATCH", "WSSPEC_COMPILE_SKILL_POLICY_OVERRIDE",
    "WSSPEC_COMPILE_STEP_INVALID", "WSSPEC_COMPILE_TDD_REQUIRED", "WSSPEC_COMPILE_UNKNOWN_DEPENDENCY", "WSSPEC_COMPILE_UNKNOWN_GATE",
  ],
  expression: [
    "WSSPEC_EXPRESSION_FORBIDDEN", "WSSPEC_EXPRESSION_INVALID", "WSSPEC_EXPRESSION_LIMIT_EXCEEDED", "WSSPEC_EXPRESSION_TYPE_INVALID",
  ],
  executor: [
    "WSSPEC_EXECUTOR_ACTION_NOT_FOUND", "WSSPEC_EXECUTOR_CONTEXT_INVALID", "WSSPEC_EXECUTOR_DUPLICATE", "WSSPEC_EXECUTOR_NOT_FOUND",
    "WSSPEC_EXECUTOR_SECURITY_MISMATCH",
  ],
  source: [
    "WSSPEC_SOURCE_EMPTY", "WSSPEC_SOURCE_PATH_INVALID", "WSSPEC_SOURCE_SNAPSHOT_CHANGED", "WSSPEC_SOURCE_SNAPSHOT_INVALID",
    "WSSPEC_SOURCE_TYPE_UNSUPPORTED",
  ],
  snapshot: [
    "WSSPEC_APPLICATION_ANCHOR_INVALID", "WSSPEC_APPLICATION_SNAPSHOT_CHANGED", "WSSPEC_APPLICATION_SNAPSHOT_INVALID",
    "WSSPEC_CONFIG_SNAPSHOT_CHANGED", "WSSPEC_SCHEMA_SNAPSHOT_CHANGED", "WSSPEC_SKILL_SNAPSHOT_CHANGED",
    "WSSPEC_WORKFLOW_SNAPSHOT_CHANGED", "WSSPEC_WORK_ITEM_MANIFEST_CHANGED",
  ],
  workItem: [
    "WSSPEC_CONTROL_PLANE_INVALID", "WSSPEC_WORK_ITEM_ID_CONFLICT", "WSSPEC_WORK_ITEM_INVALID", "WSSPEC_WORK_ITEM_LOCATION_INVALID",
    "WSSPEC_WORK_ITEM_NOT_FOUND", "WSSPEC_WORK_ITEM_ROLLBACK_FAILED", "WSSPEC_WORK_ITEM_ROLLBACK_REFUSED",
  ],
  runtime: [
    "WSSPEC_CONTROL_PLANE_LOCKED", "WSSPEC_CONTROL_PLANE_READ_ONLY", "WSSPEC_CONTROL_PLANE_STALE_LOCK",
    "WSSPEC_EVENT_CHAIN_INVALID", "WSSPEC_EVENT_INVALID", "WSSPEC_IDEMPOTENCY_CONFLICT", "WSSPEC_PROJECTION_WRITE_FAILED",
    "WSSPEC_STAGE_NOT_FOUND", "WSSPEC_STATE_TRANSITION_FORBIDDEN",
  ],
  start: ["WSSPEC_START_ROLLBACK_FAILED"],
  acquire: [
    "WSSPEC_REQUIRED_INPUT_ARTIFACT_MISSING", "WSSPEC_STAGE_ALREADY_CLAIMED", "WSSPEC_STEP_RETRY_EXHAUSTED", "WSSPEC_WORKFLOW_BLOCKED",
  ],
  artifact: [
    "WSSPEC_ARTIFACT_ENCODING_INVALID", "WSSPEC_ARTIFACT_HASH_MISMATCH", "WSSPEC_ARTIFACT_INCOMPLETE",
    "WSSPEC_ARTIFACT_SCHEMA_MISMATCH", "WSSPEC_ARTIFACT_SCHEMA_NOT_FOUND",
  ],
  submit: [
    "WSSPEC_ARTIFACT_REFERENCE_INVALID", "WSSPEC_ATTEMPT_NOT_ACTIVE", "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION",
    "WSSPEC_MODIFIED_FILES_MISMATCH", "WSSPEC_REQUIRED_ARTIFACT_MISSING", "WSSPEC_STEP_FAILED", "WSSPEC_UNDECLARED_ARTIFACT",
  ],
  approval: [
    "WSSPEC_APPROVAL_DIGEST_MISMATCH", "WSSPEC_APPROVAL_EXPIRED", "WSSPEC_APPROVAL_NOT_EXPIRED", "WSSPEC_APPROVAL_NOT_PENDING",
    "WSSPEC_APPROVAL_NOT_READY", "WSSPEC_INTERACTIVE_TTY_REQUIRED",
  ],
  workflowEject: ["WSSPEC_WORKFLOW_EJECT_SOURCE_INVALID", "WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS"],
  agentInstall: ["WSSPEC_SKILL_INSTALL_CONFLICT"],
} as const satisfies Readonly<Record<string, readonly `WSSPEC_${string}`[]>>;

export type ApplicationPublicErrorGroup = keyof typeof applicationPublicErrorGroups;
export type ApplicationPublicErrorCode = typeof applicationPublicErrorGroups[ApplicationPublicErrorGroup][number];
export type ApplicationRollbackErrorCode = Extract<ApplicationPublicErrorCode, `WSSPEC_${string}ROLLBACK${string}`>;

export const applicationFixedPublicErrors = {
  WSSPEC_WORK_ITEM_ROLLBACK_FAILED: {
    code: "WSSPEC_WORK_ITEM_ROLLBACK_FAILED",
    message: "Work Item 创建失败且无法安全回滚。",
  },
  WSSPEC_WORK_ITEM_ROLLBACK_REFUSED: {
    code: "WSSPEC_WORK_ITEM_ROLLBACK_REFUSED",
    message: "Work Item 回滚被安全策略拒绝。",
  },
  WSSPEC_START_ROLLBACK_FAILED: {
    code: "WSSPEC_START_ROLLBACK_FAILED",
    message: "Start 失败且无法安全回滚新建 Work Item。",
  },
} as const satisfies Record<ApplicationRollbackErrorCode, { code: ApplicationRollbackErrorCode; message: string }>;

export const publicCliRoutes = [
  "init", "start", "acquire", "submit", "decide", "inspect",
  "workflow list", "workflow show", "workflow eject", "workflow validate", "workflow use", "agent install",
] as const;
export type PublicCliRoute = typeof publicCliRoutes[number];

export const publicCliErrorRoutes = ["dispatch", "workflow", "agent", ...publicCliRoutes] as const;
export type PublicCliErrorRoute = typeof publicCliErrorRoutes[number];

const applicationGroups = [
  "repository", "schema", "snapshot", "workItem", "runtime",
] as const satisfies readonly ApplicationPublicErrorGroup[];
const workflowValidationGroups = [
  "repository", "schema", "builtin", "workflowPackage", "skill", "projectConfig", "compiler", "executor",
] as const satisfies readonly ApplicationPublicErrorGroup[];

export const applicationPublicErrorGroupNamesByRoute = {
  dispatch: ["internal", "dispatch"],
  workflow: ["internal", "dispatch"],
  agent: ["internal", "dispatch"],
  init: ["internal", "arguments", "repository"],
  start: [
    "internal", "arguments", "repository", "schema", "builtin", "workflowPackage", "workflowTrust", "skill", "projectConfig",
    "compiler", "executor", "source", "workItem", "runtime", "start",
  ],
  acquire: ["internal", "arguments", ...applicationGroups, "skill", "projectConfig", "executor", "source", "expression", "acquire"],
  submit: ["internal", "arguments", ...applicationGroups, "skill", "projectConfig", "executor", "source", "acquire", "artifact", "submit", "approval"],
  decide: [
    "internal", "arguments", ...applicationGroups, "skill", "projectConfig", "executor", "source", "acquire", "artifact", "submit",
    "approval", "workflowPackage", "workflowTrust",
  ],
  inspect: ["internal", "arguments", "repository", "schema", "snapshot", "workItem"],
  "workflow list": ["internal", "arguments", "builtin"],
  "workflow show": ["internal", "arguments", "builtin", "workflowPackage"],
  "workflow eject": ["internal", "arguments", "builtin", "workflowPackage", "workflowEject"],
  "workflow validate": ["internal", "arguments", ...workflowValidationGroups],
  "workflow use": ["internal", "arguments", ...workflowValidationGroups, "workflowTrust"],
  "agent install": ["internal", "arguments", "agentInstall"],
} as const satisfies Readonly<Record<PublicCliErrorRoute, readonly ApplicationPublicErrorGroup[]>>;

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export const applicationPublicErrorCodesByRoute = Object.freeze(Object.fromEntries(
  publicCliErrorRoutes.map((route) => [
    route,
    Object.freeze(uniqueSorted(applicationPublicErrorGroupNamesByRoute[route].flatMap((group) => applicationPublicErrorGroups[group]))),
  ]),
)) as Readonly<Record<PublicCliErrorRoute, readonly ApplicationPublicErrorCode[]>>;

export const applicationPublicErrorCodes = Object.freeze(uniqueSorted(Object.values(applicationPublicErrorGroups).flat()));

const applicationPublicErrorCodeSet: ReadonlySet<string> = new Set(applicationPublicErrorCodes);
const applicationPublicErrorCodeSetsByRoute = Object.fromEntries(publicCliErrorRoutes.map((route) => [
  route,
  new Set(applicationPublicErrorCodesByRoute[route]),
])) as unknown as Readonly<Record<PublicCliErrorRoute, ReadonlySet<string>>>;

export function isApplicationPublicErrorCode(value: unknown, route?: PublicCliErrorRoute): value is ApplicationPublicErrorCode {
  if (typeof value !== "string") return false;
  return route === undefined ? applicationPublicErrorCodeSet.has(value) : applicationPublicErrorCodeSetsByRoute[route].has(value);
}
