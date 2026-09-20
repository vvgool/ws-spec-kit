import assert from "node:assert/strict";
import test from "node:test";
import { assertPublishCi } from "../../scripts/check-publish-ci.mjs";

const sha = "a".repeat(40);
const names = ["Quality", "Contract tests", "Unit tests", "Integration tests", "End-to-end tests", "Package contents"];
function evidence() {
  return {
    head: sha, branch: "main", dirty: "", tagHead: sha, remoteMain: sha, remoteTag: sha,
    run: { headSha: sha, event: "push", headBranch: "main", status: "completed", conclusion: "success",
      jobs: names.map(name => ({ name, status: "completed", conclusion: "success" })) },
  };
}

test("publish requires clean main, matching local/remote version tag and complete CI for the same commit", () => {
  assert.doesNotThrow(() => assertPublishCi(evidence()));
  for (const mutation of [
    { head: "b".repeat(40) }, { branch: "feature" }, { dirty: " M package.json" },
    { tagHead: "b".repeat(40) }, { remoteMain: "b".repeat(40) }, { remoteTag: "" },
  ]) assert.throws(() => assertPublishCi({ ...evidence(), ...mutation }));
  for (const mutation of [
    { headSha: "b".repeat(40) }, { event: "pull_request" }, { headBranch: "feature" },
    { status: "in_progress" }, { conclusion: "failure" }, { jobs: [] },
    { jobs: evidence().run.jobs.slice(1) },
    { jobs: evidence().run.jobs.map(job => ({ ...job, conclusion: "skipped" })) },
    { jobs: [...evidence().run.jobs, { name: "Extra gate", status: "completed", conclusion: "failure" }] },
  ]) assert.throws(() => assertPublishCi({ ...evidence(), run: { ...evidence().run, ...mutation } }));
});
