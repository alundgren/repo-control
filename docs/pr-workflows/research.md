# PR workflow systems research

Research date: 2026-09-15 UTC. All linked pages were retrieved on that date.

This research supports the [PR workflow specification](specification.md) and
[decisions](decisions.md). Here, a workflow is Repo Control's own structured
process and runtime. It is unrelated to GitHub Actions workflow files and does
not depend on GitHub Actions or hosted runners.

## Recommendation

Build an independently runnable daemon in this repository. Use SQLite first for
durable runs, attempts, timers, inbox events, and an effect outbox. Keep process
definitions in engineer-authored JSON plus referenced Markdown, and let the
visual editor round-trip those files without adding execution-only state.

The daemon should automatically investigate, fix, validate, and request a push.
A host broker should hold GitHub credentials and perform a conditional
fast-forward push only when the remote head still matches the recorded head.
The daemon should then continue from the new commit. People remain responsible
for merging in v1.

Do not add Temporal, Restate, DBOS, or another general durable execution engine
as a v1 dependency. Their recovery patterns are useful, but an explicit PR
state machine over SQLite has a smaller operational and authoring surface for
the first supported process. Reconsider an engine after measurements show that
single-host recovery, throughput, or process upgrades are difficult to support
correctly.

Repo Control does not yet have team GitHub authentication. Its current GitHub
connection is insufficient for organization repositories, so production use
also requires an installation-scoped GitHub App or another explicitly scoped
team authentication model. This is independent of the scheduler design.

## Six-system comparison

| System | Documented behavior | What to use or avoid |
| --- | --- | --- |
| Temporal | A workflow's append-only Event History is the durable recovery record and audit log. [Durable timers](https://docs.temporal.io/workflow-execution/timers-delays) persist while workers are unavailable and consume no worker resources while waiting. [Event History](https://docs.temporal.io/workflow-execution/event) must replay deterministically. | Use persisted timers, recorded decisions, and replay-safe code as design tests. Avoid the service cluster, worker protocol, and full replay model in v1. |
| Restate | Restate journals steps before or while they execute, uses idempotency keys to identify duplicate invocations, and fences late attempts by epoch. [Its architecture](https://docs.restate.dev/references/architecture) includes durable timers, state, and promises. [Deployments are immutable](https://docs.restate.dev/services/versioning); retries remain on the original endpoint while new requests use the latest deployment. | Use durable journals, leases with fencing tokens, and immutable definition snapshots. Restate uses the [Business Source License 1.1](https://github.com/restatedev/restate/blob/main/LICENSE), with a four-year Apache 2.0 change date per version and an additional-use grant whose terms must be checked before redistribution or offering a public service. Do not make it a default dependency without a separate license and operations decision. |
| DBOS | The [DBOS library](https://docs.dbos.dev/architecture) checkpoints workflow inputs and outputs in PostgreSQL; a workflow must be deterministic and steps are the idempotency boundary. A single application process can recover local work, while its Conductor component provides distributed recovery and management. [Application versioning](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows) keeps recovery on the matching code version and recommends draining older versions. | Use explicit step boundaries, durable results, and version-pinned recovery. Its PostgreSQL requirement and distributed management service add more infrastructure than the SQLite-first target needs. The documentation describes DBOS as open source, but its precise package and hosted-service license terms were not evaluated here. |
| n8n | Workflows [import and export as JSON](https://docs.n8n.io/build/manage-workflows/export-and-import); exports may contain credential names, IDs, and imported headers. Its [workflow review](https://docs.n8n.io/build/manage-workflows/workflow-reviews) pins a saved version for review, provides a visual diff, and publishes the reviewed version after approval. That review feature is documented for Enterprise plans. | Use stable node IDs, lossless text/editor round trips, separate draft and active revisions, and a pinned visual diff. Never store credentials or runtime artifacts in exported process files. n8n's main code uses the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md), with separate enterprise terms for `.ee` code, so use the interaction ideas rather than copying implementation. |
| Mergify | Its [rules engine](https://docs.mergify.com/workflow/) evaluates current pull-request state. An action runs when its rule changes from unmatched to matched, rather than for every repeated event. | Use current-state reconciliation and transition-triggered actions. Webhooks should wake evaluation, not define truth or directly cause a repeated side effect. Do not copy a broad merge-queue product model into v1, where people merge. |
| CodeRabbit | [Automatic reviews](https://docs.coderabbit.ai/configuration/auto-review) run incrementally after pushes and focus on new commits. The documented default pauses automatic reviews after five reviewed commits on one pull request. | Re-review the exact new head and cap automatic fix/review generations. Stop when findings repeat without a tree change, then present the decision to a person. Do not infer implementation or self-hosting details from externally visible product behavior. |

## Design consequences

### Durable scheduling and recovery

- Store `nextWakeAt` rows and let workers claim due work. Do not represent a
  wait with a sleeping process.
- Record each claim with a lease and monotonically increasing fencing token so
  a restarted worker cannot commit a late result after another worker resumes
  the attempt.
- Treat a webhook as a prompt to reconcile. GitHub [does not automatically
  redeliver failed webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks),
  so deduplicate deliveries by GUID and poll periodically to recover missed
  state changes.
- Keep current state in ordinary tables and append decision and effect records
  for audit. Full deterministic event replay is unnecessary for v1.

### Definition versioning

- Compute a digest from normalized executable JSON and referenced Markdown.
  Exclude editor layout and runtime files.
- Pin every run to its definition digest. Retain immutable definition snapshots
  until no run references them.
- Give the document a `schemaVersion` and each executable node a `typeVersion`.
  Validate migrations explicitly instead of silently reinterpreting active
  runs after an edit.
- Publish a draft only after validation and an optimistic digest check. Show the
  text and visual diff against the currently active revision.

### Idempotent effects and brokered pushes

- Persist each external effect as `planned`, `sending`, `confirmed`, `rejected`,
  or `unknown`. Give it a stable idempotency key derived from the run, node, and
  logical attempt.
- Before asking the broker to push, persist the expected remote head and planned
  commit. The broker must conditionally fast-forward from that exact head.
- After a crash during a push, compare the remote head with the planned commit
  and expected old head. Confirm, retry, or stop for reconciliation based on
  those observed values. Never assume that a timed-out request failed.
- Keep repository credentials and GitHub writes in the broker. Agents return
  proposed commits and effect requests from their sandbox.

### Automatic fixes, approvals, and completion

- Key every review, diagnosis, approval, validation result, and proposed patch
  to an exact pull-request head commit.
- After an automatic push or base update, re-read the pull request and evaluate
  all gates against the new head. GitHub can [dismiss stale approvals or require
  approval of the most recent reviewable push](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
  so an approval must not float across commits.
- Cap automatic fix generations and detect both repeated findings and a proposed
  commit with no tree change. Escalate those cases instead of looping.
- Finish at `ready_for_human_merge`. The effect broker must reject merge
  requests in v1.

## CLI and sandbox research

See [runtime options](runtime-options.md) for verified CLI invocation examples,
authentication limits, rootless containers, gVisor, Firecracker, and separate
network rules for provider clients and repository tests. Successful local login
does not establish permission to share that account through a team daemon.

## Explicit unknowns

- Whether supported Codex and Claude CLI login modes work reliably in the
  daemon's non-interactive execution environment.
- Which operating-system or container boundary provides adequate filesystem,
  process, network, and resource isolation on the first deployment host.
- The exact GitHub App installation permissions and token lifecycle needed for
  team repositories and conditional pushes.
- Whether SQLite claim contention and reconciliation latency remain acceptable
  under realistic repository and pull-request counts.
- The final JSON node vocabulary and which editor-only fields can be excluded
  from the executable digest without causing confusing diffs.
- The licensing and self-hosting terms for DBOS packages that might be evaluated
  later. Mergify and CodeRabbit licensing was not investigated because neither
  is proposed as a runtime dependency.
