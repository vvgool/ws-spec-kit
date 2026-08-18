export interface PublicCommandDescriptor {
  command: string;
  usage: string;
}

export const publicCommandDescriptors: readonly PublicCommandDescriptor[] = Object.freeze([
  { command: "init", usage: "wspec init" },
  { command: "start", usage: "wspec start --prompt <需求> [--workflow <引用>] [--profile <档位>]" },
  { command: "acquire", usage: "wspec acquire <workItemId> --actor <执行者>" },
  { command: "submit", usage: "wspec submit <workItemId> --step <步骤> --attempt <尝试> --lease <令牌> --result <结果文件>" },
  { command: "decide", usage: "wspec decide --input <决定文件> --actor <执行者>" },
  { command: "inspect", usage: "wspec inspect <workItemId>" },
  { command: "workflow", usage: "wspec workflow <list|show|eject|validate|use>" },
  { command: "agent", usage: "wspec agent install <codex|claude|cursor|generic> [--target <目录>] [--dry-run]" },
]);
