import { readGithubComment, readGithubIssue, writeGithubIssue } from "../../adapters/connectors/github-cli.js";
import { commitGitChanges, reconcileGitCommit } from "../../adapters/connectors/git-native.js";
import { readGitlabIssue, readGitlabNote, writeGitlabIssue } from "../../adapters/connectors/gitlab-cli.js";
import { publishKnowledge, readFeishuDocument } from "../../adapters/connectors/lark-cli.js";
import { ExternalActionError, type ExternalActionExecutor, type ExternalReadBack } from "../../application/external-action.js";
import { loadApplicationState } from "../../application/state.js";
import { canonicalDigest } from "../../engine/external-effects/idempotency.js";
import type { ExternalActionName } from "../../engine/external-effects/authorization.js";
import { validateGitCommitApproval } from "./git-commit.js";
import { canonicalIssueText, validateIssueWriteAction, type IssueWriteAction } from "./issue.js";
import { validateKnowledgePublishTarget, type KnowledgePublishTarget } from "./knowledge-publish.js";
import { sha256 } from "../../domain/digests.js";
import { loadBuiltinCatalog } from "../../resources/catalog.js";
import { loadExternalActionPayload } from "../../storage/external-action-payload.js";
import { ConnectorRegistry } from "./registry.js";
import type { BuiltinConnectorRuntime } from "./runtime.js";

type IssuePayload = {
  target: Parameters<typeof readGithubIssue>[0]["target"] | Parameters<typeof readGitlabIssue>[0]["target"];
  action: IssueWriteAction;
};

type KnowledgePayload = {
  target: KnowledgePublishTarget;
  binding: Parameters<typeof publishKnowledge>[0]["binding"];
};

const aliases = { git: "git-native", github: "github-cli", gitlab: "gitlab-cli", feishu: "lark-cli" } as const;

function providerId(provider: string): "git-native" | "github-cli" | "gitlab-cli" | "lark-cli" {
  const normalized = aliases[provider as keyof typeof aliases] ?? provider;
  if (normalized !== "git-native" && normalized !== "github-cli" && normalized !== "gitlab-cli" && normalized !== "lark-cli") {
    throw new ExternalActionError("WSSPEC_CONNECTOR_PROVIDER_NOT_FOUND", `找不到 Connector provider ${provider}。`);
  }
  return normalized;
}

async function resolveProvider(provider: string, action: ExternalActionName) {
  const registry = new ConnectorRegistry();
  for (const manifest of (await loadBuiltinCatalog()).connectors) registry.register(manifest);
  return registry.resolve(action === "issue.update" ? "issue.write" : action, providerId(provider));
}

function issuePayload(value: unknown): IssuePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalActionError("WSSPEC_EXTERNAL_PAYLOAD_INVALID", "Issue payload 无效。");
  }
  return value as IssuePayload;
}

function knowledgePayload(value: unknown): KnowledgePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalActionError("WSSPEC_EXTERNAL_PAYLOAD_INVALID", "Knowledge payload 无效。");
  }
  return value as KnowledgePayload;
}

function sameLabels(actual: readonly string[], expected: readonly string[]): boolean {
  const left = actual.map(canonicalIssueText).sort();
  const right = expected.map(canonicalIssueText).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function issueMatches(actual: Awaited<ReturnType<typeof readGithubIssue>>, action: IssueWriteAction): boolean | undefined {
  if (action.type === "comment") return undefined;
  if (action.type === "issue.close") return actual.state === "closed";
  if (action.type === "body") {
    const expected = canonicalIssueText(action.body);
    return actual.body === (expected.trim() === "" ? actual.title : expected);
  }
  if (action.type === "labels") return sameLabels(actual.labels, action.labels);
  return actual.state === action.state;
}

async function durablePayload(root: string, request: Parameters<ExternalActionExecutor["execute"]>[0]["request"]): Promise<unknown> {
  const state = await loadApplicationState(root, request.workItemId);
  return loadExternalActionPayload({ controlPlane: state.projection.controlPlane, request });
}

export function createBuiltinExternalExecutor(
  runtime: BuiltinConnectorRuntime,
  provider: string,
  action: ExternalActionName,
): ExternalActionExecutor {
  const normalized = providerId(provider);
  return {
    async execute({ root, request, payload, markDispatched }) {
      const manifest = await resolveProvider(provider, action);
      const durable = await durablePayload(root, request);
      if (canonicalDigest(durable) !== canonicalDigest(payload)) {
        throw new ExternalActionError("WSSPEC_EXTERNAL_PAYLOAD_MISMATCH", "执行 payload 与持久化授权工件不一致。");
      }
      let publishedContentDigest = request.expectedContentDigest;
      let readBackContentDigest = request.expectedContentDigest;
      let externalEffectId: string | undefined;
      if (normalized === "git-native") {
        const approval = validateGitCommitApproval(durable);
        if (action !== "git.commit" || request.securityClass !== "local-write"
          || request.target.kind !== "repository" || request.provider !== "git-native"
          || approval.repositoryCommonDir !== request.target.stableId
          || approval.diffDigest !== request.expectedContentDigest
          || canonicalDigest(approval) !== canonicalDigest(durable)) {
          throw new ExternalActionError("WSSPEC_EXTERNAL_BINDING_INVALID", "Git commit approval 与持久 Request 不一致。");
        }
        const actual = await commitGitChanges({
          executable: runtime.executables.git,
          approval,
          markDispatched,
        });
        if (actual.provider !== "git-native" || actual.action !== "git.commit"
          || actual.repositoryCommonDir !== request.target.stableId
          || actual.baselineRevision !== approval.baselineRevision
          || actual.diffDigest !== request.expectedContentDigest
          || actual.readBackDigest !== request.expectedContentDigest
          || actual.status !== "verified") {
          throw new ExternalActionError("WSSPEC_EXTERNAL_READBACK_MISMATCH", "Git commit receipt 未绑定批准的仓库或 diff。");
        }
        publishedContentDigest = actual.diffDigest;
        readBackContentDigest = actual.readBackDigest;
      } else if (normalized === "github-cli") {
        const value = issuePayload(durable);
        const actual = await writeGithubIssue({
          executable: runtime.executables[manifest.executable] as string,
          target: value.target as Parameters<typeof writeGithubIssue>[0]["target"],
          action: value.action,
          ...(runtime.environments?.github === undefined ? {} : { environment: runtime.environments.github }),
          markDispatched,
        });
        if (actual.stableId !== request.target.stableId) throw new ExternalActionError("WSSPEC_EXTERNAL_READBACK_MISMATCH", "GitHub Issue 稳定身份不匹配。");
        externalEffectId = actual.externalEffectId;
      } else if (normalized === "gitlab-cli") {
        const value = issuePayload(durable);
        const actual = await writeGitlabIssue({
          executable: runtime.executables[manifest.executable] as string,
          target: value.target as Parameters<typeof writeGitlabIssue>[0]["target"],
          action: value.action,
          ...(runtime.environments?.gitlab === undefined ? {} : { environment: runtime.environments.gitlab }),
          markDispatched,
        });
        if (actual.stableId !== request.target.stableId) throw new ExternalActionError("WSSPEC_EXTERNAL_READBACK_MISMATCH", "GitLab Issue 稳定身份不匹配。");
        externalEffectId = actual.externalEffectId;
      } else {
        const value = knowledgePayload(durable);
        const actual = await publishKnowledge({
          executable: runtime.executables[manifest.executable] as string,
          target: value.target,
          binding: value.binding,
          identity: runtime.larkIdentity ?? "user",
          ...(runtime.environments?.feishu === undefined ? {} : { environment: runtime.environments.feishu }),
          markDispatched,
        });
        if (actual.stableId !== request.target.stableId
          || actual.publishedContentDigest !== request.expectedContentDigest
          || actual.readBackContentDigest !== request.expectedContentDigest) {
          throw new ExternalActionError("WSSPEC_EXTERNAL_READBACK_MISMATCH", "Feishu 文档稳定身份或正文摘要不匹配。");
        }
        publishedContentDigest = request.expectedContentDigest;
        readBackContentDigest = request.expectedContentDigest;
      }
      return {
        targetStableId: request.target.stableId,
        ...(externalEffectId === undefined ? {} : { externalEffectId }),
        publishedContentDigest,
        readBackContentDigest,
        verifiedAt: new Date().toISOString(),
      };
    },
    async reconcile({ root, request }): Promise<ExternalReadBack> {
      await resolveProvider(provider, action);
      const payload = await durablePayload(root, request);
      const checkedAt = new Date().toISOString();
      if (normalized === "git-native") {
        const approval = validateGitCommitApproval(payload);
        if (action !== "git.commit" || request.securityClass !== "local-write"
          || request.target.kind !== "repository" || request.provider !== "git-native"
          || approval.repositoryCommonDir !== request.target.stableId
          || approval.diffDigest !== request.expectedContentDigest
          || canonicalDigest(approval) !== canonicalDigest(payload)) {
          throw new ExternalActionError("WSSPEC_EXTERNAL_BINDING_INVALID", "Git commit approval 与持久 Request 不一致。");
        }
        const actual = await reconcileGitCommit({ executable: runtime.executables.git, approval });
        if (actual.outcome !== "verified") return { outcome: actual.outcome, checkedAt };
        return actual.repositoryCommonDir === request.target.stableId
          && actual.diffDigest === request.expectedContentDigest
          ? { outcome: "verified", targetStableId: request.target.stableId, contentDigest: request.expectedContentDigest, checkedAt }
          : { outcome: "failed", checkedAt };
      }
      if (normalized === "github-cli" || normalized === "gitlab-cli") {
        const value = issuePayload(payload);
        const actual = normalized === "github-cli"
          ? await readGithubIssue({ executable: runtime.executables.gh, target: value.target as Parameters<typeof readGithubIssue>[0]["target"], ...(runtime.environments?.github === undefined ? {} : { environment: runtime.environments.github }) })
          : await readGitlabIssue({ executable: runtime.executables.glab, target: value.target as Parameters<typeof readGitlabIssue>[0]["target"], ...(runtime.environments?.gitlab === undefined ? {} : { environment: runtime.environments.gitlab }) });
        const matches = issueMatches(actual, value.action);
        if (matches === undefined) return { outcome: "unknown", checkedAt };
        return matches && actual.stableId === request.target.stableId
          ? { outcome: "verified", targetStableId: request.target.stableId, contentDigest: request.payloadDigest, checkedAt }
          : { outcome: "failed", checkedAt };
      }
      const value = knowledgePayload(payload);
      const target = validateKnowledgePublishTarget(value.target);
      if (target.operation === "create") return { outcome: "unknown", checkedAt };
      const actual = await readFeishuDocument({
        executable: runtime.executables["lark-cli"],
        document: target.documentToken,
        identity: runtime.larkIdentity ?? "user",
        ...(runtime.environments?.feishu === undefined ? {} : { environment: runtime.environments.feishu }),
      });
      return actual.stableId === request.target.stableId && actual.title === target.title && actual.body === target.markdown
        && sha256(actual.body) === request.expectedContentDigest
        ? { outcome: "verified", targetStableId: request.target.stableId, contentDigest: request.expectedContentDigest, checkedAt }
        : { outcome: "failed", checkedAt };
    },
    async adopt({ root, request, externalStableId, contentDigest }): Promise<ExternalReadBack> {
      await resolveProvider(provider, action);
      const payload = await durablePayload(root, request);
      const checkedAt = new Date().toISOString();
      if (contentDigest !== request.expectedContentDigest || normalized === "git-native") {
        return { outcome: "failed", checkedAt };
      }
      if (normalized === "github-cli" || normalized === "gitlab-cli") {
        const value = issuePayload(payload);
        const writeAction = validateIssueWriteAction(value.action);
        if (writeAction.type !== "comment") return { outcome: "failed", checkedAt };
        const actual = normalized === "github-cli"
          ? await readGithubComment({
              executable: runtime.executables.gh,
              target: value.target as Parameters<typeof readGithubComment>[0]["target"],
              externalStableId,
              expectedBody: writeAction.body,
              ...(runtime.environments?.github === undefined ? {} : { environment: runtime.environments.github }),
            })
          : await readGitlabNote({
              executable: runtime.executables.glab,
              target: value.target as Parameters<typeof readGitlabNote>[0]["target"],
              externalStableId,
              expectedBody: writeAction.body,
              ...(runtime.environments?.gitlab === undefined ? {} : { environment: runtime.environments.gitlab }),
            });
        return actual.stableId === externalStableId
          ? { outcome: "verified", targetStableId: externalStableId, contentDigest: request.expectedContentDigest, checkedAt }
          : { outcome: "failed", checkedAt };
      }
      const value = knowledgePayload(payload);
      const target = validateKnowledgePublishTarget(value.target);
      const match = /^feishu:([A-Za-z0-9_-]{8,128})$/u.exec(externalStableId);
      if (target.operation !== "create" || match === null) return { outcome: "failed", checkedAt };
      const actual = await readFeishuDocument({
        executable: runtime.executables["lark-cli"],
        document: match[1]!,
        identity: runtime.larkIdentity ?? "user",
        ...(runtime.environments?.feishu === undefined ? {} : { environment: runtime.environments.feishu }),
      });
      return actual.stableId === externalStableId && actual.title === target.title && actual.body === target.markdown
        && sha256(actual.body) === request.expectedContentDigest
        ? { outcome: "verified", targetStableId: externalStableId, contentDigest: request.expectedContentDigest, checkedAt }
        : { outcome: "failed", checkedAt };
    },
  };
}
