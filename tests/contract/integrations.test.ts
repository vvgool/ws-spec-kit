import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installDriverSkill } from "../../src/adapters/skills/install.js";

test("各宿主安装中文 Driver，显式传递自身 Provider 且只使用 Application 协议循环", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-integration-home-"));
  const agents = ["codex", "claude", "cursor"] as const;
  const installed = await Promise.all(agents.map((agent) => installDriverSkill({ agent, home })));
  const contents = await Promise.all(installed.map(({ target }) => readFile(path.join(target, "SKILL.md"), "utf8")));
  for (const [index, agent] of agents.entries()) {
    const content = contents[index]!;
    assert.match(content, new RegExp(`--provider ${agent}`));
    assert.match(content, /inspect -> acquire/);
    assert.match(content, /submit/);
    assert.doesNotMatch(content, /wspec next|wspec claim|wspec context|wspec complete/);
  }
});
