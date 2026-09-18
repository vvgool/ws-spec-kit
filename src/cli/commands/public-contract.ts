import type { PublicCliErrorRoute, PublicCliRoute } from "../../protocol/public-contract.js";

export interface PublicCommandDescriptor {
  command: string;
  usage: string;
}

export interface PublicCliRouteDescriptor {
  route: PublicCliRoute;
  usage: string;
}

export const publicCommandDescriptors: readonly PublicCommandDescriptor[] = Object.freeze([
  { command: "recover", usage: "wspec recover <workItemId> --actor <actor> --reason <原因>" },
  { command: "revalidate-red", usage: "wspec revalidate-red <workItemId> --expected-evidence <redEvidenceId> --actor <actor> --reason <原因>" },
  { command: "retry-test-gate", usage: "wspec retry-test-gate <workItemId> --expected-attempt <attemptId> --actor <actor> --reason <原因>" },
  { command: "init", usage: "wspec init [--test-root <path>]" },
  { command: "config", usage: "wspec config suggest | migrate <workItemId> --file <configPath> --expected-digest <digest> --actor <actor>" },
  { command: "start", usage: "wspec start (--prompt <需求> | --file <路径> | --source-provider <github|gitlab|feishu> --source-id <稳定标识> [--source-url <规范 URL>]) [--workflow <引用>] [--profile <档位>]" },
  { command: "acquire", usage: "wspec acquire <workItemId> --actor <执行者>" },
  { command: "artifact", usage: "wspec artifact create --work-item <Work Item> --step <步骤> --attempt <尝试> --lease-token <令牌> --artifact-type <类型> [--output <输出 ID>] --content-file <.acceptance 内正文文件>" },
  { command: "submit", usage: "wspec submit <workItemId> --step <步骤> --attempt <尝试> --lease <令牌> --result <结果文件>" },
  { command: "decide", usage: "wspec decide --input <决定文件> --actor <执行者>" },
  { command: "inspect", usage: "wspec inspect <workItemId>" },
  { command: "workflow", usage: "wspec workflow <list|show|eject|validate|use>" },
  { command: "agent", usage: "wspec agent install --client <codex|claude|cursor|generic> [--target <目录>] [--dry-run]" },
  { command: "doctor", usage: "wspec doctor connectors" },
]);

export const publicCliRouteDescriptors: readonly PublicCliRouteDescriptor[] = Object.freeze([
  { route: "config suggest", usage: "wspec config suggest [--test-root <path>]" },
  { route: "config migrate", usage: "wspec config migrate <workItemId> --file <configPath> --expected-digest <digest> --actor <actor>" },
  { route: "recover", usage: "wspec recover <workItemId> --actor <actor> --reason <原因>" },
  { route: "revalidate-red", usage: "wspec revalidate-red <workItemId> --expected-evidence <redEvidenceId> --actor <actor> --reason <原因>" },
  { route: "retry-test-gate", usage: "wspec retry-test-gate <workItemId> --expected-attempt <attemptId> --actor <actor> --reason <原因>" },
  { route: "init", usage: "wspec init [--test-root <path>]" },
  { route: "start", usage: "wspec start (--prompt <需求> | --file <路径> | --source-provider <github|gitlab|feishu> --source-id <稳定标识> [--source-url <规范 URL>]) [--workflow <引用>] [--profile <档位>]" },
  { route: "acquire", usage: "wspec acquire <workItemId> --actor <执行者>" },
  { route: "artifact create", usage: "wspec artifact create --work-item <Work Item> --step <步骤> --attempt <尝试> --lease-token <令牌> --artifact-type <类型> [--output <输出 ID>] --content-file <.acceptance 内正文文件>" },
  { route: "submit", usage: "wspec submit <workItemId> --step <步骤> --attempt <尝试> --lease <令牌> --result <结果文件>" },
  { route: "decide", usage: "wspec decide --input <决定文件> --actor <执行者>" },
  { route: "inspect", usage: "wspec inspect <workItemId>" },
  { route: "workflow list", usage: "wspec workflow list" },
  { route: "workflow show", usage: "wspec workflow show <引用>" },
  { route: "workflow eject", usage: "wspec workflow eject <内置引用> <目标>" },
  { route: "workflow validate", usage: "wspec workflow validate <引用> [--provider <Provider>]" },
  { route: "workflow use", usage: "wspec workflow use <引用> [--profile <档位>] [--provider <Provider>]" },
  { route: "agent install", usage: "wspec agent install --client <codex|claude|cursor|generic> [--target <目录>] [--dry-run]" },
  { route: "doctor connectors", usage: "wspec doctor connectors" },
]);

const coreRoutes: ReadonlySet<string> = new Set(["recover", "revalidate-red", "retry-test-gate", "init", "start", "acquire", "submit", "decide", "inspect"]);
const workflowRoutes: ReadonlySet<string> = new Set(["list", "show", "eject", "validate", "use"]);

export function publicCliErrorRoute(argv: readonly string[]): PublicCliErrorRoute {
  const command = argv[0];
  if (command !== undefined && coreRoutes.has(command)) return command as PublicCliRoute;
  if (command === "config") return argv[1] === "suggest" ? "config suggest" : argv[1] === "migrate" ? "config migrate" : "config";
  if (command === "workflow") {
    const subcommand = argv[1];
    return subcommand !== undefined && workflowRoutes.has(subcommand) ? `workflow ${subcommand}` as PublicCliRoute : "workflow";
  }
  if (command === "agent") return argv[1] === "install" ? "agent install" : "agent";
  if (command === "artifact") return argv[1] === "create" ? "artifact create" : "artifact";
  if (command === "doctor") return argv[1] === "connectors" ? "doctor connectors" : "dispatch";
  return "dispatch";
}
