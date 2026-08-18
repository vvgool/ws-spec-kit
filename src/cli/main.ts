#!/usr/bin/env node

import { errorOutput, json } from "../adapters/cli/output.js";
import { publicCommandDescriptors } from "./commands/public-contract.js";
import { runCommand } from "./commands/core.js";

const help = {
  名称: "WSSpecKit",
  用法: publicCommandDescriptors.map(({ usage }) => usage),
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
