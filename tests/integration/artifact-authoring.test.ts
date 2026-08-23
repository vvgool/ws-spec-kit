import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createArtifactDocument, readArtifact } from "../../src/domain/artifacts.js";
import type { ArtifactCreateInput, SubmitResult } from "../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../src/protocol/work-package.js";
import { git } from "./helpers/git.js";
import { readControlPlane, recoverControlPlane, replayEvents } from "../../src/storage/control-plane.js";
import { readEvents } from "../../src/storage/events.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { createApplicationArtifact, type ArtifactAuthoringDependencies } from "../../src/application/artifact.js";
import { workPackageIdentityDigest } from "../../src/domain/work-package-identity.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fixedNow = () => new Date("2026-08-18T04:00:00.000Z");
import {
  controlRuntimeFixture,
  requireExecute,
  rewriteSelectedSnapshot,
  submitPackage,
  worktreeFor,
} from "./helpers/control-runtime.js";

function completed(workPackage: WorkPackage): SubmitResult {
  const source = workPackage.artifacts.find((artifact) => artifact.artifactType === "requirement-source");
  return {
    version: 1,
    status: "completed",
    summary: `${workPackage.stepId} 完成`,
    modifiedFiles: [],
    artifacts: workPackage.requiredOutputs.map((output) => output.artifactType === "requirement-source" ? source! : output),
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  };
}

async function activeExplore(now?: () => Date): Promise<{
  fixture: Awaited<ReturnType<typeof controlRuntimeFixture>>;
  worktree: string;
  workPackage: WorkPackage;
}> {
  const fixture = await controlRuntimeFixture(now === undefined ? {} : { now });
  await writeFile(path.join(fixture.root, ".gitignore"), ".worktrees/\n.acceptance/\n.wsspec/work-items/\n", "utf8");
  await git(fixture.root, "add", ".gitignore");
  await git(fixture.root, "commit", "-m", "test: ignore authoring drafts");
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "验证 Artifact authoring" }, profile: "quick" });
  const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  const explore = requireExecute(await submitPackage(fixture, intake, completed(intake)));
  return { fixture, worktree: await worktreeFor(fixture.root, started.workItemId), workPackage: explore };
}

async function createArtifact(
  fixture: Awaited<ReturnType<typeof controlRuntimeFixture>>,
  input: ArtifactCreateInput,
): Promise<ArtifactReference> {
  return createApplicationArtifact(input, { now: fixture.now });
}

async function replaceRequiredOutputs(
  fixture: Awaited<ReturnType<typeof controlRuntimeFixture>>,
  workPackage: WorkPackage,
  requiredOutputs: WorkPackage["requiredOutputs"],
  removeAuthoring = false,
): Promise<void> {
  const workflowOutputs = (outputs: WorkPackage["requiredOutputs"]) => outputs.map((output) => ({
    outputId: output.outputId ?? output.artifactType,
    artifact: output.artifactType,
    required: true,
    ...(output.contentLevel === undefined ? {} : { contentLevel: output.contentLevel }),
  }));
  if (JSON.stringify(workflowOutputs(requiredOutputs)) !== JSON.stringify(workflowOutputs(workPackage.requiredOutputs))) {
    await rewriteSelectedSnapshot(fixture, workPackage.workItemId, (profile) => {
      const step = profile.steps.find(({ id }) => id === workPackage.stepId);
      assert.ok(step);
      const previousOutputIds = new Set((step.outputs as Array<{ outputId?: unknown }>).flatMap(({ outputId }) => {
        return typeof outputId === "string" ? [outputId] : [];
      }));
      step.outputs = workflowOutputs(requiredOutputs);
      for (const candidate of profile.steps) {
        if (!Array.isArray(candidate.inputs) || !candidate.inputs.some((input) => {
          return input !== null && typeof input === "object" && !Array.isArray(input)
            && previousOutputIds.has((input as { outputId?: unknown }).outputId as string);
        })) continue;
        candidate.inputs = requiredOutputs.map((output) => ({
          outputId: output.outputId ?? output.artifactType,
          required: true,
        }));
      }
    });
  }
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: workPackage.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: `test:artifact-outputs:${crypto.randomUUID()}`,
    operationInput: { requiredOutputs, removeAuthoring },
    mutate: (projection) => {
      const active = Object.entries(projection.claims).find(([, claim]) => claim.stageId === workPackage.stepId);
      assert.ok(active);
      const context = projection.contexts[active[0]] as { workPackage: WorkPackage };
      const { artifactAuthoring: _authoring, ...withoutAuthoring } = context.workPackage;
      const nextWorkPackage = {
        ...(removeAuthoring ? withoutAuthoring : context.workPackage),
        requiredOutputs,
      } as WorkPackage;
      return {
        projection: {
          ...projection,
          contexts: {
            ...projection.contexts,
            [active[0]]: {
              ...context,
              workPackage: nextWorkPackage,
            },
          },
          claims: {
            ...projection.claims,
            [active[0]]: {
              ...active[1],
              workPackageDigest: workPackageIdentityDigest(nextWorkPackage),
            },
          },
        },
        value: null,
      };
    },
  });
}

test("active WorkPackage authors a canonical ArtifactRef from an ignored draft", async () => {
  const { fixture, worktree, workPackage } = await activeExplore();
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  await writeFile(path.join(worktree, ".acceptance", "exploration.md"), "# Exploration\r\n\r\nRepository facts.  \r\n", "utf8");

  const reference = await createArtifact(fixture, {
    root: worktree,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    artifactType: "exploration-report",
    contentFile: ".acceptance/exploration.md",
  });

  const expectedContentLevel = workPackage.requiredOutputs.find(({ outputId }) => outputId === reference.outputId)?.contentLevel;
  assert.deepEqual(Object.keys(reference).sort(), [
    "artifactType", "contentHash", ...(expectedContentLevel === undefined ? [] : ["contentLevel"]),
    "mediaType", "outputId", "path", "revision", "schemaVersion",
  ]);
  assert.equal(reference.artifactType, "exploration-report");
  assert.equal(reference.outputId, "exploration-report");
  assert.equal(reference.schemaVersion, 1);
  assert.equal(reference.revision, 1);
  assert.equal(reference.contentLevel, expectedContentLevel);
  assert.match(reference.path ?? "", new RegExp(`^\\.wsspec/work-items/${workPackage.workItemId}/artifacts/exploration-report/[a-f0-9]{64}\\.md$`, "u"));
  assert.match(reference.contentHash ?? "", /^sha256:[a-f0-9]{64}$/u);

  const stored = await readArtifact(path.join(worktree, reference.path!));
  assert.equal(stored.body, "# Exploration\n\nRepository facts.\n");
  assert.equal(stored.metadata.workItemId, workPackage.workItemId);
  assert.equal(stored.metadata.stageId, workPackage.stepId);
  assert.equal(stored.metadata.attemptId, workPackage.attemptId);
  const storedInfo = await lstat(path.join(worktree, reference.path!), { bigint: true });
  assert.equal(storedInfo.mode & 0o777n, 0o600n);
  assert.equal(storedInfo.uid, BigInt(process.getuid!()));
  for (const directory of [path.dirname(path.dirname(path.join(worktree, reference.path!))), path.dirname(path.join(worktree, reference.path!))]) {
    const info = await lstat(directory, { bigint: true });
    assert.equal(info.mode & 0o022n, 0n);
    assert.equal(info.uid, BigInt(process.getuid!()));
  }

  const next = requireExecute(await submitPackage(fixture, workPackage, {
    ...completed(workPackage),
    artifacts: [reference],
  }));
  assert.equal(next.stepId, "clarify");
});

test("同一 active Attempt 在 modifiedFiles 被拒后仍可复用同一个 ArtifactRef", async () => {
  const { fixture, worktree, workPackage } = await activeExplore();
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  await writeFile(path.join(worktree, ".acceptance", "retry.md"), "# Retry\n\nRepository facts.\n", "utf8");

  const reference = await createArtifact(fixture, {
    root: worktree,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    artifactType: "exploration-report",
    contentFile: ".acceptance/retry.md",
  });
  const artifacts = [reference];

  await assert.rejects(
    submitPackage(fixture, workPackage, {
      ...completed(workPackage),
      artifacts,
      modifiedFiles: ["src/not-real.ts"],
    }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_MODIFIED_FILES_MISMATCH",
  );

  const next = requireExecute(await submitPackage(fixture, workPackage, {
    ...completed(workPackage),
    artifacts,
    modifiedFiles: [],
  }));
  assert.equal(next.stepId, "clarify");
});

test("submit rejects a canonical-looking Artifact that has no durable authoring event", async () => {
  const { fixture, worktree, workPackage } = await activeExplore();
  const document = createArtifactDocument({
    artifactType: "exploration-report",
    outputId: "exploration-report",
    workItemId: workPackage.workItemId,
    stageId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    body: "# Bypassed authoring\n",
  });
  const relative = `.wsspec/work-items/${workPackage.workItemId}/artifacts/exploration-report/${document.reference.contentHash.slice("sha256:".length)}.md`;
  await mkdir(path.dirname(path.join(worktree, relative)), { recursive: true, mode: 0o700 });
  await writeFile(path.join(worktree, relative), document.content, { encoding: "utf8", mode: 0o600 });

  await assert.rejects(
    submitPackage(fixture, workPackage, {
      ...completed(workPackage),
      artifacts: [{ ...document.reference, path: relative }],
    }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_REFERENCE_INVALID",
  );
});

test("unsafe Artifact output directories and conflicting content-addressed targets fail closed", async (t) => {
  await t.test("symlink output root", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    const outside = await mkdtemp(path.join(os.tmpdir(), "wspec-authored-outside-"));
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts");
    await symlink(outside, artifactRoot);
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    const marker = `linked-output-${crypto.randomUUID()}`;
    await writeFile(path.join(worktree, ".acceptance", "linked-output.md"), `# Linked\n\n${marker}\n`, "utf8");

    let rejected: Error | undefined;
    await assert.rejects(
      createArtifact(fixture, {
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: "exploration-report",
        contentFile: ".acceptance/linked-output.md",
      }),
      (error: unknown) => {
        if (error instanceof Error) rejected = error;
        return error instanceof Error && "code" in error
          && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_CONFLICT";
      },
    );
    assert.doesNotMatch(rejected?.message ?? "", new RegExp(marker, "u"));
    assert.doesNotMatch(rejected?.message ?? "", new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.deepEqual(await readdir(outside), []);
  });

  await t.test("group-writable output root", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts");
    await mkdir(artifactRoot, { mode: 0o700 });
    await chmod(artifactRoot, 0o770);
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "unsafe-mode.md"), "# Unsafe mode\n", "utf8");
    await assert.rejects(
      createArtifact(fixture, {
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: "exploration-report",
        contentFile: ".acceptance/unsafe-mode.md",
      }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_CONFLICT",
    );
  });

  await t.test("mismatching existing target", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    const body = "# Expected target\n";
    const document = createArtifactDocument({
      artifactType: "exploration-report",
      outputId: "exploration-report",
      workItemId: workPackage.workItemId,
      stageId: workPackage.stepId,
      attemptId: workPackage.attemptId,
      body,
    });
    const relative = `.wsspec/work-items/${workPackage.workItemId}/artifacts/exploration-report/${document.reference.contentHash.slice("sha256:".length)}.md`;
    const target = path.join(worktree, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, "hostile-existing-bytes\n", { encoding: "utf8", mode: 0o600 });
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "existing.md"), body, "utf8");

    await assert.rejects(
      createArtifact(fixture, {
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: "exploration-report",
        contentFile: ".acceptance/existing.md",
      }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_CONFLICT",
    );
    assert.equal(await readFile(target, "utf8"), "hostile-existing-bytes\n");
  });
});

test("unsafe, nonignored, linked, and oversized drafts fail before an Artifact is left behind", async (t) => {
  const scenarios = [
    {
      name: "outside",
      expected: "WSSPEC_ARTIFACT_DRAFT_PATH_INVALID",
      prepare: async (worktree: string) => {
        const filename = path.join(worktree, "..", `outside-${crypto.randomUUID()}.md`);
        await writeFile(filename, "# Outside\n", "utf8");
        return `../${path.basename(filename)}`;
      },
    },
    {
      name: "nonignored",
      expected: "WSSPEC_ARTIFACT_DRAFT_NOT_IGNORED",
      prepare: async (worktree: string) => {
        const exclude = await git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
        const retained = (await readFile(exclude, "utf8")).split("\n").filter((line) => line !== ".acceptance/");
        await writeFile(exclude, retained.join("\n"), "utf8");
        await writeFile(path.join(worktree, ".gitignore"), ".worktrees/\n.wsspec/work-items/\n", "utf8");
        await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
        await writeFile(path.join(worktree, ".acceptance", "unignored.md"), "# Dirty\n", "utf8");
        return ".acceptance/unignored.md";
      },
    },
    {
      name: "symlink",
      expected: "WSSPEC_ARTIFACT_DRAFT_PATH_INVALID",
      prepare: async (worktree: string) => {
        await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
        await writeFile(path.join(worktree, ".acceptance", "target.md"), "# Target\n", "utf8");
        await symlink("target.md", path.join(worktree, ".acceptance", "link.md"));
        return ".acceptance/link.md";
      },
    },
    {
      name: "hardlink",
      expected: "WSSPEC_ARTIFACT_DRAFT_PATH_INVALID",
      prepare: async (worktree: string) => {
        await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
        await writeFile(path.join(worktree, ".acceptance", "target.md"), "# Target\n", "utf8");
        await link(path.join(worktree, ".acceptance", "target.md"), path.join(worktree, ".acceptance", "hard.md"));
        return ".acceptance/hard.md";
      },
    },
    {
      name: "oversized",
      expected: "WSSPEC_ARTIFACT_DRAFT_TOO_LARGE",
      prepare: async (worktree: string) => {
        await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
        await writeFile(path.join(worktree, ".acceptance", "large.md"), Buffer.alloc(1_048_577, 0x61));
        return ".acceptance/large.md";
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { fixture, worktree, workPackage } = await activeExplore();
      const contentFile = await scenario.prepare(worktree);
      await assert.rejects(
        createArtifact(fixture, {
          root: worktree,
          workItemId: workPackage.workItemId,
          stepId: workPackage.stepId,
          attemptId: workPackage.attemptId,
          leaseToken: workPackage.lease.token,
          artifactType: "exploration-report",
          contentFile,
        }),
        (error: unknown) => error instanceof Error && "code" in error
          && (error as Error & { code: string }).code === scenario.expected,
      );
      const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts");
      assert.deepEqual(await readdir(artifactRoot).catch(() => []), []);
    });
  }
});

test("same-actor reacquire invalidates the old lease for Artifact authoring", async () => {
  const { fixture, worktree, workPackage: stale } = await activeExplore();
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  await writeFile(path.join(worktree, ".acceptance", "reacquired.md"), "# Reacquired\n", "utf8");
  const replacement = requireExecute(await fixture.app.acquire({
    root: worktree,
    workItemId: stale.workItemId,
    actor: "codex",
  }));
  assert.equal(replacement.attemptId, stale.attemptId);
  assert.notEqual(replacement.lease.token, stale.lease.token);

  const request = {
    root: worktree,
    workItemId: stale.workItemId,
    stepId: stale.stepId,
    attemptId: stale.attemptId,
    artifactType: "exploration-report",
    contentFile: ".acceptance/reacquired.md",
  } as const;
  await assert.rejects(
    createArtifact(fixture, { ...request, leaseToken: stale.lease.token }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_ATTEMPT_NOT_ACTIVE",
  );
  assert.equal((await createArtifact(fixture, { ...request, leaseToken: replacement.lease.token })).outputId, "exploration-report");
});

test("concurrent and fresh-process-equivalent authoring is idempotent and records only safe digests", async () => {
  const { fixture, worktree, workPackage } = await activeExplore();
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  const draft = path.join(worktree, ".acceptance", "idempotent.md");
  const secretBody = `# Idempotent\n\nbody-${crypto.randomUUID()}\n`;
  await writeFile(draft, secretBody, "utf8");
  const request: ArtifactCreateInput = {
    root: worktree,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    artifactType: "exploration-report",
    contentFile: ".acceptance/idempotent.md",
  };

  const [first, concurrent] = await Promise.all([
    createArtifact(fixture, request),
    createArtifact(fixture, request),
  ]);
  assert.deepEqual(concurrent, first);
  fixture.restart();
  assert.deepEqual(await createArtifact(fixture, request), first);

  await writeFile(draft, `${secretBody}changed\n`, "utf8");
  await assert.rejects(
    createArtifact(fixture, request),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_CONFLICT",
  );

  const projection = await readControlPlane(worktree, workPackage.workItemId);
  const events = await readEvents(projection.controlPlane);
  const authored = events.filter((event) => event.eventType === "artifact.authored");
  assert.equal(authored.length, 1);
  const serialized = JSON.stringify(authored[0]);
  assert.doesNotMatch(serialized, new RegExp(secretBody.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(serialized, /\.acceptance|idempotent\.md/u);
  assert.doesNotMatch(serialized, new RegExp(workPackage.lease.token, "u"));
  assert.doesNotMatch(serialized, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.deepEqual(Object.keys((authored[0]!.result as { value: Record<string, unknown> }).value).sort(), [
    "artifactDigest", "artifactType", "contentHash", "mediaType", "outputId", "revision", "schemaVersion",
  ]);

  const replayed = replayEvents({
    repositoryId: projection.repositoryId,
    workItemId: projection.workItemId,
    stageIds: Object.keys(projection.stages),
    controlPlane: projection.controlPlane,
    events,
    initialWorkItem: { status: "active" },
    initialStages: Object.fromEntries(Object.keys(projection.stages).map((stageId) => [stageId, { status: "pending" as const }])),
    initialProfile: projection.profile,
  });
  assert.equal(replayed.lastEventHash, projection.lastEventHash);
  assert.equal(replayed.idempotency[authored[0]!.idempotencyKey], authored[0]!.sequence);
});

test("implicit and explicit single-output authoring share one canonical idempotency identity", async () => {
  const { fixture, worktree, workPackage } = await activeExplore();
  await replaceRequiredOutputs(fixture, workPackage, [{
    outputId: "primary-report",
    artifactType: "exploration-report",
    schemaVersion: 1,
    contentLevel: "complete",
  }]);
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  const draft = path.join(worktree, ".acceptance", "canonical-output.md");
  await writeFile(draft, "# Canonical output\n", "utf8");
  const request: ArtifactCreateInput = {
    root: worktree,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    artifactType: "exploration-report",
    contentFile: ".acceptance/canonical-output.md",
  };

  const implicit = await createArtifact(fixture, request);
  const explicit = await createArtifact(fixture, { ...request, outputId: "primary-report" });
  assert.deepEqual(explicit, implicit);
  assert.equal(implicit.contentLevel, "complete");
  const { contentLevel: _contentLevel, ...withoutContentLevel } = implicit;
  await assert.rejects(
    submitPackage(fixture, workPackage, { ...completed(workPackage), artifacts: [withoutContentLevel] }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_REFERENCE_INVALID",
  );
  requireExecute(await submitPackage(fixture, workPackage, { ...completed(workPackage), artifacts: [implicit] }));
  const projection = await readControlPlane(worktree, workPackage.workItemId);
  assert.equal((await readEvents(projection.controlPlane)).filter(({ eventType }) => eventType === "artifact.authored").length, 1);
});

test("duplicate artifact types require an explicit output id", async () => {
  const { fixture, worktree, workPackage } = await activeExplore();
  const requiredOutputs: WorkPackage["requiredOutputs"] = [
    { outputId: "primary-report", artifactType: "exploration-report", schemaVersion: 1 },
    { outputId: "secondary-report", artifactType: "exploration-report", schemaVersion: 1 },
  ];
  await replaceRequiredOutputs(fixture, workPackage, requiredOutputs);
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  await writeFile(path.join(worktree, ".acceptance", "ambiguous.md"), "# Ambiguous\n", "utf8");
  const request: ArtifactCreateInput = {
    root: worktree,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    artifactType: "exploration-report",
    contentFile: ".acceptance/ambiguous.md",
  };

  await assert.rejects(
    createArtifact(fixture, request),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_OUTPUT_AMBIGUOUS",
  );
  const secondary = await createArtifact(fixture, { ...request, outputId: "secondary-report" });
  assert.equal(secondary.outputId, "secondary-report");
  assert.equal((await readArtifact(path.join(worktree, secondary.path!))).metadata.outputId, "secondary-report");
  await assert.rejects(
    submitPackage(fixture, workPackage, { ...completed(workPackage), artifacts: [secondary] }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_REQUIRED_ARTIFACT_MISSING",
  );

  const primary = await createArtifact(fixture, { ...request, outputId: "primary-report" });
  const next = requireExecute(await submitPackage(fixture, workPackage, {
    ...completed(workPackage),
    artifacts: [primary, secondary],
  }));
  assert.equal(next.stepId, "clarify");
});

test("type, output, schema, and legacy WorkPackage mismatches fail closed", async (t) => {
  await t.test("not required type and output", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "contract.md"), "# Contract\n", "utf8");
    const base = {
      root: worktree,
      workItemId: workPackage.workItemId,
      stepId: workPackage.stepId,
      attemptId: workPackage.attemptId,
      leaseToken: workPackage.lease.token,
      contentFile: ".acceptance/contract.md",
    } as const;
    for (const request of [
      { ...base, artifactType: "design" },
      { ...base, artifactType: "exploration-report", outputId: "unknown-output" },
    ]) {
      await assert.rejects(
        createArtifact(fixture, request),
        (error: unknown) => error instanceof Error && "code" in error
          && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED",
      );
    }
  });

  await t.test("unsupported required schema", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    await replaceRequiredOutputs(fixture, workPackage, [
      { outputId: "exploration-report", artifactType: "exploration-report", schemaVersion: 2 },
    ]);
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "schema.md"), "# Schema\n", "utf8");
    await assert.rejects(
      createArtifact(fixture, {
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: "exploration-report",
        contentFile: ".acceptance/schema.md",
      }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_OUTPUT_SCHEMA_UNSUPPORTED",
    );
  });

  await t.test("legacy package without authoring contract", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    await replaceRequiredOutputs(fixture, workPackage, workPackage.requiredOutputs, true);
    await assert.rejects(
      createArtifact(fixture, {
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: "exploration-report",
        contentFile: ".acceptance/does-not-exist.md",
      }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_AUTHORING_UNAVAILABLE",
    );
  });

  await t.test("system requirement-source cannot be Agent-authored", async () => {
    const fixture = await controlRuntimeFixture();
    const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "系统 Source" }, profile: "quick" });
    const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
    await assert.rejects(
      createApplicationArtifact({
        root: fixture.root,
        workItemId: intake.workItemId,
        stepId: intake.stepId,
        attemptId: intake.attemptId,
        leaseToken: intake.lease.token,
        artifactType: "requirement-source",
        contentFile: ".acceptance/missing.md",
      }, { now: fixture.now }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED",
    );
    const projection = await readControlPlane(fixture.root, started.workItemId);
    assert.equal((await readEvents(projection.controlPlane)).filter(({ eventType }) => eventType === "artifact.authored").length, 0);
  });

  await t.test("direct Application API rejects unknown input fields", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    await assert.rejects(
      createApplicationArtifact({
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: "exploration-report",
        contentFile: ".acceptance/missing.md",
        unexpected: true,
      } as ArtifactCreateInput, { now: fixture.now }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_SCHEMA_UNKNOWN_FIELD",
    );
  });
});

test("draft replacement between preflight and the control-plane lock is rejected", async () => {
  const { worktree, workPackage } = await activeExplore();
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  const draft = path.join(worktree, ".acceptance", "toctou.md");
  await writeFile(draft, "# Original\n", "utf8");
  let invoked = 0;
  const now = () => new Date("2026-08-18T04:00:00.000Z");
  const artifactAuthoring = {
    async afterInitialRead() {
      invoked += 1;
      const replacement = path.join(worktree, ".acceptance", "replacement.md");
      await writeFile(replacement, "# Replaced\n", "utf8");
      await rename(replacement, draft);
    },
  } satisfies ArtifactAuthoringDependencies;

  await assert.rejects(
    createApplicationArtifact({
      root: worktree,
      workItemId: workPackage.workItemId,
      stepId: workPackage.stepId,
      attemptId: workPackage.attemptId,
      leaseToken: workPackage.lease.token,
      artifactType: "exploration-report",
      contentFile: ".acceptance/toctou.md",
    }, { now, artifactAuthoring }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_DRAFT_CHANGED",
  );
  assert.equal(invoked, 1);
  const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts");
  assert.deepEqual(await readdir(artifactRoot).catch(() => []), []);
});

test("draft and Artifact directory identities remain bound across pathname races", async (t) => {
  await t.test("draft ancestor swap", async () => {
    const { worktree, workPackage } = await activeExplore();
    const draftRoot = path.join(worktree, ".acceptance");
    const movedRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "wspec-draft-swap-")), "drafts");
    await mkdir(draftRoot, { recursive: true });
    await writeFile(path.join(draftRoot, "ancestor.md"), "# Ancestor\n", "utf8");
    let swapped = false;
    const artifactAuthoring = {
      async afterDraftAncestorsChecked() {
        if (swapped) return;
        swapped = true;
        await rename(draftRoot, movedRoot);
        await symlink(movedRoot, draftRoot);
      },
      async afterInitialRead() {
        if (!swapped) return;
        await unlink(draftRoot);
        await rename(movedRoot, draftRoot);
      },
    } satisfies ArtifactAuthoringDependencies;
    await assert.rejects(
      createApplicationArtifact({
        root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
        attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
        artifactType: "exploration-report", contentFile: ".acceptance/ancestor.md",
      }, { now: fixedNow, artifactAuthoring }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_DRAFT_CHANGED",
    );
  });

  await t.test("temporary draft ancestor swap-back is rejected after child cwd binding", async () => {
    const { worktree, workPackage } = await activeExplore();
    const draftRoot = path.join(worktree, ".acceptance");
    const movedRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "wspec-draft-swap-back-")), "drafts");
    const redirectedRoot = await mkdtemp(path.join(os.tmpdir(), "wspec-draft-redirect-"));
    await mkdir(draftRoot, { recursive: true });
    await writeFile(path.join(draftRoot, "swap-back.md"), "# Original draft\n", "utf8");
    await writeFile(path.join(redirectedRoot, "swap-back.md"), "# Redirected draft\n", "utf8");
    let swapped = false;
    let restored = false;
    const artifactAuthoring = {
      async beforeDraftReaderSpawn() {
        if (swapped) return;
        swapped = true;
        await rename(draftRoot, movedRoot);
        await symlink(redirectedRoot, draftRoot);
      },
      async afterDraftReaderCwdBound() {
        if (!swapped || restored) return;
        await unlink(draftRoot);
        await rename(movedRoot, draftRoot);
        restored = true;
      },
    } satisfies ArtifactAuthoringDependencies;

    await assert.rejects(
      createApplicationArtifact({
        root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
        attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
        artifactType: "exploration-report", contentFile: ".acceptance/swap-back.md",
      }, { now: fixedNow, artifactAuthoring }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_DRAFT_CHANGED",
    );
    assert.equal(swapped, true);
    assert.equal(restored, true);
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts");
    assert.deepEqual(await readdir(artifactRoot).catch(() => []), []);
  });

  await t.test("Artifact output ancestor swap", async () => {
    const { worktree, workPackage } = await activeExplore();
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "output-swap.md"), "# Output swap\n", "utf8");
    const outside = await mkdtemp(path.join(os.tmpdir(), "wspec-output-swap-"));
    await mkdir(path.join(outside, "exploration-report"), { mode: 0o700 });
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts");
    const backup = `${artifactRoot}.backup`;
    const artifactAuthoring = {
      async afterArtifactDirectoryPrepared() {
        await rename(artifactRoot, backup);
        await symlink(outside, artifactRoot);
      },
    } satisfies ArtifactAuthoringDependencies;
    try {
      await assert.rejects(
        createApplicationArtifact({
          root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
          attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
          artifactType: "exploration-report", contentFile: ".acceptance/output-swap.md",
        }, { now: fixedNow, artifactAuthoring }),
        (error: unknown) => error instanceof Error && "code" in error
          && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_CONFLICT",
      );
      assert.deepEqual(await readdir(path.join(outside, "exploration-report")), []);
    } finally {
      await unlink(artifactRoot).catch(() => undefined);
      await rename(backup, artifactRoot).catch(() => undefined);
    }
  });

  await t.test("brief output ancestor swap at the write boundary leaves no outside files", async () => {
    const { worktree, workPackage } = await activeExplore();
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "output-window.md"), "# Output window\n", "utf8");
    const outside = await mkdtemp(path.join(os.tmpdir(), "wspec-output-window-"));
    await mkdir(path.join(outside, "exploration-report"), { mode: 0o700 });
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts");
    const backup = `${artifactRoot}.window-backup`;
    let restoration: Promise<void> | undefined;
    const artifactAuthoring = {
      async afterArtifactWriteBoundaryChecked() {
        await rename(artifactRoot, backup);
        await symlink(outside, artifactRoot);
        restoration = (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if ((await readdir(path.join(outside, "exploration-report"))).length > 0) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
          }
          await unlink(artifactRoot);
          await rename(backup, artifactRoot);
        })();
      },
    } satisfies ArtifactAuthoringDependencies;
    try {
      await assert.rejects(createApplicationArtifact({
        root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
        attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
        artifactType: "exploration-report", contentFile: ".acceptance/output-window.md",
      }, { now: fixedNow, artifactAuthoring }));
      await restoration;
      assert.deepEqual(await readdir(path.join(outside, "exploration-report")), []);
    } finally {
      await restoration?.catch(() => undefined);
      await unlink(artifactRoot).catch(() => undefined);
      await rename(backup, artifactRoot).catch(() => undefined);
    }
  });
});

test("draft growth and post-write replacement fail before committing an Artifact", async (t) => {
  await t.test("growth after open stays within the byte limit", async () => {
    const { worktree, workPackage } = await activeExplore();
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    const draft = path.join(worktree, ".acceptance", "growth.md");
    await writeFile(draft, "# Small\n", "utf8");
    let expanded = false;
    const artifactAuthoring = {
      async afterDraftOpened() {
        if (expanded) return;
        expanded = true;
        await writeFile(draft, Buffer.alloc(1_048_577, 0x61));
      },
    } satisfies ArtifactAuthoringDependencies;
    await assert.rejects(
      createApplicationArtifact({
        root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
        attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
        artifactType: "exploration-report", contentFile: ".acceptance/growth.md",
      }, { now: fixedNow, artifactAuthoring }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_DRAFT_TOO_LARGE",
    );
  });

  await t.test("replacement after Artifact write rolls back the uncommitted file", async () => {
    const { worktree, workPackage } = await activeExplore();
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    const draft = path.join(worktree, ".acceptance", "post-write.md");
    await writeFile(draft, "# Before write\n", "utf8");
    const artifactAuthoring = {
      async afterArtifactWrite() { await writeFile(draft, "# After write\n", "utf8"); },
    } satisfies ArtifactAuthoringDependencies;
    await assert.rejects(
      createApplicationArtifact({
        root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
        attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
        artifactType: "exploration-report", contentFile: ".acceptance/post-write.md",
      }, { now: fixedNow, artifactAuthoring }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_DRAFT_CHANGED",
    );
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts", "exploration-report");
    assert.deepEqual(await readdir(artifactRoot).catch(() => []), []);
  });
});

test("Artifact file cleanup follows event durability boundary", async (t) => {
  await t.test("failure after final link but before return removes the uncommitted file", async () => {
    const { worktree, workPackage } = await activeExplore();
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "link-failure.md"), "# Link failure\n", "utf8");
    let finalLinked = false;
    const artifactAuthoring = {
      async afterFinalLink() { finalLinked = true; throw new Error("simulated post-link failure"); },
    } satisfies ArtifactAuthoringDependencies;
    await assert.rejects(createApplicationArtifact({
      root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
      attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
      artifactType: "exploration-report", contentFile: ".acceptance/link-failure.md",
    }, { now: fixedNow, artifactAuthoring }));
    assert.equal(finalLinked, true);
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts", "exploration-report");
    assert.deepEqual(await readdir(artifactRoot).catch(() => []), []);
  });

  await t.test("writer crash after final link is recovered by retry", async () => {
    const { worktree, workPackage } = await activeExplore(() => new Date());
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "writer-crash.md"), "# Writer crash\n", "utf8");
    const request: ArtifactCreateInput = {
      root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
      attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
      artifactType: "exploration-report", contentFile: ".acceptance/writer-crash.md",
    };
    const now = () => new Date();
    const artifactAuthoring = { simulateWriterCrashAfterFinalLink: true } satisfies ArtifactAuthoringDependencies;

    await assert.rejects(
      createApplicationArtifact(request, { now, artifactAuthoring }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_CONFLICT",
    );
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts", "exploration-report");
    const interrupted = await readdir(artifactRoot);
    assert.equal(interrupted.length, 2);
    for (const entry of interrupted) assert.equal((await lstat(path.join(artifactRoot, entry), { bigint: true })).nlink, 2n);

    const recovered = await createApplicationArtifact(request, { now });
    assert.match(await readFile(path.join(worktree, recovered.path!), "utf8"), /# Writer crash/u);
    assert.deepEqual(await readdir(artifactRoot), [path.basename(recovered.path!)]);
    assert.equal((await lstat(path.join(worktree, recovered.path!), { bigint: true })).nlink, 1n);
    const projection = await readControlPlane(worktree, workPackage.workItemId);
    assert.equal((await readEvents(projection.controlPlane)).filter(({ eventType }) => eventType === "artifact.authored").length, 1);
  });

  await t.test("writer crash before final link cleans the orphan temp on retry", async () => {
    const { worktree, workPackage } = await activeExplore(() => new Date());
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "writer-prelink-crash.md"), "# Writer prelink crash\n", "utf8");
    const request: ArtifactCreateInput = {
      root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
      attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
      artifactType: "exploration-report", contentFile: ".acceptance/writer-prelink-crash.md",
    };
    const now = () => new Date();
    const artifactAuthoring = { simulateWriterCrashBeforeFinalLink: true } satisfies ArtifactAuthoringDependencies;

    await assert.rejects(createApplicationArtifact(request, { now, artifactAuthoring }));
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts", "exploration-report");
    const interrupted = await readdir(artifactRoot);
    assert.equal(interrupted.length, 1);
    assert.match(interrupted[0]!, /^\.[a-f0-9]{64}\.md\.[a-f0-9-]+\.tmp$/u);

    const recovered = await createApplicationArtifact(request, { now });
    assert.match(await readFile(path.join(worktree, recovered.path!), "utf8"), /# Writer prelink crash/u);
    assert.deepEqual(await readdir(artifactRoot), [path.basename(recovered.path!)]);
  });

  await t.test("writer crash during temp write cleans the safe partial orphan on retry", async () => {
    const { worktree, workPackage } = await activeExplore(() => new Date());
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "writer-partial-crash.md"), "# Writer partial crash\n", "utf8");
    const request: ArtifactCreateInput = {
      root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
      attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
      artifactType: "exploration-report", contentFile: ".acceptance/writer-partial-crash.md",
    };
    const now = () => new Date();
    const artifactAuthoring = { simulateWriterCrashDuringTempWrite: true } satisfies ArtifactAuthoringDependencies;

    await assert.rejects(createApplicationArtifact(request, { now, artifactAuthoring }));
    const artifactRoot = path.join(worktree, ".wsspec", "work-items", workPackage.workItemId, "artifacts", "exploration-report");
    const interrupted = await readdir(artifactRoot);
    assert.equal(interrupted.length, 1);
    const orphan = path.join(artifactRoot, interrupted[0]!);
    assert.match(interrupted[0]!, /^\.[a-f0-9]{64}\.md\.[a-f0-9-]+\.tmp$/u);
    const orphanSize = (await lstat(orphan, { bigint: true })).size;
    assert.ok(orphanSize > 0n);

    const recovered = await createApplicationArtifact(request, { now });
    assert.match(await readFile(path.join(worktree, recovered.path!), "utf8"), /# Writer partial crash/u);
    assert.deepEqual(await readdir(artifactRoot), [path.basename(recovered.path!)]);
  });

  await t.test("failure before event append removes the new file", async () => {
    const { worktree, workPackage } = await activeExplore(() => new Date());
    const body = "# Event append failure\n";
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "event-failure.md"), body, "utf8");
    const document = createArtifactDocument({
      artifactType: "exploration-report", outputId: "exploration-report", workItemId: workPackage.workItemId,
      stageId: workPackage.stepId, attemptId: workPackage.attemptId, body,
    });
    const target = path.join(worktree, `.wsspec/work-items/${workPackage.workItemId}/artifacts/exploration-report/${document.reference.contentHash.slice("sha256:".length)}.md`);
    const now = () => new Date();
    const artifactAuthoring = { simulateEventFailure: true } satisfies ArtifactAuthoringDependencies;

    await assert.rejects(
      createApplicationArtifact({
        root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
        attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
        artifactType: "exploration-report", contentFile: ".acceptance/event-failure.md",
      }, { now, artifactAuthoring }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_EVENT_INVALID",
    );
    await assert.rejects(readFile(target), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  });

  await t.test("projection failure after event append preserves and recovers the file", async () => {
    const { worktree, workPackage } = await activeExplore(() => new Date());
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "projection-failure.md"), "# Projection failure\n", "utf8");
    const request: ArtifactCreateInput = {
      root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
      attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
      artifactType: "exploration-report", contentFile: ".acceptance/projection-failure.md",
    };
    const now = () => new Date();
    const artifactAuthoring = { simulateProjectionFailure: true } satisfies ArtifactAuthoringDependencies;

    await assert.rejects(
      createApplicationArtifact(request, { now, artifactAuthoring }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_PROJECTION_WRITE_FAILED",
    );
    await recoverControlPlane({ cwd: worktree, workItemId: workPackage.workItemId });
    const recovered = await createApplicationArtifact(request, { now });
    assert.match(await readFile(path.join(worktree, recovered.path!), "utf8"), /# Projection failure/u);
    const projection = await readControlPlane(worktree, workPackage.workItemId);
    assert.equal((await readEvents(projection.controlPlane)).filter(({ eventType }) => eventType === "artifact.authored").length, 1);
  });

  await t.test("durable event with an uncertain append return preserves the file", async () => {
    const { worktree, workPackage } = await activeExplore(() => new Date());
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "durable-return.md"), "# Durable return\n", "utf8");
    const request: ArtifactCreateInput = {
      root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
      attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
      artifactType: "exploration-report", contentFile: ".acceptance/durable-return.md",
    };
    const now = () => new Date();
    const artifactAuthoring = { simulateEventReturnFailure: true } satisfies ArtifactAuthoringDependencies;
    await assert.rejects(createApplicationArtifact(request, { now, artifactAuthoring }));
    await recoverControlPlane({ cwd: worktree, workItemId: workPackage.workItemId });
    const recovered = await createApplicationArtifact(request, { now });
    assert.match(await readFile(path.join(worktree, recovered.path!), "utf8"), /# Durable return/u);
  });

  await t.test("durability verification failure after an uncertain append preserves the file", async () => {
    const { worktree, workPackage } = await activeExplore(() => new Date());
    const body = "# Unverifiable durability\n";
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "durability-unknown.md"), body, "utf8");
    const request: ArtifactCreateInput = {
      root: worktree, workItemId: workPackage.workItemId, stepId: workPackage.stepId,
      attemptId: workPackage.attemptId, leaseToken: workPackage.lease.token,
      artifactType: "exploration-report", contentFile: ".acceptance/durability-unknown.md",
    };
    const document = createArtifactDocument({
      artifactType: request.artifactType, outputId: "exploration-report", workItemId: request.workItemId,
      stageId: request.stepId, attemptId: request.attemptId, body,
    });
    const target = path.join(
      worktree,
      `.wsspec/work-items/${request.workItemId}/artifacts/${request.artifactType}/${document.reference.contentHash.slice("sha256:".length)}.md`,
    );
    const now = () => new Date();
    const artifactAuthoring = {
      simulateEventReturnFailure: true,
      simulateEventVerificationFailure: true,
    } satisfies ArtifactAuthoringDependencies;

    await assert.rejects(createApplicationArtifact(request, { now, artifactAuthoring }));
    assert.match(await readFile(target, "utf8"), /# Unverifiable durability/u);
    await recoverControlPlane({ cwd: worktree, workItemId: workPackage.workItemId });
    const recovered = await createApplicationArtifact(request, { now });
    assert.equal(path.join(worktree, recovered.path!), target);
    const projection = await readControlPlane(worktree, workPackage.workItemId);
    assert.equal((await readEvents(projection.controlPlane)).filter(({ eventType }) => eventType === "artifact.authored").length, 1);
  });
});

test("fresh CLI process creates only an ArtifactRef from the governed draft", async () => {
  const { worktree, workPackage } = await activeExplore(() => new Date());
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  const marker = `fresh-cli-body-${crypto.randomUUID()}`;
  await writeFile(path.join(worktree, ".acceptance", "cli.md"), `# CLI\n\n${marker}\n`, "utf8");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs"),
    path.join(repositoryRoot, "src/cli/main.ts"),
    "artifact", "create",
    "--work-item", workPackage.workItemId,
    "--step", workPackage.stepId,
    "--attempt", workPackage.attemptId,
    "--lease-token", workPackage.lease.token,
    "--artifact-type", "exploration-report",
    "--content-file", ".acceptance/cli.md",
  ], { cwd: worktree, encoding: "utf8", env: { ...process.env, HOME: os.homedir() } });

  assert.equal(stderr, "");
  const output = JSON.parse(stdout) as { ok: boolean; result: ArtifactReference };
  assert.equal(output.ok, true);
  assert.deepEqual(Object.keys(output.result).sort(), ["artifactType", "contentHash", "mediaType", "outputId", "path", "revision", "schemaVersion"]);
  assert.doesNotMatch(stdout, new RegExp(marker, "u"));
  assert.doesNotMatch(stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(stdout, new RegExp(workPackage.lease.token, "u"));
});

test("fresh CLI process preserves the public stale-Lease Artifact authoring error", async () => {
  const { fixture, worktree, workPackage: stale } = await activeExplore(() => new Date());
  await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
  await writeFile(path.join(worktree, ".acceptance", "stale-cli.md"), "# Stale CLI\n", "utf8");
  await fixture.app.acquire({ root: worktree, workItemId: stale.workItemId, actor: "codex" });

  let failure: (Error & { stdout?: string; stderr?: string }) | undefined;
  try {
    await execFileAsync(process.execPath, [
      "--import", path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs"),
      path.join(repositoryRoot, "src/cli/main.ts"),
      "artifact", "create",
      "--work-item", stale.workItemId,
      "--step", stale.stepId,
      "--attempt", stale.attemptId,
      "--lease-token", stale.lease.token,
      "--artifact-type", "exploration-report",
      "--content-file", ".acceptance/stale-cli.md",
    ], { cwd: worktree, encoding: "utf8", env: { ...process.env, HOME: os.homedir() } });
  } catch (error) {
    failure = error as typeof failure;
  }

  assert.ok(failure);
  assert.equal(failure.stderr, "");
  const output = JSON.parse(failure.stdout ?? "") as { ok: boolean; error: { code: string; message: string } };
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "WSSPEC_ATTEMPT_NOT_ACTIVE");
  assert.doesNotMatch(failure.stdout ?? "", new RegExp(stale.lease.token, "u"));
});

test("known plan, review, and TDD output types use the existing content contracts", async (t) => {
  const cases = [
    {
      artifactType: "plan",
      body: ["有序交付任务", "任务依赖", "精确文件范围", "验证方式", "人工检查点", "回滚方式"]
        .map((section) => `## ${section}\n\n${section}内容。`).join("\n\n") + "\n",
    },
    {
      artifactType: "review-result",
      body: "## Findings\n\n```yaml\nfindings: []\n```\n",
    },
    {
      artifactType: "tdd-evidence",
      body: "# TDD Evidence\n\nRed 与 Green 证据由当前输出描述。\n",
    },
  ] as const;

  for (const current of cases) {
    await t.test(current.artifactType, async () => {
      const { fixture, worktree, workPackage } = await activeExplore();
      await replaceRequiredOutputs(fixture, workPackage, [{
        outputId: current.artifactType,
        artifactType: current.artifactType,
        schemaVersion: 1,
      }]);
      await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
      await writeFile(path.join(worktree, ".acceptance", "known.md"), current.body, "utf8");
      const reference = await createArtifact(fixture, {
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: current.artifactType,
        contentFile: ".acceptance/known.md",
      });
      assert.equal(reference.artifactType, current.artifactType);
      assert.equal((await readArtifact(path.join(worktree, reference.path!))).metadata.outputId, current.artifactType);
    });
  }

  await t.test("incomplete plan", async () => {
    const { fixture, worktree, workPackage } = await activeExplore();
    await replaceRequiredOutputs(fixture, workPackage, [{ outputId: "plan", artifactType: "plan", schemaVersion: 1 }]);
    await mkdir(path.join(worktree, ".acceptance"), { recursive: true });
    await writeFile(path.join(worktree, ".acceptance", "incomplete-plan.md"), "## 有序交付任务\n\n只有一个章节。\n", "utf8");
    await assert.rejects(
      createArtifact(fixture, {
        root: worktree,
        workItemId: workPackage.workItemId,
        stepId: workPackage.stepId,
        attemptId: workPackage.attemptId,
        leaseToken: workPackage.lease.token,
        artifactType: "plan",
        contentFile: ".acceptance/incomplete-plan.md",
      }),
      (error: unknown) => error instanceof Error && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_INCOMPLETE",
    );
  });
});
