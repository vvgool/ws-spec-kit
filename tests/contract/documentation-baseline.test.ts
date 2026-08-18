import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

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
const publicCommands = ["init", "start", "acquire", "submit", "decide", "inspect", "workflow", "agent install"] as const;
const applicationOperations = ["start", "acquire", "submit", "decide", "inspect"] as const;
const publicErrorCodes = [
  "WSSPEC_COMMAND_UNKNOWN",
  "WSSPEC_ARGUMENT_REQUIRED",
  "WSSPEC_ARGUMENT_INVALID",
  "WSSPEC_SCHEMA_REQUIRED_FIELD",
  "WSSPEC_SCHEMA_UNKNOWN_FIELD",
  "WSSPEC_SCHEMA_INVALID_VALUE",
  "WSSPEC_SCHEMA_UNSUPPORTED_VERSION",
  "WSSPEC_WORKFLOW_TRUST_REQUIRED",
  "WSSPEC_WORKFLOW_TRUST_REJECTED",
  "WSSPEC_SKILL_NOT_FOUND",
  "WSSPEC_SKILL_AMBIGUOUS",
  "WSSPEC_SKILL_LOCK_CHANGED",
  "WSSPEC_SOURCE_TYPE_UNSUPPORTED",
  "WSSPEC_INTERACTIVE_TTY_REQUIRED",
] as const;

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

function examples(document: string): Array<{ language: "json" | "yaml"; value: string }> {
  return [...document.matchAll(/^```(json|yaml)\n([\s\S]*?)^```$/gmu)].map((match) => ({
    language: match[1]! as "json" | "yaml",
    value: match[2]!,
  }));
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
  for (const value of [...schemaIds, ...publicCommands, ...applicationOperations]) assert.match(applicationReference, new RegExp(escapeRegularExpression(value), "u"), value);

  const workflowReferences = `${reference.workflow}\n${reference.connectors}`;
  for (const value of ["builtin://workflows/feature-delivery", "builtin://workflows/documentation-delivery", "package://skills/"]) assert.match(workflowReferences, new RegExp(escapeRegularExpression(value), "u"), value);

  const resourceFiles = await files(path.join(root, "resources"));
  const skillUris = new Set<string>();
  for (const filename of resourceFiles.filter((entry) => entry.endsWith(".yaml"))) {
    for (const match of (await readFile(filename, "utf8")).matchAll(/builtin:\/\/skills\/[a-z0-9-]+/gu)) skillUris.add(match[0]);
  }
  for (const uri of skillUris) assert.match(reference.skills, new RegExp(escapeRegularExpression(uri), "u"), uri);
  for (const code of publicErrorCodes) assert.match(`${reference.application}\n${reference.workflow}\n${reference.skills}\n${reference.connectors}`, new RegExp(code, "u"), code);
});

test("公开参考中的 JSON 和 YAML 示例都可解析", async () => {
  for (const [name, document] of Object.entries(await documents())) {
    const blocks = examples(document);
    assert.ok(blocks.length > 0, `${name} 缺少结构化示例`);
    for (const block of blocks) {
      const value = block.language === "json" ? JSON.parse(block.value) : parseYaml(block.value);
      assert.notEqual(value, undefined, `${name} 的 ${block.language} 示例为空`);
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
