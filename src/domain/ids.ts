export type RepositoryId = `repo-${string}`;
export type WorkItemId = `WSS-${string}`;
export type ErrorCode = `WSSPEC_${string}`;
export type StageId = string;
export type AttemptId = `attempt-${string}`;

const workItemIdPattern = /^WSS-[A-Za-z0-9-]+$/;
const errorCodePattern = /^WSSPEC_[A-Z0-9_]+$/;

export const isWorkItemId = (value: string): value is WorkItemId => workItemIdPattern.test(value);
export const isErrorCode = (value: string): value is ErrorCode => errorCodePattern.test(value);
