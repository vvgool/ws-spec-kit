export interface PublishCiEvidence {
  head: string;
  branch: string;
  dirty: string;
  tagHead: string;
  remoteMain: string;
  remoteTag: string;
  run: {
    headSha: string;
    event: string;
    headBranch: string;
    status: string;
    conclusion: string;
    jobs: Array<{ name: string; status: string; conclusion: string }>;
  };
}
export function assertPublishCi(input: PublishCiEvidence): void;
export function checkPublishCi(cwd?: string): void;
