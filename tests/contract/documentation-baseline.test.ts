import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { parseSkillLock } from "../../src/registry/skills/lock.js";
import { validate, type SchemaId } from "../../src/schemas/index.js";
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
const publicErrorSources = [
  "src/adapters/cli/output.ts",
  "src/cli/commands/core.ts",
  "src/application/start.ts",
  "src/application/acquire.ts",
  "src/application/submit.ts",
  "src/application/decide.ts",
  "src/application/inspect.ts",
  "src/schemas/index.ts",
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

function examples(document: string): Array<{ language: "json" | "yaml"; contract: string; value: string }> {
  return [...document.matchAll(/^```(json|yaml) contract=([^\s]+)\n([\s\S]*?)^```$/gmu)].map((match) => ({
    language: match[1]! as "json" | "yaml",
    contract: match[2]!,
    value: match[3]!,
  }));
}

function commands(cliMain: string): string[] {
  return [...cliMain.matchAll(/"wspec ([^"]+)"/gu)].map((match) => {
    const words = match[1]!.split(" ");
    return words[0] === "agent" ? "agent install" : words[0]!;
  });
}

function applicationOperations(protocol: string): Array<{ name: string; result: string }> {
  return [...protocol.matchAll(/^  ([a-z]+)\(input: [A-Za-z]+\): Promise<([A-Za-z]+)>;/gmu)]
    .map((match) => ({ name: match[1]!, result: match[2]! }));
}

async function publicErrorCodes(): Promise<string[]> {
  const sources = await Promise.all(publicErrorSources.map(async (filename) => readFile(path.join(root, filename), "utf8")));
  return [...new Set(sources.flatMap((source) => [...source.matchAll(/WSSPEC_[A-Z_]+/gu)].map((match) => match[0])))].sort();
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
  const [cliMain, protocol] = await Promise.all([
    readFile(path.join(root, "src/cli/main.ts"), "utf8"),
    readFile(path.join(root, "src/protocol/application.ts"), "utf8"),
  ]);
  for (const value of [...schemaIds, ...commands(cliMain)]) assert.match(applicationReference, new RegExp(escapeRegularExpression(value), "u"), value);
  for (const operation of applicationOperations(protocol)) {
    const pattern = ["### `", operation.name, "`[\\s\\S]*?输入[\\s\\S]*?输出[\\s\\S]*?`", operation.result, "`"].join("");
    assert.match(applicationReference, new RegExp(pattern, "u"), operation.name);
  }

  const workflowReferences = `${reference.workflow}\n${reference.connectors}`;
  for (const value of ["builtin://workflows/feature-delivery", "builtin://workflows/documentation-delivery", "package://skills/"]) assert.match(workflowReferences, new RegExp(escapeRegularExpression(value), "u"), value);

  const resourceFiles = await files(path.join(root, "resources"));
  const skillUris = new Set<string>();
  for (const filename of resourceFiles.filter((entry) => entry.endsWith(".yaml"))) {
    for (const match of (await readFile(filename, "utf8")).matchAll(/builtin:\/\/skills\/[a-z0-9-]+/gu)) skillUris.add(match[0]);
  }
  for (const uri of skillUris) assert.match(reference.skills, new RegExp(escapeRegularExpression(uri), "u"), uri);
  for (const code of await publicErrorCodes()) assert.match(`${reference.application}\n${reference.workflow}\n${reference.skills}\n${reference.connectors}`, new RegExp(code, "u"), code);
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
        parseProfileV1(value);
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
