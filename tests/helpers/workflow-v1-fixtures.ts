export const workflowV1Fixture = `version: 1
workflow: { id: fixture-workflow, version: 1 }
inputs:
  requirement: { accepts: [user.prompt, local.file] }
steps:
  - id: review-fix
    uses: control.loop
    workspace: isolated-worktree
    needs: [intake]
    retry: { maxAttempts: 2 }
    outputs: [review-result]
    steps:
      - id: review
        uses: agent.execute
        workspace: read-only
        actorRole: review
        outputs: [review-result]
gates:
  - id: test
    evidence: trusted
    command: [npm, test]
changePolicy: { kind: feature, allowedPaths: ['**'] }
`;

export const profileV1Fixture = `version: 1
profile: { id: standard, workflow: fixture-workflow }
steps:
  review-fix:
    approval: true
    artifacts:
      review-result: { required: true, contentLevel: complete }
    gates: [test]
    maxIterations: 5
    independentReviewActor: true
publishing:
  issueRequired: true
  knowledgeRequired: true
  readBackRequired: true
audit:
  level: complete
  retention: extended
  recordDecisions: true
  recordApprovals: true
  recordActors: true
  recordPublishing: true
`;

export const invalidWorkflowV1Fixtures = [
  ["workflow top-level unknown", `${workflowV1Fixture}typo: true\n`],
  ["workflow nested unknown", workflowV1Fixture.replace("retry: { maxAttempts: 2 }", "retry: { maxAttempts: 2, typo: true }")],
  ["workflow nested type", workflowV1Fixture.replace("retry: { maxAttempts: 2 }", "retry: { maxAttempts: wrong }")],
  ["workflow actor role", workflowV1Fixture.replace("actorRole: review", "actorRole: reviewer")],
] as const;

export const invalidProfileV1Fixtures = [
  ["profile artifact unknown", profileV1Fixture.replace("required: true, contentLevel: complete", "required: true, contentLevel: complete, typo: true")],
  ["profile artifact type", profileV1Fixture.replace("required: true, contentLevel: complete", "required: wrong, contentLevel: complete")],
  ["profile independent actor type", profileV1Fixture.replace("independentReviewActor: true", "independentReviewActor: wrong")],
  ["profile audit unknown", profileV1Fixture.replace("recordPublishing: true", "recordPublishing: true\n  typo: true")],
  ["profile audit policy type", profileV1Fixture.replace("recordDecisions: true", "recordDecisions: wrong")],
] as const;
