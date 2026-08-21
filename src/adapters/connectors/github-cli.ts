import { spawnJson } from "../process/spawn-json.js";
import { credentialLikeValue } from "../../registry/connectors/secret-detector.js";
import {
  assertStableIssueIdentity,
  canonicalIssueText,
  IssueProviderError,
  mapIssueProcessError,
  stableId,
  validateGithubIssueTarget,
  validateIssueWriteAction,
  validateIssueProviderEnvironment,
  type GithubIssueTarget,
  type IssueWriteAction,
  type NormalizedIssue,
  type NormalizedIssueWriteResult,
  type ValidatedGithubTarget,
} from "../../registry/connectors/issue.js";

const timeoutMs = 30_000;
const maxStdoutBytes = 1024 * 1024;
type GithubEnvironment = Readonly<Partial<Record<"HOME" | "XDG_CONFIG_HOME" | "GH_CONFIG_DIR", string | undefined>>>;

export interface GithubIssueReadInput {
  executable: string;
  target: GithubIssueTarget;
  environment?: GithubEnvironment;
}

export interface GithubIssueWriteInput extends GithubIssueReadInput {
  action: IssueWriteAction;
  markDispatched?(): Promise<void>;
}

export interface GithubCommentReadInput extends GithubIssueReadInput {
  externalStableId: string;
  expectedBody: string;
}

export interface NormalizedIssueComment {
  stableId: string;
  body: string;
}

function invalid(): never {
  throw new IssueProviderError("WSSPEC_ISSUE_RESPONSE_INVALID", "GitHub Issue 响应不符合受审计 Schema。");
}

function requiredRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || keys.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0")
    || (!allowEmpty && value === "") || credentialLikeValue(value)) return invalid();
  return value.normalize("NFC");
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function actor(value: unknown): string {
  const source = requiredRecord(value, ["login"]);
  return text(source.login, 256);
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  const result = value.map((label) => canonicalIssueText(text(requiredRecord(label, ["name"]).name, 255)));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}

function actors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  const result = value.map(actor);
  if (new Set(result).size !== result.length) return invalid();
  return result;
}

function timestamp(value: unknown): string {
  const source = text(value, 64);
  const parsed = Date.parse(source);
  if (!Number.isFinite(parsed)) return invalid();
  return new Date(parsed).toISOString();
}

function mapIssue(value: unknown, target: ValidatedGithubTarget): NormalizedIssue {
  const source = requiredRecord(value, ["assignees", "body", "html_url", "labels", "node_id", "number", "state", "title", "updated_at", "user"]);
  const number = positiveInteger(source.number);
  if (number !== target.number || text(source.html_url, 2048) !== target.canonicalUrl) return invalid();
  const title = text(source.title, 512);
  if (source.body !== null && typeof source.body !== "string") return invalid();
  const rawBody = source.body === null ? "" : text(source.body, 1024 * 1024, true).replace(/\r\n?/gu, "\n");
  const state = source.state === "open" || source.state === "closed" ? source.state : invalid();
  const issueLabels = labels(source.labels);
  const author = actor(source.user);
  const assignees = actors(source.assignees);
  const metadata: Record<string, string | string[]> = {
    repository: target.repository,
    state,
    author,
    ...(issueLabels.length === 0 ? {} : { labels: issueLabels }),
    ...(assignees.length === 0 ? {} : { assignees }),
  };
  return {
    type: "github.issue",
    provider: "github",
    repository: target.repository,
    number,
    state,
    labels: issueLabels,
    stableId: stableId("github", source.node_id),
    canonicalUrl: target.canonicalUrl,
    title,
    body: rawBody.trim() === "" ? title : rawBody,
    updatedAt: timestamp(source.updated_at),
    metadata,
  };
}

async function execute(input: GithubIssueReadInput, argv: readonly string[], payload: unknown): Promise<unknown> {
  try {
    return (await spawnJson({
      executable: input.executable,
      argv,
      input: payload,
      timeoutMs,
      maxStdoutBytes,
      ...(() => {
        const environment = validateIssueProviderEnvironment(input.environment, new Set(["HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"]));
        return environment === undefined ? {} : { environment };
      })(),
    })).value;
  } catch (error) {
    return mapIssueProcessError(error);
  }
}

async function readValidated(input: GithubIssueReadInput, target: ValidatedGithubTarget): Promise<NormalizedIssue> {
  const value = await execute(input, ["api", "--method", "GET", target.endpoint, "--hostname", target.host], {});
  return mapIssue(value, target);
}

export async function readGithubIssue(input: GithubIssueReadInput): Promise<NormalizedIssue> {
  const target = validateGithubIssueTarget(input.target);
  return readValidated(input, target);
}

function mapComment(value: unknown, expectedBody: string, expectedId?: number): NormalizedIssueComment {
  const source = requiredRecord(value, ["body", "id", "node_id"]);
  const id = positiveInteger(source.id);
  stableId("github", source.node_id);
  const body = canonicalIssueText(text(source.body, 1024 * 1024));
  if ((expectedId !== undefined && id !== expectedId) || body !== canonicalIssueText(expectedBody)) {
    throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitHub comment 响应与批准内容不一致。");
  }
  return { stableId: `github-comment:${id}`, body };
}

export async function readGithubComment(input: GithubCommentReadInput): Promise<NormalizedIssueComment> {
  const target = validateGithubIssueTarget(input.target);
  const match = /^github-comment:([1-9][0-9]{0,15})$/u.exec(input.externalStableId);
  const id = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(id)) {
    throw new IssueProviderError("WSSPEC_ISSUE_TARGET_INVALID", "GitHub comment 稳定标识无效。");
  }
  const value = await execute(input, ["api", "--method", "GET", `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/comments/${id}`, "--hostname", target.host], {});
  const source = requiredRecord(value, ["issue_url"]);
  let issueUrl: URL;
  try { issueUrl = new URL(text(source.issue_url, 2_048)); }
  catch { return invalid(); }
  const expectedPaths = new Set([`/${target.endpoint}`, `/api/v3/${target.endpoint}`]);
  const expectedHost = issueUrl.hostname === target.host || (target.host === "github.com" && issueUrl.hostname === "api.github.com");
  if (issueUrl.protocol !== "https:" || !expectedHost || issueUrl.port !== ""
    || issueUrl.username !== "" || issueUrl.password !== "" || issueUrl.search !== "" || issueUrl.hash !== ""
    || !expectedPaths.has(issueUrl.pathname)) {
    throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitHub comment 不属于批准的 Issue。");
  }
  return mapComment(value, input.expectedBody, id);
}

function sameLabels(actual: readonly string[], expected: readonly string[]): boolean {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const sortedActual = actual.map(canonicalIssueText).sort(compare);
  const sortedExpected = expected.map(canonicalIssueText).sort(compare);
  return sortedActual.length === sortedExpected.length && sortedActual.every((label, index) => label === sortedExpected[index]);
}

function assertActionReadback(issue: NormalizedIssue, action: Exclude<IssueWriteAction, { type: "issue.close" }>): void {
  const expectedBody = action.type === "body" ? canonicalIssueText(action.body) : undefined;
  if ((action.type === "body" && issue.body !== (expectedBody!.trim() === "" ? issue.title : expectedBody))
    || (action.type === "labels" && !sameLabels(issue.labels, action.labels))
    || (action.type === "state" && issue.state !== action.state)) {
    throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitHub Issue 回读结果与批准写入不一致。");
  }
}

async function mutateIssue(
  input: GithubIssueReadInput,
  target: ValidatedGithubTarget,
  method: "POST" | "PATCH",
  endpoint: string,
  payload: unknown,
): Promise<unknown> {
  return execute(input, ["api", "--method", method, endpoint, "--hostname", target.host, "--input", "-"], payload);
}

export async function writeGithubIssue(input: GithubIssueWriteInput): Promise<NormalizedIssueWriteResult> {
  const target = validateGithubIssueTarget(input.target);
  const action = validateIssueWriteAction(input.action);
  if (action.type === "issue.close") {
    const before = await readValidated(input, target);
    if (before.state === "closed") {
      await input.markDispatched?.();
      return before;
    }
    await input.markDispatched?.();
    const writeResult = mapIssue(await mutateIssue(input, target, "PATCH", target.endpoint, { state: "closed" }), target);
    assertStableIssueIdentity(before, writeResult);
    if (writeResult.state !== "closed") {
      throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitHub close 写响应不是 closed。");
    }
    const after = await readValidated(input, target);
    assertStableIssueIdentity(before, after);
    if (after.state !== "closed") {
      throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitHub close 回读状态不是 closed。");
    }
    return after;
  }
  if (action.type === "comment") {
    await input.markDispatched?.();
    const posted = mapComment(
      await mutateIssue(input, target, "POST", `${target.endpoint}/comments`, { body: action.body }),
      action.body,
    );
    const confirmed = await readGithubComment({
      ...input,
      externalStableId: posted.stableId,
      expectedBody: action.body,
    });
    const after = await readValidated(input, target);
    return { ...after, externalEffectId: confirmed.stableId };
  }
  const before = input.markDispatched === undefined ? undefined : await readValidated(input, target);
  const payload = action.type === "body" ? { body: action.body }
    : action.type === "labels" ? { labels: [...action.labels] }
      : { state: action.state };
  await input.markDispatched?.();
  const writeResult = mapIssue(await mutateIssue(input, target, "PATCH", target.endpoint, payload), target);
  if (before !== undefined) assertStableIssueIdentity(before, writeResult);
  const after = await readValidated(input, target);
  assertStableIssueIdentity(writeResult, after);
  assertActionReadback(after, action);
  return after;
}
