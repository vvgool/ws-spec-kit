import { spawnJson } from "../process/spawn-json.js";
import { credentialLikeValue } from "../../registry/connectors/secret-detector.js";
import {
  assertStableIssueIdentity,
  canonicalIssueText,
  IssueProviderError,
  mapIssueProcessError,
  stableId,
  validateGitlabIssueTarget,
  validateIssueWriteAction,
  validateIssueProviderEnvironment,
  type GitlabIssueTarget,
  type IssueWriteAction,
  type NormalizedIssue,
  type NormalizedIssueWriteResult,
  type ValidatedGitlabTarget,
} from "../../registry/connectors/issue.js";

const timeoutMs = 30_000;
const maxStdoutBytes = 1024 * 1024;
type GitlabEnvironment = Readonly<Partial<Record<"HOME" | "XDG_CONFIG_HOME" | "GLAB_CONFIG_DIR", string | undefined>>>;

export interface GitlabIssueReadInput {
  executable: string;
  target: GitlabIssueTarget;
  environment?: GitlabEnvironment;
}

export interface GitlabIssueWriteInput extends GitlabIssueReadInput {
  action: IssueWriteAction;
  markDispatched?(): Promise<void>;
}

export interface GitlabNoteReadInput extends GitlabIssueReadInput {
  externalStableId: string;
  expectedBody: string;
}

export interface NormalizedIssueNote {
  stableId: string;
  body: string;
}

function invalid(): never {
  throw new IssueProviderError("WSSPEC_ISSUE_RESPONSE_INVALID", "GitLab Issue 响应不符合受审计 Schema。");
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
  return text(requiredRecord(value, ["username"]).username, 256);
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  const result = value.map((label) => canonicalIssueText(text(label, 255)));
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

function mapIssue(value: unknown, target: ValidatedGitlabTarget): NormalizedIssue {
  const source = requiredRecord(value, ["assignees", "author", "description", "id", "iid", "labels", "state", "title", "updated_at", "web_url"]);
  const iid = positiveInteger(source.iid);
  const globalId = positiveInteger(source.id);
  if (iid !== target.iid || text(source.web_url, 2048) !== target.canonicalUrl) return invalid();
  const title = text(source.title, 512);
  if (source.description !== null && typeof source.description !== "string") return invalid();
  const rawBody = source.description === null ? "" : text(source.description, 1024 * 1024, true).replace(/\r\n?/gu, "\n");
  const state = source.state === "opened" ? "open" : source.state === "closed" ? "closed" : invalid();
  const issueLabels = labels(source.labels);
  const author = actor(source.author);
  const assignees = actors(source.assignees);
  const metadata: Record<string, string | string[]> = {
    repository: target.repository,
    state,
    author,
    ...(issueLabels.length === 0 ? {} : { labels: issueLabels }),
    ...(assignees.length === 0 ? {} : { assignees }),
  };
  return {
    type: "gitlab.issue",
    provider: "gitlab",
    repository: target.repository,
    number: iid,
    state,
    labels: issueLabels,
    stableId: stableId("gitlab", globalId),
    canonicalUrl: target.canonicalUrl,
    title,
    body: rawBody.trim() === "" ? title : rawBody,
    updatedAt: timestamp(source.updated_at),
    metadata,
  };
}

async function execute(input: GitlabIssueReadInput, argv: readonly string[], payload: unknown): Promise<unknown> {
  try {
    return (await spawnJson({
      executable: input.executable,
      argv,
      input: payload,
      timeoutMs,
      maxStdoutBytes,
      ...(() => {
        const environment = validateIssueProviderEnvironment(input.environment, new Set(["HOME", "XDG_CONFIG_HOME", "GLAB_CONFIG_DIR"]));
        return environment === undefined ? {} : { environment };
      })(),
    })).value;
  } catch (error) {
    return mapIssueProcessError(error);
  }
}

async function readValidated(input: GitlabIssueReadInput, target: ValidatedGitlabTarget): Promise<NormalizedIssue> {
  return mapIssue(await execute(input, ["api", "--method", "GET", target.endpoint, "--hostname", target.host], {}), target);
}

export async function readGitlabIssue(input: GitlabIssueReadInput): Promise<NormalizedIssue> {
  return readValidated(input, validateGitlabIssueTarget(input.target));
}

function mapComment(value: unknown, expectedBody: string, expectedId?: number): NormalizedIssueNote {
  const source = requiredRecord(value, ["body", "id"]);
  const id = positiveInteger(source.id);
  const body = canonicalIssueText(text(source.body, 1024 * 1024));
  if ((expectedId !== undefined && id !== expectedId) || body !== canonicalIssueText(expectedBody)) {
    throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitLab note 响应与批准内容不一致。");
  }
  return { stableId: `gitlab-note:${id}`, body };
}

export async function readGitlabNote(input: GitlabNoteReadInput): Promise<NormalizedIssueNote> {
  const target = validateGitlabIssueTarget(input.target);
  const match = /^gitlab-note:([1-9][0-9]{0,15})$/u.exec(input.externalStableId);
  const id = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(id)) {
    throw new IssueProviderError("WSSPEC_ISSUE_TARGET_INVALID", "GitLab note 稳定标识无效。");
  }
  const value = await execute(input, ["api", "--method", "GET", `${target.endpoint}/notes/${id}`, "--hostname", target.host], {});
  const source = requiredRecord(value, ["noteable_iid", "noteable_type"]);
  if (source.noteable_type !== "Issue" || positiveInteger(source.noteable_iid) !== target.iid) {
    throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitLab note 不属于批准的 Issue。");
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
    throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitLab Issue 回读结果与批准写入不一致。");
  }
}

async function mutateIssue(
  input: GitlabIssueReadInput,
  target: ValidatedGitlabTarget,
  method: "POST" | "PUT",
  endpoint: string,
  payload: unknown,
): Promise<unknown> {
  return execute(input, ["api", "--method", method, endpoint, "--hostname", target.host, "--input", "-"], payload);
}

export async function writeGitlabIssue(input: GitlabIssueWriteInput): Promise<NormalizedIssueWriteResult> {
  const target = validateGitlabIssueTarget(input.target);
  const action = validateIssueWriteAction(input.action);
  if (action.type === "issue.close") {
    const before = await readValidated(input, target);
    if (before.state === "closed") {
      await input.markDispatched?.();
      return before;
    }
    await input.markDispatched?.();
    const writeResult = mapIssue(await mutateIssue(input, target, "PUT", target.endpoint, { state_event: "close" }), target);
    assertStableIssueIdentity(before, writeResult);
    if (writeResult.state !== "closed") {
      throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitLab close 写响应不是 closed。");
    }
    const after = await readValidated(input, target);
    assertStableIssueIdentity(before, after);
    if (after.state !== "closed") {
      throw new IssueProviderError("WSSPEC_ISSUE_READBACK_MISMATCH", "GitLab close 回读状态不是 closed。");
    }
    return after;
  }
  if (action.type === "comment") {
    await input.markDispatched?.();
    const posted = mapComment(
      await mutateIssue(input, target, "POST", `${target.endpoint}/notes`, { body: action.body }),
      action.body,
    );
    const confirmed = await readGitlabNote({
      ...input,
      externalStableId: posted.stableId,
      expectedBody: action.body,
    });
    const after = await readValidated(input, target);
    return { ...after, externalEffectId: confirmed.stableId };
  }
  const before = input.markDispatched === undefined ? undefined : await readValidated(input, target);
  const payload = action.type === "body" ? { description: action.body }
    : action.type === "labels" ? { labels: [...action.labels] }
      : { state_event: "reopen" };
  await input.markDispatched?.();
  const writeResult = mapIssue(await mutateIssue(input, target, "PUT", target.endpoint, payload), target);
  if (before !== undefined) assertStableIssueIdentity(before, writeResult);
  const after = await readValidated(input, target);
  assertStableIssueIdentity(writeResult, after);
  assertActionReadback(after, action);
  return after;
}
