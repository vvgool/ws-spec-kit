import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";
import { lockWorkflowPackage } from "../../src/workflow-package/lock.js";
import { invalidProfileV1Fixtures, invalidWorkflowV1Fixtures, profileV1Fixture, workflowV1Fixture } from "../helpers/workflow-v1-fixtures.js";

async function packageFixture(root: string, id = "team-feature"): Promise<string> {
  const directory = path.join(root, ".wsspec", "workflows", id);
  await mkdir(path.join(directory, "profiles"), { recursive: true });
  await mkdir(path.join(directory, "skills", "review"), { recursive: true });
  await mkdir(path.join(directory, "schemas"), { recursive: true });
  await mkdir(path.join(directory, "templates"), { recursive: true });
  await writeFile(path.join(directory, "manifest.yaml"), [
    "version: 1",
    `id: ${id}`,
    "entry: workflow.yaml",
    "profiles: [standard]",
    "capabilities: [git, external-read]",
    "skills: [review]",
  ].join("\n") + "\n");
  await writeFile(path.join(directory, "workflow.yaml"), [
    "version: 1",
    "workflow:",
    `  id: ${id}`,
    "  version: 1",
    "inputs: {}",
    "steps:",
    "  - id: review",
    "    uses: agent.execute\n    workspace: read-only",
    "    skills:",
    "      - ref: package://skills/review",
    "        required: true",
    "gates: []",
    "changePolicy:",
    "  kind: feature",
    "  allowedPaths: ['**']",
  ].join("\n") + "\n");
  await writeFile(path.join(directory, "profiles", "standard.yaml"), `version: 1\nprofile:\n  id: standard\n  workflow: ${id}\nsteps: {}\npublishing:\n  issueRequired: false\n  knowledgeRequired: false\naudit:\n  level: standard\n`);
  await writeFile(path.join(directory, "skills", "review", "SKILL.md"), "# Review\n");
  await writeFile(path.join(directory, "schemas", "review.json"), "{\"type\":\"object\"}\n");
  await writeFile(path.join(directory, "templates", "review.md"), "# Template\n");
  return directory;
}

async function temporaryRoot(): Promise<string> {
  return path.join(os.tmpdir(), `wspec-workflow-package-${crypto.randomUUID()}`);
}

test("加载项目 Package 时收集已声明的内置 Skill 与可移植内容摘要", async () => {
  const root = await temporaryRoot();
  await packageFixture(root);

  const loaded = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  assert.equal(loaded.ref, "project://workflows/team-feature");
  assert.equal(loaded.manifest.id, "team-feature");
  assert.equal(loaded.workflow.workflow.id, "team-feature");
  assert.equal(loaded.profiles.get("standard")?.profile.id, "standard");
  assert.equal(loaded.packageSkills.get("package://skills/review")?.entrypoint.endsWith("/skills/review/SKILL.md"), true);
  assert.match(loaded.contentDigest, /^sha256:[a-f0-9]{64}$/);
});

test("Package Skill 的辅助内容变化会改变 Skill 和 Package 摘要", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await mkdir(path.join(directory, "skills", "review", "scripts"), { recursive: true });
  await mkdir(path.join(directory, "skills", "review", "references"), { recursive: true });
  await writeFile(path.join(directory, "skills", "review", "scripts", "review.sh"), "echo first\n");
  await writeFile(path.join(directory, "skills", "review", "references", "policy.md"), "first\n");
  const first = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  await writeFile(path.join(directory, "skills", "review", "scripts", "review.sh"), "echo second\n");
  const second = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  assert.notEqual(second.contentDigest, first.contentDigest);
  assert.notEqual(second.packageSkills.get("package://skills/review")?.digest, first.packageSkills.get("package://skills/review")?.digest);
  assert.ok(second.files.some((file) => file.path === "skills/review/scripts/review.sh"));
});

test("Skill 树的悬空链接必须 fail closed", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await symlink(path.join(root, "missing-target"), path.join(directory, "skills", "review", "dangling"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /ENOENT|WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/);
});

test("按设计稿原始完整形态加载 Workflow v1，并规范化可选顶层策略", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root, "feature-delivery");
  await writeFile(path.join(directory, "manifest.yaml"), "version: 1\nid: feature-delivery\nentry: workflow.yaml\nprofiles: []\nskills: []\n");
  await writeFile(path.join(directory, "workflow.yaml"), `version: 1
workflow:
  id: feature-delivery
  version: 1
inputs:
  requirement:
    accepts: [user.prompt, local.file, github.issue, gitlab.issue, feishu.document]
steps:
  - id: intake
    uses: connector.execute
    workspace: read-only
    action: requirement.capture
    outputs: [requirement-source]
  - id: explore
    uses: agent.execute
    workspace: read-only
    needs: [intake]
    objective: 探索代码并提取需求相关约束
    skills: [{ ref: builtin://skills/code-exploration, required: true }]
    outputs: [exploration-report]
  - id: clarify
    uses: agent.execute
    workspace: read-only
    needs: [explore]
    objective: 澄清需求并生成可验收规格
    skills:
      - { ref: builtin://skills/requirement-clarification, required: true }
      - { ref: builtin://skills/specification, required: true }
    outputs: [specification]
    approval: required
  - id: design
    uses: agent.execute
    workspace: read-only
    needs: [clarify]
    objective: 形成可实施的技术方案
    skills: [{ ref: builtin://skills/technical-design, required: true }]
    outputs: [design]
    approval: required
  - id: plan
    uses: agent.execute
    workspace: read-only
    needs: [clarify, design]
    objective: 将设计拆分为可验证任务
    skills: [{ ref: builtin://skills/task-planning, required: true }]
    outputs: [tasks]
    inputs:
      - { outputId: specification, required: true }
      - { outputId: design, required: false }
  - id: write-tests
    uses: agent.execute
    workspace: isolated-worktree
    needs: [plan]
    objective: 根据当前任务先编写能够因缺少功能而失败的测试
    skills: [{ ref: builtin://skills/tdd-implementation, required: true }]
    outputs: [red-test-result]
  - id: verify-red
    uses: command.execute
    workspace: isolated-worktree
    action: quality.test
    expectedOutcome: test-failure
    needs: [write-tests]
    outputs: [red-evidence]
  - id: implement
    uses: agent.execute
    workspace: isolated-worktree
    needs: [verify-red]
    objective: 在保留 Red 测试的前提下完成最小实现
    skills: [{ ref: builtin://skills/tdd-implementation, required: true }]
    outputs: [implementation-result]
  - id: verify-green
    uses: command.execute
    workspace: isolated-worktree
    action: quality.test
    expectedOutcome: success
    needs: [implement]
    inputs: [red-evidence]
    outputs: [tdd-evidence]
  - id: review-fix
    uses: control.loop
    workspace: isolated-worktree
    needs: [verify-green]
    until: '\${artifacts.review-result.approved}'
    maxIterations: 5
    steps:
      - id: review
        uses: agent.execute
        workspace: isolated-worktree
        skills: [{ ref: builtin://skills/code-review, required: true }]
        outputs: [review-result]
      - id: fix
        uses: agent.execute
        workspace: isolated-worktree
        when: '\${artifacts.review-result.approved == false}'
        skills: [{ ref: builtin://skills/review-fix, required: true }]
      - id: verify
        uses: command.execute
        workspace: isolated-worktree
        action: quality.verify
  - id: commit
    uses: connector.execute
    workspace: isolated-worktree
    action: git.commit
    needs: [review-fix]
    approval: required
  - id: update-issue
    uses: connector.execute
    workspace: read-only
    action: issue.update
    needs: [commit]
    when: '\${bindings.issue.exists}'
  - id: update-wiki
    uses: connector.execute
    workspace: read-only
    action: knowledge.publish
    needs: [update-issue]
    when: '\${bindings.knowledge.exists}'
  - id: close-issue
    uses: connector.execute
    workspace: read-only
    action: issue.close
    needs: [update-wiki]
    when: '\${bindings.issue.exists}'
    approval: required
  - id: close
    uses: control.close
    workspace: isolated-worktree
    needs: [close-issue]
`);
  const loaded = await loadWorkflowPackage({ root, ref: "project://workflows/feature-delivery" });
  assert.equal(loaded.workflow.steps.length, 15);
  assert.deepEqual(loaded.workflow.gates, []);
  assert.equal(loaded.workflow.changePolicy, undefined);
  assert.equal(loaded.workflow.steps.find((step) => step.id === "review-fix")?.steps?.length, 3);
});

test("Project loader 接受完整 Profile v1 策略并与 Catalog 共用严格负例矩阵", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root, "fixture-workflow");
  await writeFile(path.join(directory, "workflow.yaml"), workflowV1Fixture);
  await writeFile(path.join(directory, "profiles", "standard.yaml"), profileV1Fixture);
  const loaded = await loadWorkflowPackage({ root, ref: "project://workflows/fixture-workflow" });
  assert.deepEqual(loaded.profiles.get("standard")?.steps["review-fix"]?.artifacts, {
    "review-result": { required: true, contentLevel: "complete" },
  });
  assert.equal(loaded.profiles.get("standard")?.steps["review-fix"]?.independentReviewActor, true);
  assert.deepEqual(loaded.profiles.get("standard")?.audit, {
    level: "complete",
    retention: "extended",
    recordDecisions: true,
    recordApprovals: true,
    recordActors: true,
    recordPublishing: true,
  });

  for (const [label, workflow] of invalidWorkflowV1Fixtures) {
    await writeFile(path.join(directory, "workflow.yaml"), workflow);
    await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/fixture-workflow" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/, label);
  }
  await writeFile(path.join(directory, "workflow.yaml"), workflowV1Fixture);
  for (const [label, profile] of invalidProfileV1Fixtures) {
    await writeFile(path.join(directory, "profiles", "standard.yaml"), profile);
    await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/fixture-workflow" }), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID/, label);
  }
});

test("Manifest、Workflow、Profile、Schema 和 Template 的变化均改变 Package 摘要", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  let previous = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const changes: Array<[string, string]> = [
    ["manifest.yaml", "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: [standard]\nskills: [review]\ncapabilities: [external-read]\n"],
    ["workflow.yaml", "version: 1\nworkflow: { id: team-feature, version: 1 }\ninputs: {}\nsteps:\n  - id: revised\n    uses: agent.execute\n    workspace: read-only\n    skills: [{ ref: package://skills/review, required: true }]\ngates: []\nchangePolicy: { kind: feature, allowedPaths: ['**'] }\n"],
    ["profiles/standard.yaml", "version: 1\nprofile: { id: standard, workflow: team-feature }\nsteps: { design: { enabled: false } }\npublishing: { issueRequired: false, knowledgeRequired: false }\naudit: { level: standard }\n"],
    ["schemas/review.json", "{\"type\":\"string\"}\n"],
    ["templates/review.md", "# Revised template\n"],
  ];
  for (const [relative, content] of changes) {
    await writeFile(path.join(directory, relative), content);
    const current = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
    assert.notEqual(current.contentDigest, previous.contentDigest, `${relative} 必须进入摘要`);
    previous = current;
  }
});

test("拒绝词法路径逃逸", async () => {
  const root = await temporaryRoot();
  await assert.rejects(
    loadWorkflowPackage({ root, ref: "project://workflows/../../outside" }),
    /WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID/,
  );
});

test("拒绝通过符号链接逃出项目工作流根目录", async (context) => {
  const root = await temporaryRoot();
  const outside = path.join(root, "outside");
  await packageFixture(outside, "escaped");
  await mkdir(path.join(root, ".wsspec", "workflows"), { recursive: true });
  try {
    await symlink(outside, path.join(root, ".wsspec", "workflows", "escaped"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("当前文件系统不支持测试符号链接");
    throw error;
  }
  await assert.rejects(
    loadWorkflowPackage({ root, ref: "project://workflows/escaped" }),
    /WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/,
  );
});

test("Project 根到 workflows 的每一级都拒绝现存和悬空的越界符号链接", async (context) => {
  for (const boundary of [".wsspec", "workflows"] as const) {
    for (const targetState of ["existing", "dangling"] as const) {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      await mkdir(root, { recursive: true });
      const existingPackage = await packageFixture(outside, "escaped");
      const link = boundary === ".wsspec"
        ? path.join(root, ".wsspec")
        : path.join(root, ".wsspec", "workflows");
      const target = boundary === ".wsspec"
        ? path.dirname(path.dirname(existingPackage))
        : path.dirname(existingPackage);
      if (boundary === "workflows") await mkdir(path.dirname(link), { recursive: true });
      try {
        await symlink(targetState === "existing" ? target : `${target}-missing`, link);
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "EPERM") context.skip("当前文件系统不支持测试符号链接");
        throw caught;
      }
      await assert.rejects(
        loadWorkflowPackage({ root, ref: "project://workflows/escaped" }),
        /WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/,
        `${boundary}:${targetState}`,
      );
    }
  }
});

test("拒绝 Schema、Template 和 Package Skill 内部的空目录符号链接逃逸", async (context) => {
  for (const escapedDirectory of ["schemas", "templates", "skills/review/scripts"]) {
    const root = await temporaryRoot();
    const directory = await packageFixture(root);
    const outside = path.join(root, "outside-empty");
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(directory, escapedDirectory), { recursive: true });
    try {
      await symlink(outside, path.join(directory, escapedDirectory, "escaped"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("当前文件系统不支持测试符号链接");
      throw error;
    }
    await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/);
  }
});

test("缺少 Manifest 或 Manifest 版本不受支持时拒绝加载", async () => {
  const root = await temporaryRoot();
  const missing = path.join(root, ".wsspec", "workflows", "missing");
  await mkdir(missing, { recursive: true });
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/missing" }), /WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING/);

  const unsupported = await packageFixture(root, "unsupported");
  await writeFile(path.join(unsupported, "manifest.yaml"), "version: 2\nid: unsupported\nentry: workflow.yaml\nprofiles: [standard]\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/unsupported" }), /WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED/);
});

test("缺少 Workflow 和 Profile 给出各自稳定诊断", async () => {
  const root = await temporaryRoot();
  const workflowMissing = await packageFixture(root, "workflow-missing");
  await writeFile(path.join(workflowMissing, "workflow.yaml"), "");
  await (await import("node:fs/promises")).unlink(path.join(workflowMissing, "workflow.yaml"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/workflow-missing" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_MISSING/);

  const profileMissing = await packageFixture(root, "profile-missing");
  await (await import("node:fs/promises")).unlink(path.join(profileMissing, "profiles", "standard.yaml"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/profile-missing" }), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_MISSING/);
});

test("拒绝 Manifest、Workflow、Profile 和 Lock 中的未知字段", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await writeFile(path.join(directory, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: [standard]\nskills: [review]\nexternalSideEffect: [external-write]\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID/);

  await packageFixture(root);
  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nworkflow: { id: team-feature, version: 1 }\ninputs: {}\nsteps:\n  - id: review\n    uses: agent.execute\n    workspace: read-only\n    skills: [{ ref: package://skills/review, required: true }]\n    typo: true\ngates: []\nchangePolicy: { kind: feature, allowedPaths: ['**'] }\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/);

  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nworkflow: { id: team-feature, version: 1 }\ninputs: {}\nsteps:\n  - id: review\n    uses: agent.execute\n    workspace: read-only\n    skills: [{ ref: package://skills/review, required: true }]\ngates: []\nchangePolicy: { kind: feature, allowedPaths: ['**'] }\n");
  await writeFile(path.join(directory, "profiles", "standard.yaml"), "version: 1\nprofile: { id: standard, workflow: team-feature }\nsteps: {}\npublishing: { issueRequired: false, knowledgeRequired: false }\naudit: { level: standard }\ntypo: true\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID/);

  await writeFile(path.join(directory, "profiles", "standard.yaml"), "version: 1\nprofile: { id: standard, workflow: team-feature }\nsteps: {}\npublishing: { issueRequired: false, knowledgeRequired: false }\naudit: { level: standard }\n");
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const lock = lockWorkflowPackage(pkg);
  await writeFile(path.join(directory, "workflow.lock"), JSON.stringify({ ...lock, files: [{ ...lock.files[0], typo: true }] }));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID/);
});

test("递归拒绝 Workflow 与 Profile 嵌套对象的未知字段和错误类型", async () => {
  const workflowCases = [
    "retry: { maxAttempts: 2, typo: true }",
    "retry: { maxAttempts: wrong }",
    "skills: [{ ref: package://skills/review, required: wrong }]",
    "inputs: [{ outputId: specification, required: wrong }]",
    "steps: [{ id: nested, uses: agent.execute, skills: [], typo: true }]",
  ];
  for (const fragment of workflowCases) {
    const root = await temporaryRoot();
    const directory = await packageFixture(root);
    await writeFile(path.join(directory, "workflow.yaml"), `version: 1\nworkflow: { id: team-feature, version: 1 }\ninputs: {}\nsteps:\n  - id: review\n    uses: agent.execute\n    workspace: read-only\n    ${fragment}\ngates: []\nchangePolicy: { kind: feature, allowedPaths: ['**'] }\n`);
    await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/, fragment);
  }

  const profileCases = [
    "steps: { review: { enabled: true, typo: true } }\npublishing: { issueRequired: false, knowledgeRequired: false }\naudit: { level: standard }",
    "steps: { review: { maxIterations: wrong } }\npublishing: { issueRequired: false, knowledgeRequired: false }\naudit: { level: standard }",
    "steps: {}\npublishing: { issueRequired: false, knowledgeRequired: false, typo: true }\naudit: { level: standard }",
    "steps: {}\npublishing: { issueRequired: false, knowledgeRequired: false }\naudit: { level: standard, typo: true }",
  ];
  for (const fragment of profileCases) {
    const root = await temporaryRoot();
    const directory = await packageFixture(root);
    await writeFile(path.join(directory, "profiles", "standard.yaml"), `version: 1\nprofile: { id: standard, workflow: team-feature }\n${fragment}\n`);
    await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID/, fragment);
  }
});

test("拒绝旧的简化 Workflow 与 Profile 双版本", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nid: team-feature\nsteps: []\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/);

  await packageFixture(root);
  await writeFile(path.join(directory, "profiles", "standard.yaml"), "version: 1\nid: standard\nworkflow: team-feature\ndesign: true\nreviewIterations: 5\naudit: standard\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID/);
});

test("Workflow Step 必须显式声明合法 workspace 模式", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root, "workspace-mode");
  const workflow = "version: 1\nworkflow: { id: workspace-mode, version: 1 }\ninputs: {}\nsteps:\n  - id: review\n    uses: agent.execute\n    skills: []\ngates: []\n";
  await writeFile(path.join(directory, "workflow.yaml"), workflow);
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/workspace-mode" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/);
  await writeFile(path.join(directory, "workflow.yaml"), workflow.replace("skills: []", "workspace: shared\n    skills: []"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/workspace-mode" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/);
});

test("可选树只允许顶层不存在，已进入 Skill 树后的 ENOENT 必须 fail closed", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await (await import("node:fs/promises")).rm(path.join(directory, "schemas"), { recursive: true });
  await (await import("node:fs/promises")).rm(path.join(directory, "templates"), { recursive: true });
  await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  await symlink(path.join(directory, "skills", "review", "missing-descendant"), path.join(directory, "skills", "review", "descendant"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /ENOENT|WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/);
});

test("拒绝 Workflow 引用 Manifest 未声明的 Package Skill", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root, "undeclared-skill");
  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nworkflow: { id: undeclared-skill, version: 1 }\ninputs: {}\nsteps:\n  - id: review\n    uses: agent.execute\n    workspace: read-only\n    skills: [{ ref: package://skills/secret, required: true }]\ngates: []\nchangePolicy: { kind: feature, allowedPaths: ['**'] }\n");

  await assert.rejects(
    loadWorkflowPackage({ root, ref: "project://workflows/undeclared-skill" }),
    /WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED/,
  );
});

test("Lock 拒绝未知字段，并以排序的相对文件清单产生确定性摘要", async () => {
  const root = await temporaryRoot();
  const firstDirectory = await packageFixture(root, "first");
  const secondDirectory = await packageFixture(root, "second");
  for (const relative of ["manifest.yaml", "workflow.yaml", "profiles/standard.yaml"]) {
    await writeFile(path.join(secondDirectory, relative), await readFile(path.join(firstDirectory, relative), "utf8"));
  }
  const first = await loadWorkflowPackage({ root, ref: "project://workflows/first" });
  const second = await loadWorkflowPackage({ root, ref: "project://workflows/second" });

  const lock = lockWorkflowPackage(first);
  assert.equal(lock.version, 1);
  assert.deepEqual(lock.files.map((entry) => entry.path), [...lock.files.map((entry) => entry.path)].sort());
  assert.deepEqual(lock.packageSkills, [{ ref: "package://skills/review", digest: first.packageSkills.get("package://skills/review")!.digest }]);
  assert.equal(lock.contentDigest, first.contentDigest);
  assert.equal(first.contentDigest, second.contentDigest);

  await writeFile(path.join(firstDirectory, "workflow.lock"), "version: 1\nunknown: true\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/first" }), /WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID/);
  await readFile(path.join(secondDirectory, "manifest.yaml"), "utf8");
});

test("Lock 拒绝摘要、文件与 Skill 清单漂移", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const lock = lockWorkflowPackage(pkg);
  await writeFile(path.join(directory, "workflow.lock"), JSON.stringify({ ...lock, packageSkills: [{ ...lock.packageSkills[0]!, digest: "sha256:changed" }] }));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID/);
});

test("加载内置 Package 使用内置 URI", async () => {
  const root = await temporaryRoot();
  const loaded = await loadWorkflowPackage({ root, ref: "builtin://workflows/feature-delivery" });
  assert.equal(loaded.manifest.id, "feature-delivery");
  assert.equal(loaded.ref, "builtin://workflows/feature-delivery");
});

test("生产 Builtin 路径不能由调用方注入的根或 Catalog 伪造", async () => {
  const root = await temporaryRoot();
  const fakeRoot = path.join(root, "fake-builtin");
  await mkdir(path.join(fakeRoot, "workflows"), { recursive: true });
  const fakePackage = await packageFixture(fakeRoot, "feature-delivery");
  await (await import("node:fs/promises")).rename(fakePackage, path.join(fakeRoot, "workflows", "feature-delivery"));
  const loaded = await loadWorkflowPackage({
    root,
    ref: "builtin://workflows/feature-delivery",
    builtinRoot: fakeRoot,
    catalog: { version: 1, skills: [], workflows: [{ id: "feature-delivery", steps: [], gates: [], changePolicy: { kind: "feature", allowedPaths: [] }, profiles: [] }] },
  } as never);
  assert.equal(loaded.manifest.description, "基础功能交付工作流");
});
