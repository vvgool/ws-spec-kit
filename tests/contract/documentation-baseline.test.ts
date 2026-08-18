import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { errorOutput } from "../../src/adapters/cli/output.js";
import { parseSkillLock } from "../../src/registry/skills/lock.js";
import { publicCliRouteDescriptors, publicCommandDescriptors } from "../../src/cli/commands/public-contract.js";
import { publicRouteCommands } from "../../src/cli/commands/core.js";
import { compileWorkflow } from "../../src/engine/compiler.js";
import {
  applicationInternalError,
  applicationPublicErrorCodes,
  applicationPublicErrorCodesByRoute,
  applicationPublicErrorGroupNamesByRoute,
  applicationPublicErrorGroups,
  publicCliErrorRoutes,
  publicCliRoutes,
} from "../../src/protocol/public-contract.js";
import { validate, type SchemaId } from "../../src/schemas/index.js";
import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";
import type { WorkflowStep } from "../../src/workflow-package/types.js";
import { parseProfileV1, parseWorkflowV1 } from "../../src/workflow-package/workflow-v1.js";

const root = path.resolve(import.meta.dirname, "../..");
const legacyDocuments = [
  "docs/specs/2026-08-16-wiesen-spec-kit-requirements.md",
  "docs/specs/2026-08-16-wiesen-spec-kit-design.md",
  "docs/reference/artifacts-v1.md",
  "docs/reference/execution-contracts-v1.md",
  "docs/reference/project-config-v1.md",
  "docs/reference/state-transitions-v1.md",
  "docs/reference/work-item-v1.md",
  "docs/reference/workflow-language-v1.md",
  "docs/plans/2026-08-16-m1-control-plane-hardening-plan.md",
  "docs/plans/2026-08-16-m1-implementation-plan.md",
  "docs/plans/2026-08-16-protocol-hardening-plan.md",
] as const;
const referenceDocuments = {
  application: "docs/reference/application-protocol.md",
  workflow: "docs/reference/workflow-language.md",
  skills: "docs/reference/skill-resolution.md",
  connectors: "docs/reference/connector-contracts.md",
} as const;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  }));
  return nested.flat();
}

async function documents(): Promise<Record<keyof typeof referenceDocuments, string>> {
  const entries = await Promise.all(Object.entries(referenceDocuments).map(async ([key, relative]) => [key, await readFile(path.join(root, relative), "utf8")] as const));
  return Object.fromEntries(entries) as Record<keyof typeof referenceDocuments, string>;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function examples(document: string): Array<{ language: "json" | "yaml"; contract: string; value: string }> {
  return [...document.matchAll(/^```(json|yaml) contract=([^\s]+)\n([\s\S]*?)^```$/gmu)].map((match) => ({
    language: match[1]! as "json" | "yaml",
    contract: match[2]!,
    value: match[3]!,
  }));
}

function applicationOperations(protocol: string): Array<{ name: string; result: string }> {
  return [...protocol.matchAll(/^  ([a-z]+)\(input: [A-Za-z]+\): Promise<([A-Za-z]+)>;/gmu)]
    .map((match) => ({ name: match[1]!, result: match[2]! }));
}

function operationSection(document: string, operation: string): string {
  const heading = `### \`${operation}\``;
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, `缺少 ${operation} 章节`);
  const contentStart = start + heading.length;
  const next = document.indexOf("\n### ", contentStart);
  return document.slice(contentStart, next === -1 ? undefined : next);
}

function allSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [step, ...allSteps(step.steps ?? [])]);
}

function documentedErrorCodes(reference: Record<keyof typeof referenceDocuments, string>): string[] {
  return [...new Set(Object.values(reference).flatMap((document) => [...document.matchAll(/WSSPEC_[A-Z_]+/gu)].map((match) => match[0])))].sort();
}

function assertErrorCatalogMatchesDocumentation(reference: Record<keyof typeof referenceDocuments, string>): void {
  assert.deepEqual(documentedErrorCodes(reference), [...applicationPublicErrorCodes].sort());
}

function tableSection(document: string, heading: string): string {
  const marker = `### ${heading}`;
  const start = document.indexOf(marker);
  assert.notEqual(start, -1, `缺少 ${heading} 章节`);
  const contentStart = start + marker.length;
  const next = document.indexOf("\n### ", contentStart);
  return document.slice(contentStart, next === -1 ? undefined : next);
}

function tableRows(section: string): Map<string, string[]> {
  return new Map([...section.matchAll(/^\| `([^`]+)` \| ([^|]+) \|$/gmu)].map((match) => [
    match[1]!,
    [...match[2]!.matchAll(/`([^`]+)`/gu)].map((entry) => entry[1]!),
  ]));
}

async function cliReachableProductionSources(): Promise<string[]> {
  const seen = new Set<string>();
  const visit = async (filename: string): Promise<void> => {
    if (seen.has(filename) || filename === path.join(root, "src/protocol/public-contract.ts")) return;
    seen.add(filename);
    const source = await readFile(filename, "utf8");
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/gu)) {
      const imported = path.resolve(path.dirname(filename), match[1]!.replace(/\.js$/u, ".ts"));
      try {
        await visit(imported);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  await visit(path.join(root, "src/cli/main.ts"));
  return [...seen].sort();
}

async function cliReachableTypedErrorCodes(): Promise<string[]> {
  const codes = new Set<string>([applicationInternalError.code]);
  for (const filename of await cliReachableProductionSources()) {
    for (const match of (await readFile(filename, "utf8")).matchAll(/WSSPEC_[A-Z][A-Z0-9_]*/gu)) codes.add(match[0]);
  }
  return [...codes].sort();
}

test("公开参考替换旧协议文档，并覆盖生成 Schema、CLI、Skill URI 与错误码", async () => {
  for (const filename of legacyDocuments) await assert.rejects(access(path.join(root, filename)), /ENOENT/u, filename);
  for (const filename of Object.values(referenceDocuments)) await access(path.join(root, filename));

  const reference = await documents();
  const schemas = await Promise.all((await readdir(path.join(root, "schemas")))
    .filter((filename) => filename.endsWith(".json"))
    .map(async (filename) => JSON.parse(await readFile(path.join(root, "schemas", filename), "utf8")) as { $id: string }));
  const schemaIds = schemas.map(({ $id }) => $id).sort();
  const applicationReference = reference.application;
  const protocol = await readFile(path.join(root, "src/protocol/application.ts"), "utf8");
  assert.deepEqual([...publicCommandDescriptors.map(({ command }) => command)].sort(), [...publicRouteCommands].sort());
  assert.deepEqual([...publicCliRouteDescriptors.map(({ route }) => route)].sort(), [...publicCliRoutes].sort());
  for (const value of [...schemaIds, ...publicCommandDescriptors.map(({ command }) => command)]) assert.match(applicationReference, new RegExp(escapeRegularExpression(value), "u"), value);
  for (const operation of applicationOperations(protocol)) {
    const section = operationSection(applicationReference, operation.name);
    assert.match(section, /输入/u, operation.name);
    assert.match(section, new RegExp(["输出：`", operation.result, "`"].join(""), "u"), operation.name);
  }

  const workflowReferences = `${reference.workflow}\n${reference.connectors}`;
  for (const value of ["builtin://workflows/feature-delivery", "builtin://workflows/documentation-delivery", "package://skills/"]) assert.match(workflowReferences, new RegExp(escapeRegularExpression(value), "u"), value);

  const resourceFiles = await files(path.join(root, "resources"));
  const skillUris = new Set<string>();
  for (const filename of resourceFiles.filter((entry) => entry.endsWith(".yaml"))) {
    for (const match of (await readFile(filename, "utf8")).matchAll(/builtin:\/\/skills\/[a-z0-9-]+/gu)) skillUris.add(match[0]);
  }
  for (const uri of skillUris) assert.match(reference.skills, new RegExp(escapeRegularExpression(uri), "u"), uri);
  assertErrorCatalogMatchesDocumentation(reference);
});

test("操作章节不能借用下一章节的输出类型", async () => {
  const document = (await documents()).application;
  const mutated = document.replace("### `acquire`\n\n输入：`AcquireInput`，对应 `builtin.application-acquire-input.v1`，包含 `root`、`workItemId` 与必填 `actor`。输出：`AgentAction`。", "### `acquire`\n\n输入：`AcquireInput`，对应 `builtin.application-acquire-input.v1`，包含 `root`、`workItemId` 与必填 `actor`。");
  assert.doesNotMatch(operationSection(mutated, "acquire"), /输出：`AgentAction`/u);
});

test("公开错误码文档拒绝缺失或多余条目", async () => {
  const reference = await documents();
  assertErrorCatalogMatchesDocumentation(reference);
  assert.throws(() => assertErrorCatalogMatchesDocumentation(Object.fromEntries(Object.entries(reference).map(([name, document]) => [name, document.replaceAll("WSSPEC_APPROVAL_DIGEST_MISMATCH", "")])) as typeof reference));
  assert.throws(() => assertErrorCatalogMatchesDocumentation({ ...reference, application: `${reference.application}\nWSSPEC_UNREGISTERED_DOCUMENT_CODE` }));
});

test("CLI typed error、逐路由目录与公开文档保持双向覆盖", async () => {
  const reachableCodes = await cliReachableTypedErrorCodes();
  assert.deepEqual(reachableCodes, [...applicationPublicErrorCodes].sort());
  assert.equal(new Set(applicationPublicErrorCodes).size, applicationPublicErrorCodes.length);
  assert.deepEqual(Object.keys(applicationPublicErrorCodesByRoute).sort(), [...publicCliErrorRoutes].sort());
  assert.deepEqual(Object.keys(applicationPublicErrorGroupNamesByRoute).sort(), [...publicCliErrorRoutes].sort());

  const groupedCodes = [...new Set(Object.values(applicationPublicErrorGroups).flat())].sort();
  assert.deepEqual(groupedCodes, [...applicationPublicErrorCodes].sort());
  for (const route of publicCliErrorRoutes) {
    const expected = [...new Set(applicationPublicErrorGroupNamesByRoute[route].flatMap((group) => applicationPublicErrorGroups[group]))].sort();
    assert.deepEqual([...applicationPublicErrorCodesByRoute[route]].sort(), expected, route);
  }

  const document = (await documents()).application;
  const documentedGroups = tableRows(tableSection(document, "错误码分组"));
  assert.deepEqual([...documentedGroups.keys()].sort(), Object.keys(applicationPublicErrorGroups).sort());
  for (const [group, codes] of Object.entries(applicationPublicErrorGroups)) {
    assert.deepEqual(documentedGroups.get(group)?.sort(), [...codes].sort(), group);
  }
  const documentedRoutes = tableRows(tableSection(document, "CLI 路由错误合同"));
  assert.deepEqual([...documentedRoutes.keys()].sort(), [...publicCliErrorRoutes].sort());
  for (const route of publicCliErrorRoutes) {
    assert.deepEqual(documentedRoutes.get(route)?.sort(), [...applicationPublicErrorGroupNamesByRoute[route]].sort(), route);
  }
});

test("CLI 输出保留已注册的非 internal 错误码与中文消息", () => {
  assert.deepEqual(
    errorOutput(Object.assign(new Error("参数无效。"), { code: "WSSPEC_ARGUMENT_INVALID" })),
    { ok: false, error: { code: "WSSPEC_ARGUMENT_INVALID", message: "参数无效。" } },
  );
});

test("CLI 输出只在当前 route 的错误合同中透传领域错误", () => {
  const error = Object.assign(new Error("Work Item 不存在。"), { code: "WSSPEC_WORK_ITEM_NOT_FOUND" });

  assert.deepEqual(
    errorOutput(error, "inspect"),
    { ok: false, error: { code: "WSSPEC_WORK_ITEM_NOT_FOUND", message: "Work Item 不存在。" } },
  );
  assert.deepEqual(
    errorOutput(error, "agent install"),
    { ok: false, error: { code: "WSSPEC_INTERNAL_ERROR", message: "发生未预期的内部错误。" } },
  );
});

test("CLI 输出将所有 internal 与未知异常折叠为固定安全消息", () => {
  const expected = { ok: false, error: { code: "WSSPEC_INTERNAL_ERROR", message: "发生未预期的内部错误。" } };
  const cases: unknown[] = [
    Object.assign(new Error("internal credential=explicit-secret"), { code: "WSSPEC_INTERNAL_ERROR", stack: "stack explicit-secret", details: { credential: "explicit-secret" } }),
    Object.assign(new Error("unknown credential=wsspec-secret"), { code: "WSSPEC_UNREGISTERED", stack: "stack wsspec-secret", details: { credential: "wsspec-secret" } }),
    Object.assign(new Error("unknown credential=foreign-secret"), { code: "INTERNAL_DATABASE_FAILURE", stack: "stack foreign-secret", details: { credential: "foreign-secret" } }),
    new Error("ordinary credential=error-secret"),
    "non-error credential=string-secret",
    { message: "non-error credential=object-secret", stack: "stack object-secret", details: { credential: "object-secret" } },
  ];
  for (const error of cases) {
    assert.deepEqual(
      errorOutput(error),
      expected,
    );
  }
});

test("CLI 输出对已登记 rollback code 只使用固定安全消息", () => {
  const cases = [
    ["WSSPEC_WORK_ITEM_ROLLBACK_FAILED", "Work Item 创建失败且无法安全回滚。"],
    ["WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "Work Item 回滚被安全策略拒绝。"],
    ["WSSPEC_START_ROLLBACK_FAILED", "Start 失败且无法安全回滚新建 Work Item。"],
  ] as const;
  for (const [code, message] of cases) {
    const error = Object.assign(new Error("credential=rollback-secret /private/host stack details"), {
      code,
      stack: "stack rollback-secret",
      details: { credential: "rollback-secret" },
    });
    assert.deepEqual(errorOutput(error, "start"), { ok: false, error: { code, message } });
  }
  assert.deepEqual(
    errorOutput(Object.assign(new Error("credential=unregistered-secret"), { code: "WSSPEC_UNREGISTERED_ROLLBACK_FAILED" }), "start"),
    { ok: false, error: { code: "WSSPEC_INTERNAL_ERROR", message: "发生未预期的内部错误。" } },
  );
});

test("公开参考中的每个结构化示例都标注并通过正式契约", async () => {
  for (const [name, document] of Object.entries(await documents())) {
    const blocks = examples(document);
    assert.ok(blocks.length > 0, `${name} 缺少结构化示例`);
    assert.equal(blocks.length, [...document.matchAll(/^```(?:json|yaml)/gmu)].length, `${name} 存在未标注契约的示例`);
    for (const block of blocks) {
      const value = block.language === "json" ? JSON.parse(block.value) : parseYaml(block.value);
      assert.notEqual(value, undefined, `${name} 的 ${block.language} 示例为空`);
      if (block.contract.startsWith("schema:")) {
        validate(block.contract.slice("schema:".length) as SchemaId, value);
      } else if (block.contract === "workflow-v1") {
        assert.deepEqual(
          parseWorkflowV1(value),
          parseWorkflowV1(parseYaml(await readFile(path.join(root, "resources/workflows/documentation-delivery/workflow.yaml"), "utf8"))),
        );
      } else if (block.contract === "profile-v1") {
        const profile = parseProfileV1(value);
        const pkg = await loadWorkflowPackage({ root, ref: "builtin://workflows/documentation-delivery" });
        const workflow = parseWorkflowV1(parseYaml(await readFile(path.join(root, "resources/workflows/documentation-delivery/workflow.yaml"), "utf8")));
        const bindings = new Map(allSteps(workflow.steps).flatMap((step) => (step.skills ?? []).map((binding) => [binding.ref, binding])));
        const skills = [...bindings.values()].map((binding) => ({
          requestedRef: binding.ref, ref: binding.ref, source: "builtin" as const, provider: "generic" as const, rootId: "builtin", entrypoint: "/builtin/SKILL.md", digest: "sha256:documentation", candidates: [], required: binding.required ?? true, usedFallback: false,
        }));
        compileWorkflow({ ...pkg, profiles: new Map(pkg.profiles).set(profile.profile.id, profile) }, { id: profile.profile.id as "quick" | "standard" | "governed", skills }, { requiredGateIds: ["docs.integrity"], configuredGateIds: ["docs.integrity"] });
      } else if (block.contract === "skill-lock-v1") {
        parseSkillLock(value);
      } else if (block.contract === "builtin-documentation-manifest") {
        assert.deepEqual(value, parseYaml(await readFile(path.join(root, "resources/workflows/documentation-delivery/manifest.yaml"), "utf8")));
      } else if (block.contract === "normalized-requirement-source") {
        assert.deepEqual(Object.keys(value as object).sort(), ["body", "metadata", "stableId", "title", "type"]);
      } else if (block.contract === "connector-write-intent") {
        assert.deepEqual(Object.keys(value as object).sort(), ["action", "authorization", "readBack", "target"]);
      } else {
        assert.fail(`${name} 使用未知示例契约 ${block.contract}`);
      }
    }
  }
});

test("仓库生产面不保留旧产品名、旧 Schema 或旧命令", async () => {
  const terms = [
    ["Wiesen", "SpecKit"].join(""),
    ["wiesen", "-spec-kit"].join(""),
    ["WS", "K-"].join(""),
    ["WS", "PEC_"].join(""),
    ["builtin", ".stage-context"].join(""),
    ["builtin", ".stage-result"].join(""),
  ];
  const pattern = new RegExp(terms.map(escapeRegularExpression).join("|"), "u");
  const productionFiles = [path.join(root, "package.json"), ...await files(path.join(root, "src")), ...await files(path.join(root, "schemas")), ...await files(path.join(root, "resources"))];
  const matches = await Promise.all(productionFiles.map(async (filename) => ({ filename, content: await readFile(filename, "utf8") })));
  assert.deepEqual(matches.filter(({ content }) => pattern.test(content)).map(({ filename }) => path.relative(root, filename)), []);
});
