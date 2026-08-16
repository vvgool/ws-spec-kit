# WiesenSpecKit Design

## 1. Product Definition

WiesenSpecKit is an independent, agent-neutral engineering workflow protocol and CLI. It turns a user intent, requirements document, or remote issue into a controlled sequence of specifications, designs, plans, implementation work, reviews, verification evidence, and archival publications.

The product name is `WiesenSpecKit`, the repository and npm package are `wiesen-spec-kit`, the CLI command is `wspec`, and all project-owned intermediate artifacts live under `.wsspec/`.

WiesenSpecKit does not choose or call language models. Codex, Claude Code, OpenCode, Cursor, or any other capable coding agent remains responsible for model selection, authentication, context management, and code execution. WiesenSpecKit provides deterministic workflow state, artifact contracts, approval gates, audit records, and recovery.

The repository uses the Apache-2.0 license.

## 2. Goals

- Provide one declarative workflow language for engineering delivery.
- Allow any file-and-shell-capable coding agent to execute the same workflow.
- Support automatic Skill invocation, explicit slash commands, and natural-language invocation.
- Keep all intermediate project artifacts in `.wsspec/`.
- Support requirements supplied directly, from local documents, remote pages, or issues.
- Enforce human approval of specification, design, and implementation plan by default.
- Preserve resumable, auditable state across agent sessions and agent products.
- Support Git worktrees, staged commits, remote issue synchronization, and project Wiki publishing.
- Make every workflow parameter documented, validated, and extensible.

## 3. Non-Goals

- Selecting, hosting, proxying, or directly invoking models.
- Storing model or issue-tracker credentials.
- Replacing Codex, Claude Code, OpenCode, Cursor, GitHub, GitLab, or a project Wiki.
- Automatically pushing, merging, publishing releases, or changing remote issue state without explicit authorization.
- Providing an unrestricted programming language inside YAML.

## 4. Domain Language

The following terms are canonical across source code, documentation, schemas, Skills, and CLI output:

- **Work Item**: One user goal and its complete lifecycle. It may represent a feature, bug, audit, refactor, documentation delivery, or project bootstrap.
- **Workflow**: A declarative graph of stages and their contracts.
- **Stage**: One node in a workflow.
- **Artifact**: A versioned output such as a specification, design, plan, or report.
- **Run**: One execution of a Work Item.
- **Attempt**: One execution attempt for one Stage.
- **Binding**: A link between a Work Item and an external object such as an Issue or Wiki page.
- **Evidence**: A reproducible test, build, review, publication, or acceptance result.
- **Claim**: A time-limited lease granting one actor write ownership of a Stage.
- **Actor**: The human or agent identity recorded for an operation. It is audit metadata, not a workflow runner.

Avoid using `change`, `ticket`, `runner`, or `model provider` for these concepts.

## 5. Architecture

WiesenSpecKit is centered on a declarative workflow engine:

```text
workflow.yaml
    -> Parser and Schema Validator
    -> Workflow Compiler
       - dependency graph
       - artifact contracts
       - approval gates
       - transition rules
    -> Workflow Runtime
       - stage execution protocol
       - pause, resume, retry, invalidation
       - claims and concurrency
       - event journal
    -> Adapter Runtime
       - requirement sources
       - issues
       - Wikis
       - agent integration installers
```

The runtime exposes a CLI protocol. Agents call the protocol but are not launched or controlled by it.

## 6. Declarative Workflow Language

The project workflow lives at `.wsspec/workflow.yaml`. The bundled workflow follows this lifecycle:

```text
discover -> define -> design -> plan -> build -> review -> verify -> close
```

Example:

```yaml
version: 1

workflow:
  id: verified-delivery

stages:
  - id: define
    uses: artifact.generate
    input:
      - intent
    output:
      - specification
    approval:
      required: true

  - id: design
    uses: artifact.generate
    needs:
      - define
    input:
      - specification
    output:
      - design
    approval:
      required: true

  - id: plan
    uses: task.plan
    needs:
      - design
    output:
      - plan
      - tasks
    approval:
      required: true

  - id: build
    uses: engineering.implement
    needs:
      - plan
    output:
      - implementation-result

  - id: review
    uses: engineering.review
    needs:
      - build
    input:
      - specification
      - design
      - implementation-result
    output:
      - review-result

  - id: verify
    uses: quality.verify
    needs:
      - review
    input:
      - review-result
    gates:
      - test
      - lint
      - typecheck
      - build

  - id: close
    uses: work-item.close
    needs:
      - verify
    publish:
      - issue
      - wiki
```

The engine does not hard-code these stage IDs. It interprets their dependency, input, output, approval, gate, and publication contracts.

### 6.1 Language Contract

Every public parameter must define:

- name and path;
- type and whether it is required;
- default and allowed values;
- scope and execution semantics;
- interactions and constraints;
- failure behavior;
- minimal and complete examples;
- extension mechanism;
- version compatibility and migration behavior.

Unknown fields fail validation and are never silently ignored. Errors contain a stable code, field path, expected shape, and suggested fix.

JSON Schema is the canonical structural contract. CLI help and reference documentation are generated from the same field definitions. Documentation examples are validated in CI.

The CLI includes:

```text
wspec schema
wspec explain <field-path>
wspec validate
wspec workflow graph
wspec migrate --dry-run
```

### 6.2 Extensions

Extensions are explicit packages, not arbitrary YAML fields:

```yaml
extensions:
  - package: "@company/wsspec-security"
    version: "^1.0.0"
    config:
      policy: strict
```

An extension must provide a manifest, JSON Schema, executor implementations, input and output artifact contracts, permissions, reference documentation, examples, compatibility ranges, and contract-test fixtures. Extension schemas are merged into validation before workflow compilation.

## 7. Project Storage

All project-owned intermediate documents and state live under `.wsspec/`:

```text
.wsspec/
├── config.yaml
├── constitution.md
├── workflow.yaml
├── schemas/
├── work-items/
│   └── WSK-20260816-001/
│       ├── work-item.yaml
│       ├── source/
│       ├── artifacts/
│       ├── evidence/
│       ├── events.jsonl
│       └── runtime.json
├── templates/
└── archive/
```

Host-specific discovery files may live in host-required locations, but they contain only routing instructions. They must not store Work Item artifacts.

### 7.1 Work Item Record

```yaml
version: 1
id: WSK-20260816-001
title: Add payment retry policy
workflow: verified-delivery
source:
  type: document
  uri: requirements/payment-retry.docx
  revision: sha256:example
bindings:
  issue: null
  wiki: null
createdAt: 2026-08-16T12:00:00+08:00
```

### 7.2 Artifacts

Artifacts use Markdown with validated frontmatter. Approval records the artifact content hash. Changing an approved upstream artifact invalidates all dependent stages and requires approval again.

### 7.3 Runtime and Events

`runtime.json` is a recoverable projection of append-only `events.jsonl`. State-changing operations use file locks and atomic writes. Event entries contain structured decisions, commands, results, and external writes but never credentials or hidden model reasoning.

Supported states include:

```text
pending -> ready -> claimed -> running -> validating
validating -> awaiting_approval -> succeeded
validating -> failed -> retrying
running -> paused -> running
succeeded -> invalidated -> ready
verified -> pending_publish -> closed
```

Closed Work Items move intact to `.wsspec/archive/<work-item-id>/`.

## 8. Stage Execution Protocol

Agents use the same CLI protocol:

```bash
wspec next
wspec context WSK-20260816-001 build --format json
wspec stage claim WSK-20260816-001 build --actor codex
wspec stage start WSK-20260816-001 build
wspec stage complete WSK-20260816-001 build --result result.json
```

`context` returns the objective, input artifacts, expected outputs, allowed paths, quality gates, completion schema, and current claim.

Stage completion submits a structured result containing a summary, modified files, artifacts, commands, evidence, remaining risks, and external writes. The engine validates the result and may independently re-run configured quality commands before accepting completion.

Claims are expiring leases. A competing actor can inspect a claimed Stage but cannot write it. Expired claims require explicit takeover, which creates an audit event. Upstream invalidation cancels dependent claims.

## 9. Invocation and Agent Integration

WiesenSpecKit supports three user entry points:

1. **Automatic Skill invocation**: An agent detects a suitable engineering request in a repository with `.wsspec/`, proposes WiesenSpecKit on first use, and automatically continues an active Work Item until an approval gate.
2. **Explicit command invocation**: Host-specific integrations expose equivalent commands such as `/wspec-start`, `/wspec-issues`, `/wspec-status`, `/wspec-resume`, `/wspec-verify`, and `/wspec-close`.
3. **Natural-language invocation**: A user may say, for example, "Use WiesenSpecKit to start from this requirements document."

The default trigger mode is `suggest`: the first matching task requires user confirmation; subsequent stages of that Work Item continue automatically until a gate or failure.

Integrations are provided for Codex, Claude Code, OpenCode, and Cursor, plus a generic Agent Skills integration. Integrations install discovery metadata, an orchestrator Skill, and explicit commands. They do not contain the workflow, select a model, or become workflow runners.

Automatic invocation must not initialize an unconfigured repository, import a remote Issue, approve artifacts, push, merge, publish a release, or overwrite an existing Work Item without authorization.

## 10. Requirements Sources

Supported local sources are Markdown, plain text, PDF, and DOCX. Supported remote sources are public web pages, Feishu documents and Wikis, and Confluence pages.

Authenticated sources use `SourceAdapter` implementations. Credentials come from official CLIs, system credential stores, or environment injection and never enter `.wsspec/`.

The source record stores its URI, revision or content hash, retrieval time, and normalized snapshot. Original source documents are read-only. A source revision that conflicts with approved artifacts stops execution and requires reconciliation.

A Work Item does not require an Issue. An Issue may be bound later without changing the Work Item identity.

## 11. Issue Discovery and Synchronization

The Issue adapter detects GitHub or GitLab from Git remotes and reuses `gh` or `glab` authentication where available. The user can list or interactively select open Issues assigned to the current authenticated user:

```bash
wspec issue list
wspec issue pick
wspec issue import <issue-url>
wspec issue sync <work-item-id>
```

One Work Item binds to one primary Issue. Selecting an Issue imports its title, body, labels, comments, attachments, and relationship metadata into a versioned source snapshot.

Read operations are automatic. Remote state changes, labels, and comments require confirmation and create audit events. Simultaneous local and remote changes generate a structured conflict; neither side silently wins. Approved artifacts are never overwritten by remote edits. Issue comments may become feedback but do not directly mutate approved artifacts.

## 12. Git Behavior

Each Work Item receives an isolated branch and worktree. Specification, design, plan, and implementation milestones form reviewable commits. WiesenSpecKit never pushes, merges, opens a pull request, or publishes a release without explicit authorization.

Failed or paused work preserves its worktree. Resume continues from the last confirmed event. Git operations first resolve the exact repository, branch, worktree, and intended target.

## 13. Quality Gate Discovery

Initialization inspects project manifests and CI configuration to propose test, lint, typecheck, and build commands. The user confirms the proposal once; accepted commands are written to `.wsspec/config.yaml` and remain stable until explicitly changed.

An agent's claim that a command passed is not sufficient evidence. Configured gates are re-run or verified against captured command evidence before a Stage succeeds.

## 14. Wiki Publication

Wiki publication uses a generic `WikiAdapter` interface with detection, target resolution, publish, read-back, and verification operations. Projects register their own adapter in `.wsspec/config.yaml`:

```yaml
wiki:
  enabled: true
  adapter: ./tools/wsspec/wiki-adapter.mjs
  publishOn: close
  required: true
```

Publishing creates or updates a stable page for the Work Item and includes the final specification, design decisions, usage, limitations, and verification result. It excludes credentials, hidden reasoning, sensitive logs, and unnecessary process artifacts.

When Wiki publication is required, publish or read-back failure leaves the Work Item in `pending_publish`; it cannot close. Repeated publication updates the existing page rather than creating duplicates.

## 15. Disclosure and Security

WiesenSpecKit does not call models or manage model credentials. It still labels sensitive sources and excludes them from generated execution contexts by default.

External adapters must declare read, write, network, and credential requirements. All external writes are audited. Credentials cannot be stored in project files, artifacts, logs, Issues, Wikis, or generated prompts.

Destructive file operations, Git push, merge, release publication, and remote state changes require explicit authorization even if a custom workflow requests them.

## 16. CLI Experience

The CLI combines stable commands with an interactive terminal wizard:

```text
wspec init
wspec new
wspec next
wspec list
wspec status <work-item-id>
wspec run <work-item-id>
wspec resume <work-item-id>
wspec pause <work-item-id>
wspec verify <work-item-id>
wspec close <work-item-id>
```

Machine-readable commands support `--json`. CI uses explicit non-interactive policy:

```bash
wspec verify --non-interactive --policy .wsspec/ci-policy.yaml
```

Errors have stable codes and both human-readable and JSON forms. They identify the exact field or state, expected condition, and repair command.

## 17. Testing Strategy

Testing has four layers:

- Schema tests for all fields, extension merging, errors, and migrations.
- Engine tests for transitions, invalidation, approval, claims, concurrency, retry, resume, and event recovery.
- Adapter contract tests for sources, Issues, Wikis, and integration generation.
- End-to-end tests for automatic invocation, explicit commands, document input, Issue input, interruption recovery, and archival publication.

Every public configuration field has positive and negative semantic tests. Every documented YAML example is schema-validated. Every Recipe runs in a temporary Git repository. CLI help, JSON Schema, and reference documentation are generated from one field definition, and CI fails when generated outputs drift.

Local fixtures and mocks do not constitute real external integration proof. Release acceptance separately records real-account GitHub, GitLab, and configured Wiki read-back evidence.

Required local release gates are:

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm pack --dry-run
```

## 18. Initial Delivery Scope

The first release contains:

- Node.js and TypeScript CLI published as `wiesen-spec-kit` with `wspec` binary;
- workflow parser, JSON Schema, compiler, runtime, event journal, claims, and approval gates;
- bundled verified-delivery workflow and documented Recipes;
- Markdown, TXT, PDF, and DOCX local source parsing;
- public web source parsing and adapter contracts for authenticated Feishu and Confluence sources;
- GitHub and GitLab Issue discovery, selection, import, and synchronization;
- generic Wiki adapter contract with verified read-back;
- Codex, Claude Code, OpenCode, Cursor, and generic Agent Skills integrations;
- automatic quality-command discovery with user confirmation;
- isolated Git branch and worktree management;
- Apache-2.0 licensing and a validated documentation site or reference tree.

Direct model invocation, model selection, credential storage, automatic push, automatic merge, and automatic release publication are explicitly excluded.
