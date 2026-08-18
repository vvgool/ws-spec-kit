export const schemaIds = [
  "builtin.workflow-selection.v1",
  "builtin.application-project-config.v1",
  "builtin.application-project-config-snapshot.v1",
  "builtin.work-item.v1",
  "builtin.application-start-input.v1",
  "builtin.application-acquire-input.v1",
  "builtin.application-submit-input.v1",
  "builtin.application-decision-input.v1",
  "builtin.application-inspect-input.v1",
  "builtin.agent-action.v1",
  "builtin.work-package.v1",
  "builtin.submit-result.v1",
  "builtin.evidence.v1",
  "builtin.tdd-trusted-evidence.v1",
  "builtin.tdd-cycle-evidence.v1",
  "builtin.tdd-node-test-report.v1",
  "builtin.external-receipt.v1",
  "builtin.artifact.v1",
] as const;

export type SchemaId = (typeof schemaIds)[number];

type JsonSchema = Record<string, unknown>;

const idPattern = "^[a-z][a-z0-9-]{0,62}$";
const gateIdPattern = "^[a-z][a-z0-9.-]{0,62}$";
const stepInstanceIdPattern = "^[a-z][a-z0-9-]{0,62}(?::[1-9][0-9]*:[a-z][a-z0-9-]{0,62})?$";
const digestPattern = "^sha256:.+$";
const repositoryIdPattern = "^repo-[0-9A-HJKMNP-TV-Z]{26}$";
const workItemIdPattern = "^WSS-[A-Za-z0-9-]+$";
const attemptIdPattern = "^attempt-.+$";
const errorCodePattern = "^WSSPEC_[A-Z0-9_]+$";

const stringArray = { type: "array", items: { type: "string" }, uniqueItems: true } as const;
const testPathRuleSchema = { enum: ["node", "java", "ruby", "dotnet"] } as const;

const approvalSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["required"],
  properties: {
    required: { type: "boolean" },
    provider: { enum: ["interactive"] },
  },
  allOf: [
    {
      if: { properties: { required: { const: true } }, required: ["required"] },
      then: { properties: { provider: { enum: ["interactive"] } }, required: ["provider"] },
    },
  ],
};

const stageSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "owner", "uses"],
  properties: {
    id: { type: "string", pattern: idPattern },
    kind: { enum: ["define", "design", "plan", "implement", "review", "verify", "publish", "close"] },
    owner: { enum: ["agent", "engine"] },
    uses: { type: "string", pattern: "^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*$" },
    needs: stringArray,
    input: stringArray,
    output: stringArray,
    approval: approvalSchema,
    gates: stringArray,
    publish: stringArray,
  },
};

const gateSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "cwd", "timeoutSeconds", "required", "evidence"],
  properties: {
    command: { type: "array", minItems: 1, items: { type: "string" } },
    cwd: { const: "worktree" },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 },
    required: { type: "boolean" },
    evidence: { enum: ["trusted", "attested"] },
    inheritEnv: {
      type: "array",
      items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
      uniqueItems: true,
    },
    env: {
      type: "object",
      propertyNames: { pattern: "^[A-Z_][A-Z0-9_]*$" },
      additionalProperties: { type: "string" },
    },
    reporter: {
      type: "object",
      additionalProperties: false,
      required: ["type", "version"],
      properties: { type: { const: "node-test" }, version: { const: 1 } },
    },
  },
};

const artifactReferenceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifactType", "schemaVersion"],
  properties: {
    artifactType: { type: "string", pattern: idPattern },
    schemaVersion: { type: "integer", minimum: 1 },
    path: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    contentHash: { type: "string", pattern: digestPattern },
    mediaType: { type: "string" },
    contentLevel: { type: "string", minLength: 1 },
  },
};

const requirementSourceSchema: JsonSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["type", "text"],
      properties: { type: { const: "prompt" }, text: { type: "string", minLength: 1 } },
    },
    {
      type: "object", additionalProperties: false, required: ["type", "path"],
      properties: { type: { const: "file" }, path: { type: "string", minLength: 1 } },
    },
    {
      type: "object", additionalProperties: false, required: ["type", "provider", "id"],
      properties: {
        type: { const: "issue" }, provider: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 }, url: { type: "string", format: "uri" },
      },
    },
  ],
};

const submitResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "status", "summary", "modifiedFiles", "artifacts", "commands", "evidence", "externalWrites", "remainingRisks"],
  properties: {
    version: { const: 1 },
    status: { enum: ["completed", "failed"] },
    summary: { type: "string", minLength: 1 },
    modifiedFiles: stringArray,
    artifacts: { type: "array", items: artifactReferenceSchema },
    commands: { type: "array", items: { type: "object" } },
    evidence: { type: "array", items: { type: "object" } },
    externalWrites: { type: "array", items: { type: "object" } },
    remainingRisks: { type: "array", items: { type: "object" } },
  },
};

const workPackageSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "workItemId", "stepId", "attemptId", "lease", "objective", "skills", "artifacts", "constraints", "requiredOutputs", "gates", "resultSchema"],
  properties: {
    version: { const: 1 },
    workItemId: { type: "string", pattern: workItemIdPattern },
    stepId: { type: "string", pattern: stepInstanceIdPattern },
    attemptId: { type: "string", pattern: attemptIdPattern },
    lease: {
      type: "object", additionalProperties: false, required: ["token", "expiresAt"],
      properties: { token: { type: "string", minLength: 1 }, expiresAt: { type: "string", format: "date-time" } },
    },
    objective: { type: "string", minLength: 1 },
    artifactLevel: { type: "string", minLength: 1 },
    skills: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["ref", "version", "digest", "description"],
        properties: {
          ref: { type: "string", minLength: 1 }, version: { type: "string", minLength: 1 },
          digest: { type: "string", pattern: digestPattern }, description: { type: "string", minLength: 1 },
        },
      },
    },
    artifacts: { type: "array", items: artifactReferenceSchema },
    constraints: {
      type: "object", additionalProperties: false, required: ["allowedPaths", "forbiddenActions"],
      properties: { allowedPaths: stringArray, forbiddenActions: stringArray },
    },
    requiredOutputs: { type: "array", items: artifactReferenceSchema },
    gates: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "evidence", "required"],
        properties: {
          id: { type: "string", pattern: gateIdPattern },
          evidence: { enum: ["trusted", "attested", "reported"] }, required: { type: "boolean" },
        },
      },
    },
    resultSchema: { const: "builtin.submit-result.v1" },
  },
};

const publishBinding = (properties: Record<string, JsonSchema>): JsonSchema => ({
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: Object.keys(properties).slice(0, 3),
      properties,
    },
  ],
});

function applicationProjectConfigSchema(id: "builtin.application-project-config.v1" | "builtin.application-project-config-snapshot.v1", portable: boolean): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    type: "object",
    additionalProperties: false,
    required: ["version"],
    properties: {
      version: { const: 1 },
      trigger: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { enum: ["off", "suggest", "active-only"] } },
      },
      git: {
        type: "object",
        additionalProperties: false,
        required: ["worktrees"],
        properties: {
          worktrees: {
            type: "object",
            additionalProperties: false,
            required: ["enabled", "root", "branchPrefix"],
            properties: {
              enabled: { const: true },
              root: { type: "string", minLength: 1 },
              branchPrefix: { type: "string", minLength: 1 },
            },
          },
        },
      },
      runtime: {
        type: "object",
        additionalProperties: false,
        required: ["claimTtlSeconds", "maxStageRetries"],
        properties: {
          claimTtlSeconds: { type: "integer", minimum: 60, maximum: 86400 },
          maxStageRetries: { type: "integer", minimum: 0, maximum: 10 },
        },
      },
      quality: {
        type: "object",
        additionalProperties: false,
        required: ["gates"],
        properties: {
          gates: {
            type: "object",
            minProperties: 1,
            propertyNames: { pattern: idPattern },
            additionalProperties: gateSchema,
          },
        },
      },
      testing: {
        type: "object",
        additionalProperties: false,
        required: ["pathRules", "testAssetPaths", "productPaths"],
        properties: {
          pathRules: { type: "array", minItems: 1, uniqueItems: true, items: testPathRuleSchema },
          testAssetPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
          productPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
        },
      },
      publishing: {
        type: "object",
        additionalProperties: false,
        required: ["targets"],
        properties: { targets: { type: "object", additionalProperties: false } },
      },
      documentation: {
        type: "object",
        additionalProperties: false,
        required: ["allowedPaths"],
        properties: {
          allowedPaths: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
      },
      skills: {
        type: "object",
        additionalProperties: false,
        required: ["additionalGlobalRoots"],
        properties: {
          additionalGlobalRoots: {
            type: "array",
            minItems: 1,
            ...(portable ? { uniqueItems: true } : {}),
            items: {
              type: "object",
              additionalProperties: false,
              required: portable ? ["id"] : ["id", "path"],
              properties: {
                id: { type: "string", pattern: idPattern },
                ...(portable ? {} : { path: { type: "string", minLength: 1 } }),
              },
            },
          },
        },
      },
    },
  };
}

export const schemas = {
  "builtin.workflow-selection.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.workflow-selection.v1",
    type: "object",
    additionalProperties: false,
    required: ["version", "activeWorkflow"],
    properties: {
      version: { const: 1 },
      activeWorkflow: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "version"],
        properties: {
          ref: { type: "string", pattern: "^(builtin|project)://workflows/[a-z0-9][a-z0-9-]*$" },
          version: { const: 1 },
        },
      },
      profile: { enum: ["auto", "quick", "standard", "governed"] },
    },
  },
  "builtin.application-project-config.v1": applicationProjectConfigSchema("builtin.application-project-config.v1", false),
  "builtin.application-project-config-snapshot.v1": applicationProjectConfigSchema("builtin.application-project-config-snapshot.v1", true),
  "builtin.work-item.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.work-item.v1",
    type: "object",
    additionalProperties: false,
    required: ["version", "workItemId", "repositoryId", "title", "createdAt", "status", "execution", "source", "bindings"],
    properties: {
      version: { const: 1 },
      workItemId: { type: "string", pattern: workItemIdPattern },
      repositoryId: { type: "string", pattern: repositoryIdPattern },
      title: { type: "string", minLength: 1 },
      createdAt: { type: "string", format: "date-time" },
      status: { enum: ["draft", "active", "awaiting_approval", "verifying", "verified", "blocked", "pending_publish", "reconciliation_required", "paused", "closed", "cancelled"] },
      execution: {
        type: "object",
        additionalProperties: false,
        required: ["worktree", "branch", "baselineRevision", "baselineTreeDigest", "workflowDigest", "configDigest", "schemaDigest"],
        properties: {
          worktree: { type: "string", minLength: 1 },
          branch: { type: "string", minLength: 1 },
          baselineRevision: { type: "string", minLength: 1 },
          baselineTreeDigest: { type: "string", pattern: digestPattern },
          workflowDigest: { type: "string", pattern: digestPattern },
          configDigest: { type: "string", pattern: digestPattern },
          schemaDigest: { type: "string", pattern: digestPattern },
        },
      },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["type", "snapshot", "contentDigest"],
        properties: {
          type: { enum: ["prompt", "file", "issue"] },
          snapshot: { type: "string", minLength: 1 },
          contentDigest: { type: "string", pattern: digestPattern },
        },
      },
      bindings: {
        type: "object",
        additionalProperties: false,
        required: ["issue", "knowledge"],
        properties: {
          issue: publishBinding({ provider: { type: "string" }, stableId: { type: "string" }, url: { type: "string" } }),
          knowledge: publishBinding({ adapter: { type: "string" }, space: { type: "string" }, stableId: { type: "string" }, url: { type: "string" } }),
        },
      },
    },
  },
  "builtin.application-start-input.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.application-start-input.v1",
    type: "object", additionalProperties: false, required: ["root", "source"],
    properties: {
      root: { type: "string", minLength: 1 }, source: requirementSourceSchema,
      workflowRef: { type: "string", minLength: 1 },
      profile: { enum: ["auto", "quick", "standard", "governed"] },
    },
  },
  "builtin.application-acquire-input.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.application-acquire-input.v1",
    type: "object", additionalProperties: false, required: ["root", "workItemId", "actor"],
    properties: {
      root: { type: "string", minLength: 1 }, workItemId: { type: "string", pattern: workItemIdPattern },
      actor: { type: "string", minLength: 1 },
    },
  },
  "builtin.application-submit-input.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.application-submit-input.v1",
    type: "object", additionalProperties: false,
    required: ["root", "workItemId", "stepId", "attemptId", "leaseToken", "result"],
    properties: {
      root: { type: "string", minLength: 1 }, workItemId: { type: "string", pattern: workItemIdPattern },
      stepId: { type: "string", pattern: stepInstanceIdPattern }, attemptId: { type: "string", pattern: attemptIdPattern },
      leaseToken: { type: "string", minLength: 1 }, result: submitResultSchema,
    },
  },
  "builtin.application-decision-input.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.application-decision-input.v1",
    oneOf: [
      {
        type: "object", additionalProperties: false,
        required: ["kind", "root", "workItemId", "requestId", "decision", "expectedDigest", "actor"],
        properties: {
          kind: { const: "approval" }, root: { type: "string", minLength: 1 },
          workItemId: { type: "string", pattern: workItemIdPattern }, requestId: { type: "string", minLength: 1 },
          decision: { enum: ["approved", "rejected"] }, expectedDigest: { type: "string", pattern: digestPattern },
          actor: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object", additionalProperties: false,
        required: ["kind", "root", "requestId", "decision", "expectedPackageDigest", "expectedCapabilityDigest", "actor"],
        properties: {
          kind: { const: "workflow_trust" }, root: { type: "string", minLength: 1 },
          requestId: { type: "string", minLength: 1 }, decision: { enum: ["trusted", "rejected"] },
          expectedPackageDigest: { type: "string", pattern: digestPattern },
          expectedCapabilityDigest: { type: "string", pattern: digestPattern }, actor: { type: "string", minLength: 1 },
        },
      },
    ],
  },
  "builtin.application-inspect-input.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.application-inspect-input.v1",
    type: "object", additionalProperties: false, required: ["root", "workItemId"],
    properties: { root: { type: "string", minLength: 1 }, workItemId: { type: "string", pattern: workItemIdPattern } },
  },
  "builtin.agent-action.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.agent-action.v1",
    oneOf: [
      {
        type: "object", additionalProperties: false, required: ["action", "workPackage"],
        properties: { action: { const: "execute" }, workPackage: workPackageSchema },
      },
      {
        type: "object", additionalProperties: false, required: ["action", "approval"],
        properties: {
          action: { const: "await_approval" },
          approval: {
            type: "object", additionalProperties: false,
            required: ["kind", "requestId", "workItemId", "title", "digest"],
            properties: {
              kind: { enum: ["step", "external_action", "workflow_trust"] }, requestId: { type: "string", minLength: 1 },
              workItemId: { type: "string", pattern: workItemIdPattern }, title: { type: "string", minLength: 1 },
              digest: { type: "string", pattern: digestPattern },
            },
          },
        },
      },
      {
        type: "object", additionalProperties: false, required: ["action", "problems"],
        properties: {
          action: { const: "blocked" }, problems: {
            type: "array", minItems: 1, items: {
              type: "object", additionalProperties: false, required: ["code", "message", "retryable"],
              properties: {
                code: { type: "string", pattern: errorCodePattern }, message: { type: "string", minLength: 1 },
                retryable: { type: "boolean" },
              },
            },
          },
        },
      },
      {
        type: "object", additionalProperties: false, required: ["action", "summary"],
        properties: {
          action: { const: "completed" }, summary: {
            type: "object", additionalProperties: false, required: ["workItemId", "status", "message"],
            properties: {
              workItemId: { type: "string", pattern: workItemIdPattern }, status: { enum: ["closed", "cancelled"] },
              message: { type: "string", minLength: 1 },
            },
          },
        },
      },
    ],
  },
  "builtin.work-package.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.work-package.v1", ...workPackageSchema,
  },
  "builtin.submit-result.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.submit-result.v1", ...submitResultSchema,
  },
  "builtin.evidence.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.evidence.v1",
    type: "object",
    additionalProperties: false,
    required: ["evidenceId", "level", "gateId", "codeRevision", "baselineTreeDigest", "workspaceTreeDigest", "configDigest", "attemptId", "result", "recordHash"],
    properties: {
      evidenceId: { type: "string", minLength: 1 },
      level: { enum: ["trusted", "attested", "reported"] },
      gateId: { type: "string", pattern: gateIdPattern },
      codeRevision: { type: "string", minLength: 1 },
      baselineTreeDigest: { type: "string", pattern: digestPattern },
      workspaceTreeDigest: { type: "string", pattern: digestPattern },
      configDigest: { type: "string", pattern: digestPattern },
      attemptId: { type: "string", pattern: "^attempt-.+$" },
      result: { enum: ["passed", "failed"] },
      recordHash: { type: "string", pattern: digestPattern },
    },
  },
  "builtin.tdd-trusted-evidence.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.tdd-trusted-evidence.v1",
    type: "object",
    additionalProperties: false,
    required: ["evidenceId", "level", "phase", "taskId", "stepId", "commandId", "commandDigest", "exitCode", "failedTests", "testPaths", "testFiles", "testPathsDigest", "testPathRules", "testAssets", "testAssetsDigest", "testAssetPaths", "productPaths", "workspaceDigest", "summary"],
    properties: {
      evidenceId: { type: "string", pattern: "^evidence-[a-f0-9]{64}$" },
      level: { const: "trusted" },
      phase: { enum: ["red", "green"] },
      taskId: { type: "string", pattern: workItemIdPattern },
      stepId: { type: "string", pattern: stepInstanceIdPattern },
      commandId: { type: "string", pattern: idPattern },
      commandDigest: { type: "string", pattern: digestPattern },
      exitCode: { type: "integer" },
      failedTests: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
      testPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
      testFiles: {
        type: "array", minItems: 1, items: {
          type: "object", additionalProperties: false, required: ["path", "digest"],
          properties: { path: { type: "string", minLength: 1 }, digest: { type: "string", pattern: digestPattern } },
        },
      },
      testPathsDigest: { type: "string", pattern: digestPattern },
      testPathRules: { type: "array", minItems: 1, uniqueItems: true, items: testPathRuleSchema },
      testAssets: {
        type: "array", minItems: 1, items: {
          type: "object", additionalProperties: false, required: ["path", "digest"],
          properties: { path: { type: "string", minLength: 1 }, digest: { type: "string", pattern: digestPattern } },
        },
      },
      testAssetsDigest: { type: "string", pattern: digestPattern },
      testAssetPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
      productPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
      workspaceDigest: { type: "string", pattern: digestPattern },
      summary: { type: "string", maxLength: 8192 },
    },
  },
  "builtin.tdd-cycle-evidence.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.tdd-cycle-evidence.v1",
    type: "object",
    additionalProperties: false,
    required: ["taskId", "testPaths", "testPathRules", "testAssets", "testAssetsDigest", "testAssetPaths", "productPaths", "commandId", "redEvidenceId", "greenEvidenceId"],
    properties: {
      taskId: { type: "string", pattern: workItemIdPattern },
      testPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
      testPathRules: { type: "array", minItems: 1, uniqueItems: true, items: testPathRuleSchema },
      testAssets: {
        type: "array", minItems: 1, items: {
          type: "object", additionalProperties: false, required: ["path", "digest"],
          properties: { path: { type: "string", minLength: 1 }, digest: { type: "string", pattern: digestPattern } },
        },
      },
      testAssetsDigest: { type: "string", pattern: digestPattern },
      testAssetPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
      productPaths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
      commandId: { type: "string", pattern: idPattern },
      redEvidenceId: { type: "string", pattern: "^evidence-[a-f0-9]{64}$" },
      greenEvidenceId: { type: "string", pattern: "^evidence-[a-f0-9]{64}$" },
      refactorEvidenceId: { type: "string", pattern: "^evidence-[a-f0-9]{64}$" },
    },
  },
  "builtin.external-receipt.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.external-receipt.v1",
    type: "object",
    additionalProperties: false,
    required: ["version", "kind", "target", "stableId", "externalWorkItemId", "publishedContentDigest", "readBackContentDigest", "status", "readBackStatus"],
    properties: {
      version: { const: 1 },
      kind: { const: "external-receipt" },
      target: { enum: ["issue", "knowledge"] },
      stableId: { type: "string", minLength: 1 },
      externalWorkItemId: { type: "string", minLength: 1 },
      publishedContentDigest: { type: "string", pattern: digestPattern },
      readBackContentDigest: { type: "string", pattern: digestPattern },
      status: { const: "confirmed" },
      readBackStatus: { enum: ["confirmed", "stale", "failed"] },
    },
  },
  "builtin.tdd-node-test-report.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.tdd-node-test-report.v1",
    type: "object",
    additionalProperties: false,
    required: ["version", "adapter", "summary", "failureTotal", "truncated", "failures"],
    properties: {
      version: { const: 1 },
      adapter: { const: "node-test" },
      summary: {
        type: "object", additionalProperties: false,
        required: ["success", "tests", "passed", "failed", "cancelled", "skipped", "todo"],
        properties: {
          success: { type: "boolean" }, tests: { type: "integer", minimum: 0 }, passed: { type: "integer", minimum: 0 },
          failed: { type: "integer", minimum: 0 }, cancelled: { type: "integer", minimum: 0 }, skipped: { type: "integer", minimum: 0 },
          todo: { type: "integer", minimum: 0 },
        },
      },
      failureTotal: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
      failures: {
        type: "array", maxItems: 100, items: {
          type: "object", additionalProperties: false, required: ["name", "file", "kind"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 512 }, file: { type: "string", minLength: 1 },
            kind: { enum: ["assertion", "syntax", "dependency", "other"] },
          },
        },
      },
    },
  },
  "builtin.artifact.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.artifact.v1",
    type: "object",
    additionalProperties: false,
    required: ["artifactType", "schemaVersion", "workItemId", "stageId", "attemptId", "revision", "contentHash"],
    properties: {
      artifactType: { type: "string", pattern: idPattern },
      schemaVersion: { const: 1 },
      workItemId: { type: "string", pattern: workItemIdPattern },
      stageId: { type: "string", pattern: stepInstanceIdPattern },
      attemptId: { type: "string", pattern: "^attempt-.+$" },
      revision: { type: "integer", minimum: 1 },
      contentHash: { type: "string", pattern: digestPattern },
    },
  },
} as Record<SchemaId, JsonSchema>;
