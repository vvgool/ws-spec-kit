export const schemaIds = [
  "builtin.workflow-selection.v1",
  "builtin.application-project-config.v1",
  "builtin.application-project-config-snapshot.v1",
  "builtin.source-artifact.v1",
  "builtin.work-item.v1",
  "builtin.application-start-input.v1",
  "builtin.application-acquire-input.v1",
  "builtin.application-artifact-create-input.v1",
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
  "builtin.external-binding.v1",
  "builtin.external-receipt.v1",
  "builtin.external-action-request.v1",
  "builtin.external-action-grant.v1",
  "builtin.external-write-receipt.v1",
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
    outputId: { type: "string", pattern: idPattern },
    artifactId: { type: "string", minLength: 1, maxLength: 128 },
    schemaVersion: { type: "integer", minimum: 1 },
    path: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    contentHash: { type: "string", pattern: digestPattern },
    mediaType: { type: "string" },
    contentLevel: { type: "string", minLength: 1 },
  },
};

const artifactExpectationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifactType", "schemaVersion"],
  properties: {
    artifactType: { type: "string", pattern: idPattern },
    outputId: { type: "string", pattern: idPattern },
    schemaVersion: { type: "integer", minimum: 1 },
    contentLevel: { type: "string", minLength: 1 },
  },
};

const sourceMetadataSchema = (keys: string[]): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  maxProperties: 16,
  properties: Object.fromEntries(keys.map((key) => [key, {
    oneOf: [
      { type: "string", minLength: 1, maxLength: 256 },
      { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 256 } },
    ],
  }])),
});

const sourceArtifactSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "artifactType", "schemaVersion", "artifactId", "type", "stableId", "title", "body", "metadata", "contentDigest"],
  properties: {
    version: { const: 1 },
    artifactType: { const: "requirement-source" },
    schemaVersion: { const: 1 },
    artifactId: { type: "string", pattern: "^source-[a-f0-9]{64}$" },
    type: { enum: ["user.prompt", "local.file", "github.issue", "gitlab.issue", "feishu.document"] },
    stableId: { type: "string", minLength: 1, maxLength: 512 },
    canonicalUrl: { type: "string", format: "uri", maxLength: 2048 },
    title: { type: "string", minLength: 1, maxLength: 512 },
    body: { type: "string", minLength: 1, maxLength: 524288 },
    updatedAt: { type: "string", format: "date-time" },
    metadata: { type: "object" },
    contentDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
  },
  allOf: [
    { if: { properties: { type: { enum: ["user.prompt", "local.file"] } }, required: ["type"] }, then: { properties: { metadata: sourceMetadataSchema([]) } } },
    { if: { properties: { type: { enum: ["github.issue", "gitlab.issue"] } }, required: ["type"] }, then: { properties: { metadata: sourceMetadataSchema(["assignees", "author", "labels", "repository", "state"]) } } },
    { if: { properties: { type: { const: "feishu.document" } }, required: ["type"] }, then: { properties: { metadata: sourceMetadataSchema(["owner", "revision", "space"]) } } },
  ],
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

const strictDigestSchema = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const;
const externalTargetSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "stableId"],
  properties: {
    kind: { enum: ["repository", "issue", "knowledge"] },
    stableId: { type: "string", minLength: 1, maxLength: 4096 },
  },
};

const externalActionIdentityProperties = {
  requestId: { type: "string", pattern: "^external-request-[a-f0-9]{64}$" },
  requestDigest: strictDigestSchema,
  workItemId: { type: "string", pattern: workItemIdPattern },
  stepId: { type: "string", pattern: stepInstanceIdPattern },
  attemptId: { type: "string", pattern: attemptIdPattern },
  provider: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
  action: { enum: ["git.commit", "issue.update", "knowledge.publish", "issue.close"] },
  securityClass: { enum: ["local-write", "external-write"] },
  target: externalTargetSchema,
  externalEffectKind: { const: "issue.comment" },
  payloadDigest: strictDigestSchema,
  expectedContentDigest: strictDigestSchema,
  payloadArtifactDigest: strictDigestSchema,
  bindingDigest: strictDigestSchema,
  inputDigest: strictDigestSchema,
  artifactDigests: { type: "array", uniqueItems: true, items: strictDigestSchema },
  idempotencyKey: { type: "string", pattern: "^external:[a-f0-9]{64}$" },
  profile: { enum: ["quick", "standard", "governed"] },
  profileDigest: strictDigestSchema,
  workspaceDigest: strictDigestSchema,
  configDigest: strictDigestSchema,
} as const;

const governedActionConditions: JsonSchema[] = [
  {
    if: { properties: { externalEffectKind: { const: "issue.comment" } }, required: ["externalEffectKind"] },
    then: { properties: {
      action: { const: "issue.update" },
      securityClass: { const: "external-write" },
      target: { type: "object", properties: { kind: { const: "issue" } } },
    } },
  },
  {
    if: { properties: { action: { const: "knowledge.publish" } }, required: ["action"] },
    then: { properties: {
      securityClass: { const: "external-write" },
      target: { type: "object", properties: { kind: { const: "knowledge" } } },
    } },
  },
  {
    if: { properties: { action: { enum: ["issue.update", "issue.close"] } }, required: ["action"] },
    then: { properties: {
      securityClass: { const: "external-write" },
      target: { type: "object", properties: { kind: { const: "issue" } } },
    } },
  },
  {
    if: { properties: { action: { const: "git.commit" } }, required: ["action"] },
    then: { properties: {
      provider: { const: "git-native" },
      securityClass: { const: "local-write" },
      target: { type: "object", properties: { kind: { const: "repository" } } },
    } },
  },
];

const governedReceiptConditions: JsonSchema[] = [
  {
    if: { properties: { externalEffectKind: { const: "issue.comment" } }, required: ["externalEffectKind"] },
    then: {
      properties: { externalEffectId: { type: "string", pattern: "^(?:github-comment|gitlab-note):[1-9][0-9]{0,15}$" } },
      required: ["externalEffectId"],
    },
    else: { properties: { externalEffectId: false } },
  },
  {
    if: { properties: { action: { const: "knowledge.publish" } }, required: ["action"] },
    then: { properties: { target: { type: "object", properties: { kind: { const: "knowledge" } } } } },
  },
  {
    if: { properties: { action: { enum: ["issue.update", "issue.close"] } }, required: ["action"] },
    then: { properties: { target: { type: "object", properties: { kind: { const: "issue" } } } } },
  },
  {
    if: { properties: { action: { const: "git.commit" } }, required: ["action"] },
    then: { properties: {
      provider: { const: "git-native" },
      target: { type: "object", properties: { kind: { const: "repository" } } },
    } },
  },
];

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
    requiredOutputs: { type: "array", items: artifactExpectationSchema },
    artifactAuthoring: {
      type: "object", additionalProperties: false, required: ["version", "maxContentBytes", "draftRoots"],
      properties: {
        version: { const: 1 },
        maxContentBytes: { type: "integer", minimum: 1, maximum: 1_048_576 },
        draftRoots: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
      },
    },
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
        properties: {
          targets: {
            type: "object",
            additionalProperties: false,
            properties: {
              knowledge: {
                type: "object",
                additionalProperties: false,
                required: ["provider", "document"],
                properties: {
                  provider: { const: "feishu" },
                  document: { type: "string", minLength: 1, maxLength: 2048 },
                },
              },
            },
          },
        },
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
  "builtin.source-artifact.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.source-artifact.v1",
    ...sourceArtifactSchema,
  },
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
        required: ["type", "artifactId", "snapshot", "contentDigest", "artifactDigest"],
        properties: {
          type: { enum: ["user.prompt", "local.file", "github.issue", "gitlab.issue", "feishu.document"] },
          artifactId: { type: "string", pattern: "^source-[a-f0-9]{64}$" },
          snapshot: { type: "string", minLength: 1 },
          contentDigest: { type: "string", pattern: digestPattern },
          artifactDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
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
  "builtin.application-artifact-create-input.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.application-artifact-create-input.v1",
    type: "object", additionalProperties: false,
    required: ["root", "workItemId", "stepId", "attemptId", "leaseToken", "artifactType", "contentFile"],
    properties: {
      root: { type: "string", minLength: 1 }, workItemId: { type: "string", pattern: workItemIdPattern },
      stepId: { type: "string", pattern: stepInstanceIdPattern }, attemptId: { type: "string", pattern: attemptIdPattern },
      leaseToken: { type: "string", minLength: 1 }, artifactType: { type: "string", pattern: idPattern },
      outputId: { type: "string", pattern: idPattern }, contentFile: { type: "string", minLength: 1 },
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
      {
        type: "object", additionalProperties: false,
        required: ["kind", "root", "workItemId", "requestId", "decision", "expectedDigest", "actor"],
        properties: {
          kind: { const: "external_action" }, root: { type: "string", minLength: 1 },
          workItemId: { type: "string", pattern: workItemIdPattern }, requestId: { type: "string", minLength: 1 },
          decision: { enum: ["approved", "rejected"] }, expectedDigest: { type: "string", pattern: digestPattern },
          actor: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object", additionalProperties: false,
        required: ["kind", "root", "workItemId", "requestId", "decision", "expectedDigest", "actor"],
        properties: {
          kind: { const: "external_reconciliation" }, root: { type: "string", minLength: 1 },
          workItemId: { type: "string", pattern: workItemIdPattern }, requestId: { type: "string", minLength: 1 },
          decision: { const: "reconcile" }, expectedDigest: strictDigestSchema,
          actor: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object", additionalProperties: false,
        required: ["kind", "root", "workItemId", "requestId", "decision", "expectedDigest", "evidence", "actor"],
        properties: {
          kind: { const: "external_reconciliation" }, root: { type: "string", minLength: 1 },
          workItemId: { type: "string", pattern: workItemIdPattern }, requestId: { type: "string", minLength: 1 },
          decision: { const: "mark_failed" }, expectedDigest: strictDigestSchema,
          evidence: { type: "string", minLength: 1, maxLength: 2048 },
          actor: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object", additionalProperties: false,
        required: ["kind", "root", "workItemId", "requestId", "decision", "expectedDigest", "externalStableId", "contentDigest", "evidence", "actor"],
        properties: {
          kind: { const: "external_reconciliation" }, root: { type: "string", minLength: 1 },
          workItemId: { type: "string", pattern: workItemIdPattern }, requestId: { type: "string", minLength: 1 },
          decision: { const: "adopt_verified" }, expectedDigest: strictDigestSchema,
          externalStableId: { type: "string", minLength: 1, maxLength: 2048 },
          contentDigest: strictDigestSchema,
          evidence: { type: "string", minLength: 1, maxLength: 2048 },
          actor: { type: "string", minLength: 1 },
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
            oneOf: [
              ...(["step", "workflow_trust"] as const).map((kind) => ({
                type: "object", additionalProperties: false,
                required: ["kind", "requestId", "workItemId", "title", "digest"],
                properties: {
                  kind: { const: kind }, requestId: { type: "string", minLength: 1 },
                  workItemId: { type: "string", pattern: workItemIdPattern }, title: { type: "string", minLength: 1 },
                  digest: { type: "string", pattern: digestPattern },
                },
              })),
              {
                type: "object", additionalProperties: false,
                required: ["kind", "requestId", "workItemId", "title", "digest", "provider", "action", "target", "sideEffects"],
                properties: {
                  kind: { const: "external_action" }, requestId: { type: "string", minLength: 1 },
                  workItemId: { type: "string", pattern: workItemIdPattern }, title: { type: "string", minLength: 1 },
                  digest: { type: "string", pattern: digestPattern },
                  provider: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
                  action: externalActionIdentityProperties.action,
                  target: externalTargetSchema,
                  sideEffects: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
                },
              },
            ],
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
    required: ["evidenceId", "level", "phase", "taskId", "stepId", "commandId", "commandDigest", "exitCode", "failedTests", "testPaths", "testFiles", "testPathsDigest", "testPathRules", "testAssets", "testAssetsDigest", "testAssetPaths", "testAssetRoots", "productPaths", "workspaceDigest", "summary"],
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
      testAssetRoots: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
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
    required: ["taskId", "testPaths", "testPathRules", "testAssets", "testAssetsDigest", "testAssetPaths", "testAssetRoots", "productPaths", "commandId", "redEvidenceId", "greenEvidenceId"],
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
      testAssetRoots: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1024 } },
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
    required: ["version", "kind", "target", "stableId", "externalWorkItemId", "publishStepId", "publishAttemptId", "publishInputDigest", "publishedContentDigest", "readBackContentDigest", "status", "readBackStatus"],
    properties: {
      version: { const: 1 },
      kind: { const: "external-receipt" },
      target: { enum: ["issue", "knowledge"] },
      stableId: { type: "string", minLength: 1 },
      externalEffectKind: { const: "issue.comment" },
      externalEffectId: { type: "string", pattern: "^(?:github-comment|gitlab-note):[1-9][0-9]{0,15}$" },
      externalWorkItemId: { type: "string", minLength: 1 },
      publishStepId: { type: "string", pattern: stepInstanceIdPattern },
      publishAttemptId: { type: "string", pattern: attemptIdPattern },
      publishInputDigest: { type: "string", pattern: digestPattern },
      publishedContentDigest: { type: "string", pattern: digestPattern },
      readBackContentDigest: { type: "string", pattern: digestPattern },
      status: { const: "confirmed" },
      readBackStatus: { enum: ["confirmed", "stale", "failed"] },
    },
    allOf: [{
      if: { properties: { externalEffectKind: { const: "issue.comment" } }, required: ["externalEffectKind"] },
      then: {
        properties: { externalEffectId: { type: "string", pattern: "^(?:github-comment|gitlab-note):[1-9][0-9]{0,15}$" } },
        required: ["externalEffectId"],
      },
      else: { properties: { externalEffectId: false } },
    }],
  },
  "builtin.external-binding.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "builtin.external-binding.v1",
    type: "object",
    additionalProperties: false,
    required: ["version", "kind", "target", "exists", "stableId", "externalWorkItemId", "publishStepId", "publishAttemptId", "publishInputDigest", "expectedPublishedContentDigest"],
    properties: {
      version: { const: 1 },
      kind: { const: "external-binding" },
      target: { enum: ["issue", "knowledge"] },
      exists: { const: true },
      stableId: { type: "string", minLength: 1 },
      externalWorkItemId: { type: "string", minLength: 1 },
      publishStepId: { type: "string", pattern: stepInstanceIdPattern },
      publishAttemptId: { type: "string", pattern: attemptIdPattern },
      publishInputDigest: { type: "string", pattern: digestPattern },
      expectedPublishedContentDigest: { type: "string", pattern: digestPattern },
    },
  },
  "builtin.external-action-request.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.external-action-request.v1",
    type: "object", additionalProperties: false,
    required: ["version", "requestId", "workItemId", "stepId", "attemptId", "provider", "action", "securityClass", "target", "payloadDigest", "expectedContentDigest", "payloadArtifactDigest", "bindingDigest", "inputDigest", "artifactDigests", "idempotencyKey", "profile", "profileDigest", "workspaceDigest", "configDigest", "sideEffects", "createdAt", "expiresAt", "requestDigest"],
    properties: {
      version: { const: 1 }, ...externalActionIdentityProperties,
      sideEffects: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
      createdAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" },
    },
    allOf: governedActionConditions,
  },
  "builtin.external-action-grant.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.external-action-grant.v1",
    type: "object", additionalProperties: false,
    required: ["version", "grantId", "requestId", "requestDigest", "workItemId", "stepId", "attemptId", "provider", "action", "securityClass", "target", "payloadDigest", "expectedContentDigest", "payloadArtifactDigest", "bindingDigest", "inputDigest", "artifactDigests", "idempotencyKey", "actor", "approvalDigest", "profile", "profileDigest", "workspaceDigest", "configDigest", "decidedAt", "expiresAt", "grantDigest"],
    properties: {
      version: { const: 1 }, grantId: { type: "string", pattern: "^external-grant-[a-f0-9]{64}$" }, ...externalActionIdentityProperties,
      actor: { type: "string", minLength: 1, maxLength: 256 }, approvalDigest: strictDigestSchema,
      decidedAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" }, grantDigest: strictDigestSchema,
    },
    allOf: governedActionConditions,
  },
  "builtin.external-write-receipt.v1": {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "builtin.external-write-receipt.v1",
    type: "object", additionalProperties: false,
    required: ["version", "kind", "requestId", "requestDigest", "grantDigest", "workItemId", "stepId", "attemptId", "provider", "action", "target", "payloadDigest", "expectedContentDigest", "bindingDigest", "inputDigest", "artifactDigests", "idempotencyKey", "publishedContentDigest", "readBackContentDigest", "status", "verifiedAt"],
    properties: {
      version: { const: 1 }, kind: { const: "external-write-receipt" },
      requestId: externalActionIdentityProperties.requestId, requestDigest: strictDigestSchema, grantDigest: strictDigestSchema,
      workItemId: externalActionIdentityProperties.workItemId, stepId: externalActionIdentityProperties.stepId,
      attemptId: externalActionIdentityProperties.attemptId, provider: externalActionIdentityProperties.provider,
      action: externalActionIdentityProperties.action, target: externalTargetSchema, payloadDigest: strictDigestSchema,
      externalEffectKind: externalActionIdentityProperties.externalEffectKind,
      externalEffectId: { type: "string", pattern: "^(?:github-comment|gitlab-note):[1-9][0-9]{0,15}$" },
      expectedContentDigest: strictDigestSchema,
      bindingDigest: strictDigestSchema, inputDigest: strictDigestSchema, artifactDigests: externalActionIdentityProperties.artifactDigests,
      idempotencyKey: externalActionIdentityProperties.idempotencyKey,
      publishedContentDigest: strictDigestSchema, readBackContentDigest: strictDigestSchema,
      status: { const: "verified" }, verifiedAt: { type: "string", format: "date-time" },
    },
    allOf: governedReceiptConditions,
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
      outputId: { type: "string", pattern: idPattern },
      schemaVersion: { const: 1 },
      workItemId: { type: "string", pattern: workItemIdPattern },
      stageId: { type: "string", pattern: stepInstanceIdPattern },
      attemptId: { type: "string", pattern: "^attempt-.+$" },
      revision: { type: "integer", minimum: 1 },
      contentHash: { type: "string", pattern: digestPattern },
    },
  },
} as Record<SchemaId, JsonSchema>;
