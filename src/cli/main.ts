#!/usr/bin/env node

import { errorOutput, json } from "../adapters/cli/output.js";
import { runCommand } from "./commands/core.js";

const help = {
  名称: "WSSpecKit",
  用法: [
    "wspec init",
    "wspec start --prompt <需求> [--workflow <引用>] [--profile <档位>]",
    "wspec acquire <workItemId> --actor <执行者>",
    "wspec submit <workItemId> --step <步骤> --attempt <尝试> --lease <令牌> --result <结果文件>",
    "wspec decide --input <决定文件> --actor <执行者>",
    "wspec inspect <workItemId>",
    "wspec workflow <list|show|eject|validate|use>",
    "wspec agent install <codex|claude|cursor|generic> [--target <目录>] [--dry-run]",
  ],
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h" || argv.length === 0) process.stdout.write(json({ ok: true, help }));
  else if (argv[0] === "--version") process.stdout.write(json({ ok: true, version: "0.1.0-alpha.1" }));
  else process.stdout.write(json({ ok: true, result: await runCommand(process.cwd(), argv) }));
}

main().catch((error: unknown) => {
  process.stdout.write(json(errorOutput(error)));
  process.exitCode = 1;
});
