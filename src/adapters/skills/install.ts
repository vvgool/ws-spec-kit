import type { BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { sha256 } from "../../domain/digests.js";
import { CliAdapterError } from "../cli/output.js";
import { spawnJson } from "../process/spawn-json.js";
import { claudeDriverTarget } from "./claude.js";
import { codexDriverTarget } from "./codex.js";
import { cursorDriverTarget } from "./cursor.js";
import { genericDriverTarget } from "./generic.js";

export type DriverAgent = "codex" | "claude" | "cursor" | "generic";
export interface InstallDriverSkillInput { agent: DriverAgent; home: string; target?: string; dryRun?: boolean }
export interface InstallDriverSkillResult { agent: DriverAgent; target: string; dryRun: boolean }
export interface DriverSkillInstallerDependencies {
  secureInstall(request: SecureInstallRequest): Promise<void>;
}

export interface SecureInstallRequest {
  target: string;
  targetDev: string;
  targetIno: string;
  operation: "create" | "verify" | "setup";
  segments?: string[];
  dryRun: boolean;
  contentBase64?: string;
  expectedDigest?: string;
  expectedSize?: number;
}

type DriverVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

const currentDriverVersion = 15 as const;
const maximumDriverBytes = 1_048_576n;
const legacyDriverDescription = "使用 WSSpecKit 驱动软件交付 Workflow；新任务、已有任务或用户明确要求时调用。";
const driverDescriptionV14 = "在已初始化 WSSpecKit 的项目中实现功能、修复错误或交付文档，继续已有 Work Item，或用户明确要求使用 WSSpecKit 时调用。";
const driverDescription = "在已初始化 WSSpecKit 项目中实现功能、修复错误、交付文档、继续已有 Work Item，或用户明确要求使用 WSSpecKit 记录只读评估时调用。";
const driverFrontMatterKeys = ["description", "name", "wsspeckit-driver-content-digest", "wsspeckit-driver-version"] as const;

// v1 的中文指导曾在未提升版本号时更新，因此两个历史摘要都必须显式登记。
const canonicalDriverDigests: Record<DriverAgent, Record<DriverVersion, readonly string[]>> = {
  codex: {
    15: ["sha256:4d364f53e0c586a79b818b3c50ebf738361a193cc6478f7b0f47c0284675d420"],
    14: ["sha256:ebb2d1bb583dcc32468952b766bf09daca00295fe64fa52dd3f6d57bba8f4210"],
    13: ["sha256:c7016f1e819af357d9135bb671fabd9b38606730cc93506c3e8c324e2e2bccbc"],
    1: [
      "sha256:8804ee37451e7740a488c14291d048b57a21bdd7e2efb1b1beb70a46940030e3",
      "sha256:69b6ad68c123a711095377ffdf64d21225f4bafaab3a414497ffef6c5391773e",
    ],
    2: ["sha256:69b6ad68c123a711095377ffdf64d21225f4bafaab3a414497ffef6c5391773e"],
    3: ["sha256:451f3853fbc01766264e07c6b3f376aa64acfa0d7f2c6662916f876496558a8f"],
    4: ["sha256:417eb92d90b1fcd9f3ea519a80fd7d3b9151d211c90371ff17e2edbb361817aa"],
    5: ["sha256:2168d90a410d3d250645efb01911d09bc0f72259835fa2800819eba6838b65db"],
    6: ["sha256:dbee7635c12c75cd3548241e36e919f53afa7f6ca5f93a147d2dc674cc39bb25"],
    7: ["sha256:cccac8ae5fa0fe9df0b6619afc8566be7964b3ae2a5d65f93002a3def5360039"],
    8: ["sha256:1dcde3f1ac6354c638e72d06f38c52c08eef3d23997d424ec4fb4965658828d4"],
    9: ["sha256:c6f840578f56f519abf2b1d46dcad1b9677ab967f3f10b8db52cc75059c05c51"],
    10: ["sha256:23ab06508a0fe66dd04288d9e61491beb5e27ce9ba74261bab1108b50d83cefb"],
    12: ["sha256:cab7f4bb237450218ea5607b54635ce2a8cd6078ac1f9a904f74026fc679a692"],
    11: ["sha256:3d2335676195672913c280663db65fc91bf8e141f3d69549a033678e55ee9383"],
  },
  claude: {
    15: ["sha256:982941fb0282da31e2a440022cdc92bd5ed495287ef4a83b2ee6e34b32ab0509"],
    14: ["sha256:dd2015258aad398d94adc1acd22afaef81b2a3681db029328cb7775f2ff730e6"],
    13: ["sha256:855e464ec86d5b26bab5e649da6cca8eb15418cfe2b72778e0af69dd608260b5"],
    1: [
      "sha256:3a592093e530e6e65c46d3d0cbde567fc4674135b250b0bd807e44dcb8ff8fb7",
      "sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1",
    ],
    2: ["sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1"],
    3: ["sha256:100a50a8ca4da95b9513aec29cdd70703cccd6bdb89209d1d18850f63ea944cb"],
    4: ["sha256:4bc3ec83cec6e94858e91d9530de8cd5cb73808e4afaed40696f0acd0238f1a3"],
    5: ["sha256:bbaf8982709f2a8a38e62fc1d4142725d9a38932385daad0bba70307295e7f62"],
    6: ["sha256:3d425ec1ad828b1c58768225bc07e5fa00468566d63997ce8b346c9ba0e50c1f"],
    7: ["sha256:c24cc8db341e713dc68558ebfa89ea7e697375ed607158daf8376b859e2cc2ff"],
    8: ["sha256:473652ca39298ac466cac9afe46200d75fccfe0824e196a7c9c48094f1b9a4b2"],
    9: ["sha256:7db41e216376d8ff9e453a4cfde3a7d0ac938a7e9910240cfe7873df9e32ac25"],
    10: ["sha256:282b20e91c2118c552323bf18fd2e6fa5a8212c0ff3539f5a074eb3d3bdfe5c7"],
    12: ["sha256:4b132f4b736ca14510c115bd8ee70bf3e621ab503217272615af246a29229782"],
    11: ["sha256:c030ff3dc4958af5886149b48a3fbb7f030f7f9015845602be897fd906df6f88"],
  },
  cursor: {
    15: ["sha256:8c2db8930e01301a31c5425af6a267f779bade345e7db135a540ac95bd2ac43d"],
    14: ["sha256:92f9c8c267fa722bbb28b92478cf15266650c48a600de423862d2eb0889603cd"],
    13: ["sha256:b69be5618ff95a936e289cdbe88e292b208ae09aed5fb95740acf97415e2b7ad"],
    1: [
      "sha256:d74438d605600c54633d2262a9558163a3f0d3a5c664983e4a20d4f84708b392",
      "sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93",
    ],
    2: ["sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93"],
    3: ["sha256:5d16ec26c199a1c552b9ba81d346f87fc26ff508c9204c68501ba01ace39ea98"],
    4: ["sha256:37dac4a4dfb61cc430cd50fcfd2b57988aa44caf0edbe87e5f5c97c36b153f1e"],
    5: ["sha256:cb9f9b0b7698c91a8b92443e3818cb5e875392d8f2a97666408ed38967b3d2a7"],
    6: ["sha256:fde89e7d933eea21e9ef1b9d32f3e8a2b2c5905664cc7f924ad02de4390e73bc"],
    7: ["sha256:b9bf5f6060ac8d8c7c24aedea265724623e54d76af91c014fc2d8e450ecedb0d"],
    8: ["sha256:c433dcaa8a1daddd77029c798581d67199efbfb1bb0ef9f29cfbae9d60387997"],
    9: ["sha256:57c9f82585fff57fa754f3d91c08136296e935d2046cde68160e6b4a7f54c22d"],
    10: ["sha256:21ead795458a814064e4bf567d01e50d03676c0ef40b32abca2cc63439751187"],
    12: ["sha256:90a15b8b11a03758ba0c355521c588eb0912bfab7837bb4c3a1f2dcfa430f67b"],
    11: ["sha256:6646b72622b63e91b2bf7ca575412ae9eeb969c492645cd7ba327b9e00c7049f"],
  },
  generic: {
    15: ["sha256:3e0fbe06c81de83648dd6bdb3db0a50156974bbae14802d5bc25c00fdd05858a"],
    14: ["sha256:5682bba5ea6ded239fc59b6156bdba42cabd10afb2c1408811fa7c34d0cb401f"],
    13: ["sha256:d5acf16f2f8d9981578646879c5b451eaee0f7ada8dca384066ebfda1d59aef3"],
    1: [
      "sha256:a2aeea6a8e14df5fb5477d5ec37eee0a7666f10976e80ac92a8087d1484b94c5",
      "sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25",
    ],
    2: ["sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25"],
    3: ["sha256:68f5b5a5c650648987fa230f339e162792a431da53d4b4ca202aff78fcb0cff1"],
    4: ["sha256:c850774fd9c8338c31c6815a83fe526408b76f9473a3482d99bcee42342e3db6"],
    5: ["sha256:6a5288b339b5bc2ae41f3b445863b32ad11428d5b6362ba4a97bd025cafdcca9"],
    6: ["sha256:675dbd85103232c879728b080f648b64701813a540050a1af0d622655f37cde3"],
    7: ["sha256:b10bf3dee31acfa1364ebd8668659095e433ac572450670e1a22130f00c68d3b"],
    8: ["sha256:08eae7547d185a362fb81ef267c91b9aedcabae870b907154c154a3212f2576c"],
    9: ["sha256:b12c0a55f82ea7028735ce96e11073f4a5faff2b304aa956fb9d8da7e77f60e0"],
    10: ["sha256:de7012748b5a190448f4a8377db4916a3c356deaeb6e38867141795aaf8e099b"],
    12: ["sha256:d5b430136b9e585242c242b739a2a88aeedbb066870e09f1bb8b0f0c47645d3d"],
    11: ["sha256:83c3ffeca711f3d914870a36954885da21dfbdcf19b5f96794a128bd57d587a9"],
  },
};

function contract(agent: DriverAgent): Record<string, unknown> {
  const recoveryCases = {
    acquire: { next: "acquire" },
    "revalidate-red": { next: "recover" },
    "retry-test-gate": { next: "recover" },
    await_approval: { next: "acquire" },
    reconcile: { next: "blocked" },
    blocked: { next: "blocked" },
    completed: { next: "completed" },
  };
  const actionCases = {
    execute: {
      next: "artifact",
      capture: {
        workPackage: "result.workPackage",
        stepId: "result.workPackage.stepId",
        attemptId: "result.workPackage.attemptId",
        leaseToken: "result.workPackage.lease.token",
        requiredOutputs: "result.workPackage.requiredOutputs",
        draftRoot: "result.workPackage.artifactAuthoring.draftRoots.1",
      },
      initialize: {
        target: "artifactRefs",
        source: "result.workPackage.artifacts",
        filter: { field: "artifactType", equals: "requirement-source", requiredBy: "requiredOutputs" },
      },
    },
    await_approval: { next: "await_approval" },
    blocked: { next: "blocked" },
    completed: { next: "completed" },
  };
  const submitActionCases = {
    ...actionCases,
    await_approval: {
      next: "decide",
      capture: { approval: "result.approval" },
      humanGate: { required: true, approval: "result.approval" },
    },
  };
  const decideActionCases = {
    ...actionCases,
    blocked: {
      next: "blocked",
      routeByValue: {
        field: "result.problems.0.code",
        cases: { WSSPEC_APPROVAL_EXPIRED: { next: "inspect" } },
        default: { next: "blocked" },
      },
    },
    execute: {
      capture: {
        workPackage: "result.workPackage",
        stepId: "result.workPackage.stepId",
        attemptId: "result.workPackage.attemptId",
        leaseToken: "result.workPackage.lease.token",
        requiredOutputs: "result.workPackage.requiredOutputs",
        draftRoot: "result.workPackage.artifactAuthoring.draftRoots.1",
      },
      routeByValue: {
        field: "result.resumeSubmission",
        cases: { true: { next: "submit" } },
        default: {
          next: "artifact",
          initialize: actionCases.execute.initialize,
        },
      },
    },
    rejection_confirmed: {
      next: "decide",
      capture: { rejectionToken: "result.rejectionConfirmation.token" },
    },
  };
  return {
    kind: "wsspeckit-driver-contract",
    version: 1,
    workflowSelection: {
      feature: "builtin://workflows/feature-delivery",
      fix: "builtin://workflows/bugfix-delivery",
      assessment: "builtin://workflows/assessment",
      documentation: "builtin://workflows/documentation-delivery",
    },
    entrypoints: { new: "start", recovery: "inspect" },
    operations: {
      start: {
        argv: ["wspec", "start", "--prompt", "${prompt}", "--workflow", "${workflowRef}", "--profile", "${profile}", "--provider", agent],
        capture: { workItemId: "result.workItemId", workflowRef: "result.workflowRef" },
        next: "inspect",
      },
      inspect: {
        argv: ["wspec", "inspect", "${workItemId}"],
        capture: { workflowRef: "result.workflowRef", recoveryReason: "result.nextAction.reason" },
        branch: { field: "result.nextAction.kind", cases: recoveryCases },
      },
      recover: {
        argv: ["wspec", "recover", "${workItemId}", "--actor", "${actor}", "--reason", "${recoveryReason}"],
        branch: { field: "result.nextAction.kind", cases: { ...recoveryCases,
          "revalidate-red": { next: "blocked" }, "retry-test-gate": { next: "blocked" },
        } },
      },
      acquire: {
        argv: ["wspec", "acquire", "${workItemId}", "--actor", "${actor}"],
        branch: {
          field: "result.action",
          cases: actionCases,
        },
      },
      artifact: {
        argv: [
          "wspec", "artifact", "create",
          "--work-item", "${workItemId}",
          "--step", "${stepId}",
          "--attempt", "${attemptId}",
          "--lease-token", "${leaseToken}",
          "--artifact-type", "${artifactType}",
          "--output", "${outputId}",
          "--content-file", "${contentFile}",
        ],
        capture: { artifactRef: "result" },
        forEach: {
          source: "requiredOutputs",
          item: "requiredOutput",
          filter: { field: "artifactType", notEquals: "requirement-source" },
          bindings: {
            artifactType: "requiredOutput.artifactType",
            outputId: "requiredOutput.outputId",
            contentFile: "${draftRoot}/${outputId}.md",
          },
          collect: { target: "artifactRefs", value: "result" },
        },
        next: "submit",
      },
      submit: {
        argv: [
          "wspec", "submit", "${workItemId}",
          "--step", "${stepId}",
          "--attempt", "${attemptId}",
          "--lease", "${leaseToken}",
          "--result", "${resultPath}",
          "--actor", "${actor}",
        ],
        resultBindings: { artifacts: "artifactRefs" },
        branch: { field: "result.action", cases: submitActionCases },
      },
      decide: {
        argv: ["wspec", "decide", "--input", "${decisionPath}", "--actor", "${actor}"],
        branch: { field: "result.action", cases: decideActionCases },
      },
    },
    terminals: {
      await_approval: { stop: true },
      blocked: { stop: true },
      completed: { stop: true },
    },
  };
}

function body(agent: DriverAgent): string {
  return [
    "# WSSpecKit Driver",
    "",
    "## 何时接入",
    "",
    "用户要求实现功能、修复错误或新增/修改文档，且项目已初始化 WSSpecKit 时，使用本 Driver 推进交付。用户明确要求使用 WSSpecKit 时也读取本指引；项目未初始化则先报告接入状态，不把本次普通请求当作初始化授权。",
    "",
    "纯咨询、解释、只读 review 或评估直接回答，不创建 Work Item。用户明确要求用 WSSpecKit 做只读评估时，选择 `builtin://workflows/assessment`，只记录评估 Artifact 和控制面信息，不创建业务代码工作树或执行提交/发布。",
    "",
    "会话中已知相关 Work Item 时，先走恢复入口；只有明确独立的新需求才 start。用户说‘继续’但没有明确关联任务时，先从当前会话确认 Work Item；存在多个候选或无法确定时询问，不凭任务目录名猜测 ID。",
    "",
    "## Workflow 决策",
    "",
    "对于新交付请求，仅当需求明确为新增或修改文档且不涉及代码时选择 `builtin://workflows/documentation-delivery`；功能实现选择 `builtin://workflows/feature-delivery`，错误修复选择 `builtin://workflows/bugfix-delivery`。用户可以在创建前覆盖选择，但创建时必须传递明确的 `workflowRef`；Work Item 创建后不得自动切换 Workflow。",
    "",
    "## 日常入口（优先）",
    "",
    "新任务可以用 `wspec start --intent <feature|fix|assessment|docs> --prompt \"<用户需求>\"`，也可保留显式 --workflow；两者不同时使用。普通咨询不创建任务。",
    "已有任务使用 `wspec continue <workItemId> --actor <actor>`，将完整 JSON stdout 保存到工作区外临时目录的 <packagePath>。相同 actor 的有效执行包会原样恢复，不重领 lease；guidance 返回时按 view.nextAction 处理，不将等待审批当作批准。",
    "每次收到 execute（包括 complete 返回的下一包），先读取 workPackage.skills 对应的完整 SKILL.md，按其中的产物格式执行，不能只看 description。builtin://skills/<id> 的正文位于当前 wspec 安装包的 resources/skills/<id>/SKILL.md：从实际使用的 CLI 文件解析 realpath，dist/cli/main.js 上两级为包根；不要读全局旧包或凭 URI 猜文件。其他来源按已锁定的项目/Package/Global 绑定解析，来源不明则报告阻塞。",
    "完成当前包时，在原 artifactAuthoring.draftRoots 授权目录写好输出文件，再在同一工作区外临时目录写 <inputPath> JSON：outputs 是 [{outputId,contentFile}]，result 是 SubmitResult 中除 artifacts 外的字段。执行 `wspec complete <workItemId> --actor <actor> --package <packagePath> --input <inputPath>`。无需手填 step、attempt、lease 或 ArtifactRef；系统已提供的 requirement-source 无需另写，verify-red/verify-green 的 outputs 为空，可信证据由引擎生成。",
    '输入模板：`{"outputs":[],"result":{"version":1,"status":"completed","summary":"填写当前步骤的实际结果","modifiedFiles":[],"commands":[],"evidence":[],"externalWrites":[],"remainingRisks":[]}}`',
    "保留模板全部字段，按实际执行填写，不能虚报完成或将已知风险清空。有 Agent 输出时按 requiredOutputs 添加 outputs 映射；contentFile 必须为相对原执行工作目录的草稿路径，不传绝对路径。不要添加 checks 等未知字段。schema 错误时核对完整模板或正式 Schema，不能靠逐条补字段反复试错。",
    'modifiedFiles 只列实际业务工作区改动的相对路径，不包括引擎管理的 drafts、Artifact 或工作区外临时 JSON；只读步骤通常为 []。commands、evidence、externalWrites 的每项必须是对象，不能填字符串。实际运行命令可写 {"argv":["node","--test"],"exitCode":0}；证据可写 {"kind":"observation","summary":"实际观察"}，未执行或未知的字段不要伪造。remainingRisks 可填非空文字或风险对象，例如 {"level":"low","summary":"范围有限"}；按实际风险填写。',
    "收到 WSSPEC_FILESYSTEM_PERMISSION_DENIED 时停止重复 start，说明 Host 沙箱或目录权限阻止控制面访问；由用户/Host 为当前仓库提供所需权限后按已有任务状态恢复。不修改 Host 安全配置，不以换 workflow 绕过权限。",
    "complete 返回 execute 时已领取下一包，保存新 stdout 并继续；不要再次 acquire。重试必须使用同一原包和相同内容。查看进度使用 `wspec status <workItemId>`。过期授权、外部审批与冲突仍遵守恢复合同，不自动批准或换任务。",
    "下面的低层合同保留给兼容调用与精确恢复。高层 complete 已完成 author/submit 时，不重复执行低层提交。",
    "",
    "## 新任务与恢复",
    "",
    `新任务执行 \`wspec start --prompt "<用户需求>" --workflow "<workflowRef>" --profile "<profile>" --provider "${agent}"\`。从 JSON 输出读取 \`result.workItemId\` 和 \`result.workflowRef\`；后续所有命令都使用这个 \`workItemId\`，并确认 \`workflowRef\` 未变化。`,
    "",
    "已有任务或 Host 重启后的恢复先执行 inspect，再按 nextAction 路由：先运行 `wspec inspect \"<workItemId>\"`，从 `result.workflowRef` 确认原 Workflow，仅当 nextAction.kind 为 acquire 或 await_approval 时再运行 `wspec acquire \"<workItemId>\" --actor \"<actor>\"`。不要重新 start，也不要按项目当前默认值替换原 `workflowRef`。",
    "",
    "inspect 的 result.nextAction.kind 为 revalidate-red 或 retry-test-gate 时，以 result.nextAction.reason 作为原因执行 `wspec recover <workItemId> --actor <actor> --reason <reason>`，恢复不会批准审批或重发外部请求。recover 返回 acquire 后继续领取；返回 blocked、reconcile 或再次要求恢复时停止并展示原因，禁止无变化循环重试。completed 则停止。",
    "",
    "## acquire / submit 循环",
    "",
    "每次 acquire 都读取 `result.action` 并按下列分支处理：",
    "",
    "- `execute`：读取 `result.workPackage.stepId`、`result.workPackage.attemptId`、`result.workPackage.lease.token` 和完整 `requiredOutputs`。先把 Work Package 中系统提供的 `requirement-source` 引用放入 `artifactRefs`；再按 `requiredOutputs` 顺序逐项处理其余输出。从 `result.workPackage.artifactAuthoring.draftRoots[1]` 获取当前任务授权的 `draftRoot`，不得根据任务 ID 猜测目录。每项正文写入 `<draftRoot>/<outputId>.md`，执行 `wspec artifact create --work-item \"<workItemId>\" --step \"<stepId>\" --attempt \"<attemptId>\" --lease-token \"<leaseToken>\" --artifact-type \"<artifactType>\" --output \"<outputId>\" --content-file \"<draftRoot>/<outputId>.md\"`，并把每次 JSON stdout 的 `result` 追加到 `artifactRefs`。所有必需输出完成后才生成 SubmitResult；submit JSON 的 `artifacts` 只携带累积的 ArtifactRef，正文、`contentFile`、绝对路径和 Lease token 都不得写入 `<resultPath>`。随后执行 `wspec submit \"<workItemId>\" --step \"<stepId>\" --attempt \"<attemptId>\" --lease \"<leaseToken>\" --result \"<resultPath>\" --actor \"<actor>\"`。submit 也返回 `result.action`：若为 `execute`，它已经携带并 claim 新 Work Package，必须从 artifact 循环处理，不得再次 acquire；其余分支按下文停止。不得复用旧 attemptId 或 leaseToken。",
    "- `await_approval`：读取并向用户展示 `result.approval`，尚未获得明确决定时等待用户。普通步骤（`approval.kind: step`）的用户明确批准可直接转录为 `kind: approval`、`decision: approved`，加入 `confirmation: { source: conversation, userMessage: 用户确认原话 }`，绑定当前 `workItemId`、`requestId`、`expectedDigest: result.approval.digest`，以当前 Agent 的 `actor` 执行 `wspec decide`，无需用户再操作终端。已有对当前版本的明确确认时直接执行，不重复询问。确认记录标记为 `agent_transcribed`，表示 Agent 转录，不是独立验证的用户身份；仅保存这次确认原话，不复制整段会话。只在用户确认明确对应当前审批版本时转录；模糊回应或方案变更后重新展示待审批内容并澄清。`external_action`、`workflow_trust` 及需要人工决定的外部恢复仍要求 TTY：展示审批时就说明执行方式；遇到 `WSSPEC_INTERACTIVE_TTY_REQUIRED` 后不要原样反复重试，也不要自行创建 TTY 代替用户确认。用户明确提出修改要求时，将原话作为 `feedback`，先由 WSSpecKit 本地真实 TTY 提交 `confirm_rejection` 决定；收到 `rejection_confirmed` 后，把返回的一次性 `rejectionToken` 与同一份 `feedback` 写入 `rejected` 决定并执行 `wspec decide --input \"<decisionPath>\" --actor \"<actor>\"`。不得在拒绝决定成功前修改审批绑定的 Artifact。若决定后返回 `execute` 且 `resumeSubmission` 不为 `true`，按新 Work Package 重新执行 Artifact authoring；修订时读取 `workPackage.revisionRequest.feedback`。仅当 `resumeSubmission: true` 时，才使用原样未改的 `<resultPath>` 直接重新 submit。若 Host 会话已中断，再从 inspect / acquire 恢复。",
    "- `blocked`：读取并展示 `result.problems`。若 code 为 `WSSPEC_APPROVAL_EXPIRED`，明确说明本次批准未生效，按 inspect -> acquire 恢复，并使用新 Work Package 重新执行 Artifact authoring 和 submit；重新展示产物请求确认，不能复用旧审批或旧结果。这条路径不需要用户手动解除阻塞，不要重复提交旧 decide。其他 blocked 停止当前循环并展示原因，问题解决后从 inspect 按 nextAction 恢复；不要把 acquire 建议当作问题已修复，也不要原样反复重试。租约或证据错误从 inspect 恢复，并遵守 recover 的一次尝试边界。",
    "- `completed`：读取 `result.summary`，报告完成并停止，不再 acquire 或 submit。",
    "",
    "以下 fenced JSON 是 Host 和自动验收共同消费的命令/状态机合同；`${...}` 变量必须来自用户选择、Host 身份或前一条命令声明的 capture，不能自行猜测：",
    "",
    "```json",
    JSON.stringify(contract(agent), null, 2),
    "```",
    "",
    "面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。",
    "",
    "Driver 不得调用模型 API，不得缓存或管理对话、Token、记忆或隐藏推理，不得把 Artifact 正文放入协议 JSON。Artifact 只通过协议中的引用读取，模型上下文由当前 Agent Host 自主管理。",
    "",
    "安装只写入本 Skill 文件，不会启动后台 Runner。Driver 使用 WSSpecKit Application Protocol 驱动当前 Agent，不冒充 Codex、Claude、Cursor 或其他真实 Agent Host。",
    "",
    `手动调用示例：\`wspec start --provider ${agent} --prompt "更新 README" --workflow builtin://workflows/documentation-delivery --profile quick\`。`,
    "",
  ].join("\n");
}

function skill(agent: DriverAgent): string {
  const content = body(agent);
  const digest = sha256(content);
  if (!canonicalDriverDigests[agent][currentDriverVersion].includes(digest)) {
    throw new Error("当前 Driver 正文未登记 canonical 摘要。");
  }
  return [
    "---",
    "name: wsspeckit-driver",
    `wsspeckit-driver-version: ${currentDriverVersion}`,
    `wsspeckit-driver-content-digest: ${digest}`,
    `description: ${driverDescription}`,
    "---",
    "",
    content,
  ].join("\n");
}

function conflict(message = "安装目标已存在且不是 WSSpecKit Driver，拒绝覆盖。"): never {
  throw new CliAdapterError("WSSPEC_SKILL_INSTALL_CONFLICT", message);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(directory: string): Promise<string> {
  let canonical: string;
  try { canonical = await realpath(path.resolve(directory)); }
  catch { return conflict("Driver 安装 authority 不存在或不可访问。"); }
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory()) return conflict("Driver 安装 authority 必须是普通目录。");
  return canonical;
}

async function targetFor(input: InstallDriverSkillInput): Promise<string> {
  if (input.agent !== "generic" && input.target !== undefined) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "只有 Generic Driver 支持 --target。");
  const home = await canonicalDirectory(input.home);
  const supplied = genericDriverTarget(input.target);
  const rawHome = path.resolve(input.home);
  const genericTarget = supplied === undefined ? undefined : path.resolve(supplied);
  const normalizedGenericTarget = genericTarget !== undefined && isWithin(rawHome, genericTarget)
    ? path.join(home, path.relative(rawHome, genericTarget))
    : genericTarget;
  const target = input.agent === "codex" ? codexDriverTarget(home)
    : input.agent === "claude" ? claudeDriverTarget(home)
      : input.agent === "cursor" ? cursorDriverTarget(home)
        : normalizedGenericTarget;
  if (target === undefined || target === "") throw new CliAdapterError("WSSPEC_ARGUMENT_REQUIRED", "Generic Driver 必须通过 --target 指定安装目录。");
  return path.resolve(target);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDirectory(info: BigIntStats): void {
  if (!info.isDirectory()) conflict("Driver 安装路径的每一段都必须是普通目录，禁止 symlink 或其他文件类型。");
}

async function assertCanonicalDirectoryChain(directory: string): Promise<BigIntStats> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  let currentInfo = await lstat(current, { bigint: true });
  assertDirectory(currentInfo);
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current, { bigint: true });
    assertDirectory(info);
    if (await realpath(current) !== current) conflict("Driver 安装路径必须是 canonical，禁止任何祖先 symlink。");
    currentInfo = info;
  }
  return currentInfo;
}

function ownedSkillVersion(content: string, agent: DriverAgent): DriverVersion | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/u.exec(content);
  if (match === null) return undefined;
  let frontMatter: unknown;
  try { frontMatter = parse(match[1]!); } catch { return undefined; }
  if (frontMatter === null || typeof frontMatter !== "object" || Array.isArray(frontMatter)) return undefined;
  const source = frontMatter as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const version = source["wsspeckit-driver-version"];
  const digest = source["wsspeckit-driver-content-digest"];
  const owned = source.name === "wsspeckit-driver"
    && source.description === (version === 15 ? driverDescription : version === 14 ? driverDescriptionV14 : legacyDriverDescription)
    && keys.length === driverFrontMatterKeys.length
    && keys.every((key, index) => key === driverFrontMatterKeys[index])
    && (version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7 || version === 8 || version === 9 || version === 10 || version === 11 || version === 12 || version === 13 || version === 14 || version === 15)
    && typeof digest === "string"
    && digest === sha256(match[2]!)
    && canonicalDriverDigests[agent][version].includes(digest);
  return owned ? version : undefined;
}

async function skillIdentity(filename: string): Promise<BigIntStats | undefined> {
  let info: BigIntStats;
  try { info = await lstat(filename, { bigint: true }); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!info.isFile() || info.nlink !== 1n || info.size > maximumDriverBytes) conflict("Driver Skill 必须是有界单链接普通文件，禁止 symlink、hardlink 或其他文件类型。");
  return info;
}

interface OwnedSkill {
  content: string;
  info: BigIntStats;
  version: DriverVersion;
}

async function assertOwned(target: string, agent: DriverAgent): Promise<OwnedSkill | undefined> {
  const filename = path.join(target, "SKILL.md");
  const before = await skillIdentity(filename);
  if (before === undefined) return undefined;
  let existing: string;
  try { existing = await readFile(filename, "utf8"); }
  catch { return conflict(); }
  const after = await skillIdentity(filename);
  const version = ownedSkillVersion(existing, agent);
  if (after === undefined || !sameIdentity(before, after) || version === undefined) return conflict();
  return { content: existing, info: after, version };
}

const secureInstallScript = String.raw`
import base64, hashlib, json, os, stat, sys

def result(ok, code=None):
    value = {"ok": ok}
    if code is not None:
        value["code"] = code
    sys.stdout.write(json.dumps(value, separators=(",", ":")))

def fail():
    raise RuntimeError("conflict")

def request_value(source, key, kind):
    value = source.get(key)
    if not isinstance(value, kind):
        fail()
    return value

def open_target(target, expected_dev, expected_ino):
    if not target.startswith("/") or os.path.normpath(target) != target or target == "/" or "\x00" in target:
        fail()
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for segment in [part for part in target.split("/") if part]:
            before = os.stat(segment, dir_fd=current, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                fail()
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            after = os.fstat(child)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                os.close(child)
                fail()
            os.close(current)
            current = child
        final = os.fstat(current)
        if str(final.st_dev) != expected_dev or str(final.st_ino) != expected_ino:
            fail()
        return current
    except BaseException:
        os.close(current)
        raise

def existing_file(directory):
    try:
        before = os.stat("SKILL.md", dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1048576:
        fail()
    handle = os.open("SKILL.md", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    after = os.fstat(handle)
    if (not stat.S_ISREG(after.st_mode) or after.st_nlink != 1
            or (before.st_dev, before.st_ino, before.st_mode, before.st_size) != (after.st_dev, after.st_ino, after.st_mode, after.st_size)):
        os.close(handle)
        fail()
    return handle

def confirm_open_file(directory, handle, expected_size):
    opened = os.fstat(handle)
    current = os.stat("SKILL.md", dir_fd=directory, follow_symlinks=False)
    if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
            or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
            or opened.st_size != expected_size
            or (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_size) != (current.st_dev, current.st_ino, current.st_mode, current.st_size)):
        fail()

def verify(directory, expected_digest, expected_size):
    handle = existing_file(directory)
    if handle is None:
        fail()
    try:
        data = bytearray()
        while True:
            chunk = os.read(handle, 65536)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 1048576:
                fail()
        if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_digest:
            fail()
        confirm_open_file(directory, handle, expected_size)
    finally:
        os.close(handle)

def create(directory, content, dry_run):
    existing = existing_file(directory)
    if existing is not None:
        os.close(existing)
        fail()
    if dry_run:
        return False
    handle = None
    created_identity = None
    try:
        handle = os.open("SKILL.md", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        created_identity = os.fstat(handle)
        offset = 0
        while offset < len(content):
            written = os.write(handle, content[offset:])
            if written < 1:
                fail()
            offset += written
        os.fsync(handle)
        os.close(handle)
        handle = None
        os.fsync(directory)
        return True
    except BaseException:
        if handle is not None:
            os.close(handle)
        if created_identity is not None:
            try:
                current = os.stat("SKILL.md", dir_fd=directory, follow_symlinks=False)
                if (stat.S_ISREG(current.st_mode) and current.st_nlink == 1
                        and (current.st_dev, current.st_ino) == (created_identity.st_dev, created_identity.st_ino)):
                    os.unlink("SKILL.md", dir_fd=directory)
                    os.fsync(directory)
            except BaseException:
                pass
        raise

def prepare_directories(target, expected_dev, expected_ino, segments, dry_run):
    if not isinstance(segments, list) or not segments:
        fail()
    if any(not isinstance(part, str) or not part or part in (".", "..") or "/" in part or "\x00" in part for part in segments):
        fail()
    current = open_target(target, expected_dev, expected_ino)
    current_path = target
    try:
        for part in segments:
            pinned = os.fstat(current)
            confirmed = open_target(current_path, str(pinned.st_dev), str(pinned.st_ino))
            os.close(confirmed)
            try:
                before = os.stat(part, dir_fd=current, follow_symlinks=False)
            except FileNotFoundError:
                if dry_run:
                    return
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                    os.fsync(current)
                except FileExistsError:
                    pass
                before = os.stat(part, dir_fd=current, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                fail()
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            after = os.fstat(child)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                os.close(child)
                fail()
            os.close(current)
            current = child
            current_path = os.path.join(current_path, part)
        pinned = os.fstat(current)
        confirmed = open_target(current_path, str(pinned.st_dev), str(pinned.st_ino))
        os.close(confirmed)
        directory = current
        current = None
        return directory
    finally:
        if current is not None:
            os.close(current)

try:
    source = json.load(sys.stdin)
    if not isinstance(source, dict) or set(source) - {"target", "targetDev", "targetIno", "operation", "dryRun", "contentBase64", "expectedDigest", "expectedSize", "segments"}:
        fail()
    target = request_value(source, "target", str)
    target_dev = request_value(source, "targetDev", str)
    target_ino = request_value(source, "targetIno", str)
    operation = request_value(source, "operation", str)
    dry_run = request_value(source, "dryRun", bool)
    if operation == "setup":
        segments = request_value(source, "segments", list)
        directory = prepare_directories(target, target_dev, target_ino, segments, dry_run)
        if directory is not None:
            target = os.path.join(target, *segments)
            pinned = os.fstat(directory)
            target_dev, target_ino = str(pinned.st_dev), str(pinned.st_ino)
        operation = "create"
    else:
        directory = open_target(target, target_dev, target_ino)
    if directory is None:
        result(True)
    else:
        created = False
        expected_digest = None
        expected_size = None
        created_identity = None
        try:
            if operation == "create":
                encoded = request_value(source, "contentBase64", str)
                content = base64.b64decode(encoded, validate=True)
                if len(content) > 1048576:
                    fail()
                expected_digest = hashlib.sha256(content).hexdigest()
                expected_size = len(content)
                created = create(directory, content, dry_run)
                if created:
                    created_stat = os.stat("SKILL.md", dir_fd=directory, follow_symlinks=False)
                    if not stat.S_ISREG(created_stat.st_mode) or created_stat.st_nlink != 1:
                        fail()
                    created_identity = (created_stat.st_dev, created_stat.st_ino)
                    verify(directory, expected_digest, expected_size)
            elif operation == "verify":
                expected_digest = request_value(source, "expectedDigest", str)
                expected_size = request_value(source, "expectedSize", int)
                if dry_run not in (True, False) or len(expected_digest) != 64 or expected_size < 0 or expected_size > 1048576:
                    fail()
                verify(directory, expected_digest, expected_size)
            else:
                fail()
            confirmed = open_target(target, target_dev, target_ino)
            try:
                if operation == "verify" or created:
                    verify(confirmed, expected_digest, expected_size)
            finally:
                os.close(confirmed)
        except BaseException:
            if created_identity is not None:
                try:
                    current = os.stat("SKILL.md", dir_fd=directory, follow_symlinks=False)
                    if (stat.S_ISREG(current.st_mode) and current.st_nlink == 1
                            and (current.st_dev, current.st_ino) == created_identity):
                        os.unlink("SKILL.md", dir_fd=directory)
                        os.fsync(directory)
                except BaseException:
                    pass
            raise
        finally:
            os.close(directory)
        result(True)
except BaseException:
    result(False, "conflict")
`;

function helperSucceeded(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && (value as Record<string, unknown>).ok === true;
}

export async function secureInstallDriverFile(request: SecureInstallRequest): Promise<void> {
  if (process.platform !== "darwin") conflict("Driver 安全安装当前仅支持 macOS。");
  try {
    const helper = await realpath("/usr/bin/python3");
    const helperInfo = await lstat(helper);
    if (!helperInfo.isFile() || helperInfo.uid !== 0 || (helperInfo.mode & 0o022) !== 0) {
      conflict("Driver 安全安装 helper 不可信。");
    }
    const result = await spawnJson({
      executable: helper,
      argv: ["-I", "-S", "-c", secureInstallScript],
      input: request,
      timeoutMs: 5_000,
      maxStdoutBytes: 256,
    });
    if (!helperSucceeded(result.value)) conflict("Driver 安全安装未通过文件系统边界校验。");
  } catch (error) {
    if (error instanceof CliAdapterError) throw error;
    conflict("Driver 安全安装 helper 不可用或执行失败。");
  }
}

const defaultDependencies: DriverSkillInstallerDependencies = { secureInstall: secureInstallDriverFile };

export function createDriverSkillInstaller(overrides: Partial<DriverSkillInstallerDependencies> = {}): (input: InstallDriverSkillInput) => Promise<InstallDriverSkillResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (input) => {
    const target = await targetFor(input);
    let targetInfo: BigIntStats;
    try { targetInfo = await assertCanonicalDirectoryChain(target); }
    catch (error) {
      if (isMissing(error)) conflict("Driver 安装目标目录必须预先创建。");
      throw error;
    }
    const existing = await assertOwned(target, input.agent);
    const content = skill(input.agent);
    if (existing !== undefined && existing.version !== currentDriverVersion) {
      conflict("安装目标是旧版 WSSpecKit Driver；安全安装器拒绝原地覆盖，请人工迁移后重试。");
    }
    const request: SecureInstallRequest = existing === undefined
      ? {
        target,
        targetDev: targetInfo.dev.toString(),
        targetIno: targetInfo.ino.toString(),
        operation: "create",
        dryRun: input.dryRun === true,
        contentBase64: Buffer.from(content).toString("base64"),
      }
      : {
        target,
        targetDev: targetInfo.dev.toString(),
        targetIno: targetInfo.ino.toString(),
        operation: "verify",
        dryRun: input.dryRun === true,
        expectedDigest: sha256(existing.content).slice("sha256:".length),
        expectedSize: Buffer.byteLength(existing.content),
      };
    await dependencies.secureInstall(request);
    return { agent: input.agent, target, dryRun: input.dryRun === true };
  };
}

export const installDriverSkill = createDriverSkillInstaller();

export interface DriverSkillStatus {
  agent: DriverAgent;
  target: string;
  status: "missing" | "current" | "outdated" | "conflict";
  expectedVersion: number;
  installedVersion?: number;
  hostLoaded: "unknown";
  installationSupported: boolean;
  nextSteps: string[];
}

/** Disk inspection only: the CLI cannot observe the host's loaded skill catalog. */
export async function inspectDriverSkill(input: Omit<InstallDriverSkillInput, "dryRun">): Promise<DriverSkillStatus> {
  const target = await targetFor(input);
  let status: DriverSkillStatus["status"] = "missing";
  let installedVersion: number | undefined;
  try {
    await assertCanonicalDirectoryChain(target);
    const owned = await assertOwned(target, input.agent);
    if (owned !== undefined) {
      installedVersion = owned.version;
      status = owned.version === currentDriverVersion ? "current" : "outdated";
    }
  } catch (error) {
    if (!isMissing(error)) {
      if (!(error instanceof CliAdapterError) || error.code !== "WSSPEC_SKILL_INSTALL_CONFLICT") throw error;
      status = "conflict";
    }
  }
  const nextSteps = status === "missing"
    ? ["运行 wspec agent setup --client " + input.agent + (input.agent === "generic" ? " --target <安装目录>" : "") + "。"]
    : status === "outdated"
      ? ["已安装历史 Driver；确认并移走旧 SKILL.md 后重新安装，不会自动覆盖。"]
      : status === "conflict"
        ? ["目标路径或 SKILL.md 不符合安装合同；检查自定义内容、链接或文件类型，保留原文件后处理冲突。"]
        : ["磁盘 Driver 与当前 CLI 匹配；请在 Host 的技能列表确认 wsspeckit-driver，未出现时重新加载技能或开启新会话。"];
  if (process.platform !== "darwin") nextSteps.push("安全安装器当前仅支持 macOS；本次只执行磁盘检查。");
  if (status !== "current") nextSteps.push("安装后需要 Host 重新加载；本命令无法证明当前会话已加载 Driver。");
  return { agent: input.agent, target, status, expectedVersion: currentDriverVersion,
    ...(installedVersion === undefined ? {} : { installedVersion }), hostLoaded: "unknown",
    installationSupported: process.platform === "darwin", nextSteps };
}

export function createDriverSkillSetup(overrides: Partial<DriverSkillInstallerDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const install = createDriverSkillInstaller(dependencies);
  return async (input: InstallDriverSkillInput): Promise<DriverSkillStatus & { dryRun: boolean }> => {
    const before = await inspectDriverSkill(input);
    let installed = false;
    if (before.status === "conflict") conflict("Driver 接入目标存在冲突，请保留原文件并处理后重试。");
    if (before.status === "outdated") conflict("Driver 为旧版本，请确认并移走旧 SKILL.md 后重新 setup。");
    if (before.status === "missing") {
      let ancestor = before.target;
      let info: BigIntStats;
      for (;;) {
        try { info = await assertCanonicalDirectoryChain(ancestor); break; }
        catch (error) {
          if (!isMissing(error) || path.dirname(ancestor) === ancestor) throw error;
          ancestor = path.dirname(ancestor);
        }
      }
      const segments = path.relative(ancestor, before.target).split(path.sep).filter(Boolean);
      if (segments.length > 0) {
        await dependencies.secureInstall({ target: ancestor, targetDev: info.dev.toString(), targetIno: info.ino.toString(),
          operation: "setup", segments, dryRun: input.dryRun === true, contentBase64: Buffer.from(skill(input.agent)).toString("base64") });
        installed = true;
        if (input.dryRun === true) return { ...before, dryRun: true };
      }
    }
    if (!installed) await install(input);
    const result = await inspectDriverSkill(input);
    if (input.dryRun !== true && result.status !== "current") conflict("Driver 安装后复核失败，请重新检查接入状态。");
    return { ...result, dryRun: input.dryRun === true };
  };
}

export const setupDriverSkill = createDriverSkillSetup();
