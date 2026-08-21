import { readGithubIssue } from "../../adapters/connectors/github-cli.js";
import { readGitlabIssue } from "../../adapters/connectors/gitlab-cli.js";
import { readFeishuDocument } from "../../adapters/connectors/lark-cli.js";
import type { RequirementSourceInput } from "../../protocol/application.js";
import type { NormalizedRequirementSource } from "./requirement-source.js";
import type { LarkIdentity } from "./feishu-document.js";

export interface BuiltinConnectorRuntime {
  executables: {
    git: string;
    gh: string;
    glab: string;
    "lark-cli": string;
  };
  environments?: {
    github?: Readonly<Partial<Record<"HOME" | "XDG_CONFIG_HOME" | "GH_CONFIG_DIR", string | undefined>>>;
    gitlab?: Readonly<Partial<Record<"HOME" | "XDG_CONFIG_HOME" | "GLAB_CONFIG_DIR", string | undefined>>>;
    feishu?: Readonly<Partial<Record<"HOME" | "XDG_CONFIG_HOME" | "LARK_CONFIG_DIR", string | undefined>>>;
  };
  larkIdentity?: LarkIdentity;
}

export class ConnectorRuntimeError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ConnectorRuntimeError";
  }
}

export type ExternalNormalizedRequirementSource = Omit<NormalizedRequirementSource, "type"> & {
  type: "github.issue" | "gitlab.issue" | "feishu.document";
};

function invalid(message: string): never {
  throw new ConnectorRuntimeError("WSSPEC_SOURCE_INVALID", message);
}

function sourceUrl(source: Extract<RequirementSourceInput, { type: "issue" }>): URL {
  if (source.url !== undefined && source.url !== source.id) invalid("外部来源 id 与 url 必须引用同一规范目标。 ");
  let parsed: URL;
  try { parsed = new URL(source.id); }
  catch { return invalid("外部来源 id 必须是规范 HTTPS URL。 "); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") {
    return invalid("外部来源必须是不含认证信息、查询或片段的规范 HTTPS URL。 ");
  }
  return parsed;
}

function githubTarget(source: Extract<RequirementSourceInput, { type: "issue" }>) {
  const url = sourceUrl(source);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "issues" || !/^[1-9][0-9]*$/u.test(parts[3]!)) {
    return invalid("GitHub Issue 来源 URL 不符合 /owner/repo/issues/number。 ");
  }
  return { host: url.hostname, owner: parts[0]!, repo: parts[1]!, number: Number(parts[3]) };
}

function gitlabTarget(source: Extract<RequirementSourceInput, { type: "issue" }>) {
  const url = sourceUrl(source);
  const parts = url.pathname.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("-");
  if (marker < 1 || parts[marker + 1] !== "issues" || marker + 3 !== parts.length
    || !/^[1-9][0-9]*$/u.test(parts[marker + 2]!)) {
    return invalid("GitLab Issue 来源 URL 不符合 /project/-/issues/iid。 ");
  }
  return { host: url.hostname, projectPath: parts.slice(0, marker).join("/"), iid: Number(parts[marker + 2]) };
}

export async function captureBuiltinConnectorSource(
  source: Extract<RequirementSourceInput, { type: "issue" }>,
  runtime: BuiltinConnectorRuntime,
): Promise<ExternalNormalizedRequirementSource> {
  if (source.provider === "github" || source.provider === "github-cli") {
    return readGithubIssue({
      executable: runtime.executables.gh,
      target: githubTarget(source),
      ...(runtime.environments?.github === undefined ? {} : { environment: runtime.environments.github }),
    });
  }
  if (source.provider === "gitlab" || source.provider === "gitlab-cli") {
    return readGitlabIssue({
      executable: runtime.executables.glab,
      target: gitlabTarget(source),
      ...(runtime.environments?.gitlab === undefined ? {} : { environment: runtime.environments.gitlab }),
    });
  }
  if (source.provider === "feishu" || source.provider === "lark-cli") {
    return readFeishuDocument({
      executable: runtime.executables["lark-cli"],
      document: sourceUrl(source).toString(),
      identity: runtime.larkIdentity ?? "user",
      ...(runtime.environments?.feishu === undefined ? {} : { environment: runtime.environments.feishu }),
    });
  }
  throw new ConnectorRuntimeError("WSSPEC_CONNECTOR_PROVIDER_NOT_FOUND", `找不到需求来源 Provider ${source.provider}。`);
}
