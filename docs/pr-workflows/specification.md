# PR workflow engine specification

## Purpose and first release

Keep team pull requests moving without making people repeatedly check bots,
conflicts, reviews, and checks. When a person is needed, provide a consistent
decision packet with evidence, unresolved concerns, and a specific next action.

An engineer defines a process in versioned JSON and Markdown. A visual editor
reads and writes the same files. A self-hosted daemon wakes from a webhook, a
poll, or a durable timer, reads current GitHub facts, and chooses the next
eligible action. Codex CLI and Claude Code are interchangeable agent providers
behind an adapter. No GitHub Actions or runner service executes this process.

Accepted first-release behavior:

- Automatically investigate, review, classify, resolve conflicts, address
  reviews, validate changes, and push within an explicit repository policy.
- People merge. The first release rejects merge requests at the effect broker,
  even if a process file asks for them.
- Engineers author files directly and use the visual editor to inspect and
  change the same definition. The editor is optional.
- A developer can try a process locally with their own supported CLI login and
  real PR reads. Production account entitlement is a separate deployment
  decision. Local experiments must not silently enable remote writes.

The working recommendation is a small independently runnable daemon with an
optional Repo Control UI. This specification covers the first PR process and
the contracts needed to change it. It does not require a general automation
marketplace, arbitrary visual programming, or multi-tenant SaaS.

## Use names that reveal the permission

Execution and effects are two different properties. Deterministic code can
merge a PR. An agent can produce a review without changing GitHub. Calling one
of these safe hides the relevant decision.

| Property | Values | Meaning |
| --- | --- | --- |
| Execution | `code`, `agent` | Who computes the result. |
| Output | `artifact`, `effect_request` | Validated data, or a request to change an external system. |
| Permissions | `workspace.read`, `workspace.write`, `checks.run`, `pr.push`, `review.resolve`, `labels.set`, `review.publish`, `notify.send`, `pr.merge` | The operations that this attempt may perform. |

Call actions such as review and classification **analysis actions**. Call
conflict repair and review repair **workspace actions**. Call push, publication,
notification, thread resolution, and merge **external effects**. Each effect
goes through a named broker operation. JSON is useful for limiting an agent's
output, but valid JSON does not prove that its claims are true.

`triage` is a process composed of observations, rules, actions, and waits. It is
not one large prompt. A classification result is an artifact; applying its
labels is a separate effect. A review result is an artifact; posting it is a
separate effect. A notification can be sensitive or noisy even though ordinary
code sends it.

## Facts, decisions, and progress

PR facts can overlap. A PR may be young, conflicted, and have outstanding review
threads at the same time. Do not encode those facts as mutually exclusive
states.

The collector produces an immutable observation with a repository node ID, PR
node ID, source head SHA, base SHA, observation time, and per-domain coverage.
It reads lifecycle, draft status, mergeability, checks, reviews, unresolved
threads, labels, and configured bot activity. Large or interrupted pagination
produces `unknown` or `partial`, never a false empty result.

The pure evaluator receives that observation, workflow version, control memory,
policy revision, and an explicit clock. It chooses one transition and records
the matching rule plus the rejected higher-priority rules. Replaying this
decision requires no network calls or model requests.

| Fact | Proposed derivation and caveat |
| --- | --- |
| `young` | `now < createdAt + newPrDelay`. A timer reaches the exact threshold. A changed head also starts a separate short debounce. |
| `lifecycle` | Open, closed, or merged from GitHub. A reopened PR starts a new lifecycle generation and is observed again. |
| `draft` | GitHub draft flag. Draft pauses new automated repairs and external effects. |
| `conflict` | Only confirmed conflicting mergeability is true. GitHub's unknown computation triggers a bounded recheck. |
| `unaddressed_review` | Unresolved relevant threads, or a current actionable review decision. Dismissal, actor policy, head association, and outdated threads are explicit inputs. A stale thread is not automatically resolved. |
| `external_review_pending` | A configured reviewer identity and fresh activity marker linked to this head, with a bounded expiry. An eyes reaction is a hint, not a lock or proof that a review is running. |
| `analysis_current` | The result matches head, base, relevant review/check evidence, workflow digest, prompt digest, and policy revision. A matching PR number is insufficient. |
| `evidence_complete` | Every domain required by this action is complete and fresh. Read-only analysis may proceed with clearly marked gaps; push, resolution, and readiness may not. |

An action does not permanently set the PR to green. The evaluator derives the
next decision after each completed action and every new observation. A review's
verdict is advisory. Policy derives `needs_author`, `needs_team`, or
`ready_for_human_merge` from verified checks, findings, and coverage.

The initial rule order is:

1. Closed or merged: cancel pending attempts and timers, retain a bounded audit.
2. Draft: wait for a new signal and reconciliation poll. Cancel active work at
   a checkpoint; the broker checks draft state again before every effect.
3. Incomplete or stale facts: refresh with backoff. Escalate after the retry
   budget; never label the PR ready because collection failed.
4. New PR or recently changed head: debounce until the configured time.
5. Confirmed conflict: repair in isolation, test, and request a conditional push.
6. Actionable review: address it with a bounded attempt, test, and request a push.
7. Fresh external reviewer activity: wait briefly, with a hard deadline.
8. Missing current classification: classify into the allowed categories.
9. Missing current review: review the current change and record evidence.
10. Verified blocking findings: send the author a decision packet.
11. Uncertainty or team decision: send a team decision packet.
12. Complete acceptable evidence: request human merge review.

Already-sent packets enter `waiting_human`; unchanged evidence must not send the
same packet on every poll. Conflict and review repairs have per-head and PR-wide
limits. A successful push creates another head, but does not reset the total
repair budget. Otherwise two bots could indefinitely fix each other's changes.

A blocked, declined-only, or no-change repair also records a suppression key
over the concern IDs/content, head/base, relevant evidence, and policy. Before
dispatching any repair, the scheduler checks that key. The same concern remains
parked until relevant evidence changes or an authorized retry supplies a new
retry nonce. Workflow edits alone do not clear it. New evidence can permit a
new attempt, but cannot reset lifecycle-wide budgets.

## One wake, many short steps

1. Authenticate and bound a webhook, or receive a poll/timer signal. Persist an
   inbox row before acknowledging delivery. A webhook is a reason to refresh,
   not authoritative PR state. Polling must recover missed events and enumerate
   repositories with pagination; search-result limits must not hide PRs.
2. Coalesce signals by stable repository and PR IDs. Claim a lease with a
   monotonically increasing fencing token. Only one writer may advance a PR.
3. Fetch a fresh observation. Commit the observation reference and chosen rule.
4. Reserve the attempt's maximum cost and runtime budget in the same transaction
   as its attempt row. Queue it for a worker.
5. Run a code action or launch/resume the matching isolated agent workspace.
   Validate the output and attach its input digests and attempt identity.
6. Store a result artifact. If it requests an effect, commit that request to an
   outbox. The broker rechecks policy, lease, lifecycle, head, and evidence
   before making the named remote call.
7. Reconcile the remote outcome, refresh facts, and evaluate again. Reuse a warm
   workspace for compatible immediate work. Bound steps and elapsed time per
   wake so one PR cannot monopolize the worker.
8. For a long wait, atomically save `nextWakeAt` and the reason, release the
   lease, and stop or suspend the sandbox. A database timer survives daemon or
   host restarts. Never hold a container asleep overnight waiting for a review.

Suggested initial defaults are proposals to benchmark, not measured guarantees:
30 seconds of head debounce, a two-minute new-PR delay, five-minute external
review waits with a 30-minute deadline, two repair attempts per head, four total
repairs per PR lifecycle, and at most three immediate agent actions per wake.
Each has an installation-level ceiling. A process can ask for a smaller limit.

## Durable state and the two memories

Use SQLite on a persistent local volume for the single-daemon first version.
Store inbox, PR control records, attempts, timers, effect outbox, effect
receipts, budgets, and human requests in transactions. Avoid a second queue
service until multi-host execution is needed. Postgres is an alternative when
several daemon instances need claims and shared state. Do not place SQLite on a
shared network filesystem to create distributed scheduling.

The requested per-PR JSON and Markdown files remain visible working artifacts:

```text
workflow-package/
  workflow.json
  prompts/review.md
  prompts/address.md
  prompts/classify.md
  prompts/resolve-conflict.md
  editor.json                 # optional layout only, excluded from execution digest
private-runtime/pr/<pr-node-id>/
  state.json                  # engine-produced projection of committed control state
  notes.md                    # agent working notes, untrusted and revisioned
  artifacts/<attempt-id>.json
```

The database is authoritative for the daemon's control state. `state.json` is
an atomic export with a revision, not another writable state store. The agent
cannot edit it. A local file-only implementation is viable for one process
with atomic renames and a single lock, but loses multi-record transactions and
requires a separate recovery journal. It is a deliberately smaller alternative,
not the default daemon design.

`notes.md` is untrusted context. The agent can propose a new version at an action
checkpoint. The engine stores it only if the PR lease and expected notes
revision still match. Store the previous revision for a bounded period, enforce
a byte limit, record author attempt and source head, and flag stale notes on a
new head. Notes cannot change permissions, spend ceilings, next wake time,
thread resolution, or the result schema. Do not paste notes into trusted system
instructions. Avoid global memory shared across repositories.

Keep large artifacts on a private volume with digests and atomic writes. Commit
database references only after bytes exist. Garbage-collect unreferenced files
after a grace period. Suggested retention is 14 days for raw traces and 30 days
after close for bounded decision receipts, configurable to the team's needs.
Encrypt backups, omit secrets from telemetry, and offer deletion by repository.

## Actions and their contracts

Every attempt receives `ActionInput` containing the workflow digest, action ID,
PR IDs, expected head and base, observation digest, policy revision, notes
revision, input artifact references, deadline, and capability grant. Every
terminal result records `completed`, `blocked`, `invalid_output`, `failed`,
`cancelled`, or `superseded`, with usage and evidence references. Only the
engine writes this envelope. The provider's JSON becomes the typed payload.

| Action | Execution and output | Permissions and completion |
| --- | --- | --- |
| Observe | Code, observation | GitHub reads through the collector; marks incomplete domains. |
| Classify | Agent, classification JSON | Read source; choose only configured labels with evidence. No label write. |
| Review | Agent, review JSON | Read pinned source; checks only if explicitly granted. Findings cite path, side, line range, severity, kind, rationale, and confidence. |
| Resolve conflict | Agent, candidate change | Write isolated checkout; no direct GitHub credential. A base merge is preferred over rewriting published history. Ambiguous intent blocks for a human. |
| Address review | Agent, candidate change and thread responses | Record each addressed, declined, or blocked thread with evidence. Run required checks before requesting a push. |
| Push candidate | Code, effect receipt | Revalidate PR target and expected parent. Push only the approved candidate to the allowed PR ref, conditional on the observed ref. |
| Resolve threads | Code, effect receipt per thread | Re-read thread and current head after confirmed push. Resolve only allowed IDs with evidence for the addressed concern. Discussion-only or uncertain resolution stays open. |
| Apply labels / publish review | Code, effect receipt | Only configured labels or schema-derived review text. An exact head and deduplication key bind the request. |
| Notify | Code, decision packet receipt | Render a fixed packet template; route to a configured audience. Destination IDs come from policy, never an agent's text. |
| Wait | Code, durable timer | Engine validates the suggested delay against minima, ceilings, deadlines, and newer signals. |
| Merge | Future code effect | Rejected in v1. A later policy would still require repository protections and current evidence. |

The JSON Schema contracts in this packet are illustrative executable examples.
Domain checks also verify line ranges against the pinned diff, label membership,
thread ownership, coverage claims, candidate ancestry, and evidence freshness.
Extra fields, malformed output, or unknown enum values fail validation. One
bounded repair of invalid agent JSON may be allowed; budget it as another model
attempt. A second invalid result becomes a visible blocked condition.

The host finalizes the candidate commit before running required checks, records
its SHA, and pushes that identical object. An agent may edit the working tree
and request candidate preparation, but a claimed SHA must resolve to the
host-recorded object. Conflict repair may require a merge commit preserving
both the PR and base parents. Do not recreate or squash the candidate after
testing, or recreate it while reconciling an uncertain push.

## External effects and recovery

Use at-least-once signal processing. Do not claim exactly-once GitHub writes.
The stable logical effect key includes PR identity, lifecycle generation, effect
kind, semantic payload/evidence identity, and destination. Workflow, prompt,
handler, and attempt versions are separate provenance fields. A prompt-only
migration that requests the same packet reuses its receipt. A changed decision
updates or supersedes that request according to notification policy. Process
attempt IDs alone cannot deduplicate retries of the same intended effect.
Canonical effect identity excludes timestamps, attempt IDs, and provenance
digests. Include decision-changing facts and content, such as head/base,
normalized finding IDs, packet outcome, and destination.

Effect rows move through `planned`, `sending`, `confirmed`, `rejected`, or
`unknown`. Commit `sending` before the remote call. If the connection disappears
after submission, read the destination before retrying. A fencing token prevents
an expired worker from committing local results; the broker also rejects its
requests. GitHub does not understand that local token, so each effect needs its
own remote precondition or reconciliation rule.

- Push: compare the observed ref, verify candidate ancestry and destination,
  then use a conditional ref update. No unconditional force push. A broker may
  implement an exact expected-old lease while independently rejecting any
  non-fast-forward update. Query the remote ref after an ambiguous response.
  Unexpected refs block another write.
- Review publication: attach the commit ID and a stable marker. GitHub cannot
  atomically compare all review evidence during publication. Mark stale output
  and reobserve if the head changes; never transfer its readiness to a new head.
- Thread resolution: re-read the specific thread and its revision/content
  immediately before resolution. GitHub may still change it concurrently; a
  new concern must be reopened or escalated. The engine does not infer success
  for the whole review from one thread's result.
- Notifications: retain destination message ID and packet digest. Prefer updating
  an existing open request over sending another message. If provider lookup
  cannot establish delivery, record `unknown` and surface it for reconciliation
  instead of sending an unlimited series of duplicates.

On a new head, cancel stale attempts at the next checkpoint and reject their
effects. Keep their output as stale diagnostic evidence only. On permission
revocation, stop new dispatch immediately and reconcile already-dispatched
requests. A remote write already accepted cannot be recalled. On daemon restart, reclaim expired
leases, reconcile `sending` records, and schedule due timers. A failed effect
does not cause the agent to rerun automatically; reuse the validated artifact
when its inputs remain current.

## Security and trust

Repository content, PR text, comments, tool responses, and agent notes can carry
hostile instructions. Treat them as data. Load process definitions and prompts
from an operator-approved immutable package outside the PR checkout. A PR cannot
increase its own privileges by editing a process or `AGENTS.md` file.

The operator owns the maximum permission grant. The effective grant is the
intersection of installation policy, repository policy, process request, action
request, and current run mode. Editing JSON can request a permission; it cannot
grant it. Human merge is an explicit v1 broker rule. Agents cannot install new
tools, turn off audit, modify deadlines, or choose notification destinations.

Use an effect broker outside the sandbox. Keep GitHub and messaging credentials
there. Code-writing agents receive a disposable checkout and narrow named
requests such as `submit_candidate` and `request_thread_resolution`. The broker
performs the actual authenticated write after validating the request. This
supports autonomous fixes without handing an agent a general GitHub token.

An agent tool allow-list is not a sandbox. A shell that can run arbitrary
commands can attempt network access and read every mounted credential. Restrict
filesystem mounts, process privileges, and egress independently. Never mount the
host home, Docker socket, daemon database, SSH agent, or cloud instance metadata
inside a PR worker. Run as a non-root user, drop capabilities, cap CPU, memory,
disk, and process count, and isolate repository tests as untrusted code too.
Disable automatic Git hooks, uncontrolled submodule fetches, and credential
helpers inherited from the host.

Model credentials need a separate treatment from GitHub credentials. A CLI
adapter may require account authentication in its own isolated home. Do not
assume a provider supports a credential proxy or that its auth files are safe
to share with arbitrary test processes. The provider spike must prove how CLI
tool processes and repository tests are separated from authentication files.
Until that is established, use a separate short-lived test sandbox and limited
dedicated model credentials for the daemon. Local personal-account mode must
state exactly which credential material enters the CLI container. Do not copy
one person's subscription login into a team service by default.

Fork PRs deserve a separate policy. Default fork execution to analysis only
until an operator authorizes the source repository/ref and write route. Never
push a fork's change into the base branch or use privileged secrets to execute
untrusted code. An own-branch repair pilot can ship before autonomous fork repair.

## Runtime, speed, and cost

Start with rootless containers for trusted same-team repositories if the host's
threat model permits a shared kernel. Offer gVisor or a microVM boundary for
untrusted code. Firecracker needs KVM and host preparation; microVM restore can
be useful, but a vendor's boot benchmark is not end-to-end CLI readiness.
Choose from measured checkout, auth, model, and test timings on the actual host.

Keep the daemon small and always running. Cache immutable Git objects by trust
scope, create a separate worktree/checkout per active attempt, and pre-pull
runtime images. Reuse a sandbox only for the same repository, PR generation,
head, workflow digest, provider identity, policy, and trust level. A pushed head
requires reobservation and an explicit workspace transition. It may reuse the
same container after validation, but not an unqualified old conversation.

Warm containers and resumed model conversations are independent choices. An
existing checkout saves setup even when the next action starts a fresh model
session. Resume only when provider support and the recorded inputs permit it.
Long conversation history can cost more than a small new evidence packet.
Expire idle workers after a short measured threshold, initially two minutes.

Cost controls belong outside prompts:

- Reserve budget transactionally before scheduling. Enforce per-attempt,
  per-PR-lifecycle, per-repository, and daily installation ceilings.
- Bound wall time, output bytes, context, tool calls, test time, attempts,
  concurrency, and immediate steps. Stop at whichever hard limit is reached.
- Use deterministic path rules before classification when they give the answer.
  Cache results by all relevant input digests. Do not reuse a review after a base
  or dependency-policy change just because the head SHA stayed constant.
- Choose a smaller model for bounded classification and a stronger one for
  difficult repair. Escalation has a fixed attempt limit, not recursive delegation.
- Record actual provider usage when available and estimated usage separately.
  A subscription does not imply zero cost or unlimited throughput. Enforce
  runtime/attempt ceilings when provider price or usage is unknown.
- Coalesce event bursts, respect GitHub rate-limit headers, use jittered backoff,
  and reserve read capacity for validating pending writes. A manual priority
  signal may change ordering but cannot bypass spend or permission ceilings.

Track webhook-to-decision latency separately from queue, sandbox startup,
checkout, model, tests, and remote-write time. Suggested non-model acceptance
targets are under two seconds for a local replay and under five seconds from a
persisted signal to a decision when reads are cached and fresh. These are test
targets, not promises about GitHub or model response time.

Required validation jobs run on workers owned by this daemon. GitHub-hosted
check results may be observed as optional external facts, but are not a required
execution dependency. If a repository independently requires such checks for
merging, the human merge may remain blocked by that repository policy. The
daemon never bypasses it or disguises local results as a different check.

## Human decision packets and Slack

Every request for attention contains a stable request ID, PR and exact head,
reason, recommended decision, classification, evidence and test summaries,
unresolved findings, attempted fixes, uncertainty, and links to the current
review. Use `needs_author`, `needs_team`, `ready_for_human_merge`, or
`blocked_execution` as explicit outcomes. Color is a secondary cue.

Route by deterministic policy over validated facts and classifications. For
example, a current security finding routes to the configured security audience;
an unknown classification routes to the default team queue. Agent prose cannot
select a Slack channel or mention arbitrary people. Slack is optional; the
daemon's local inbox is the complete fallback interface.

A message is a notification, not authority. The first version links to a
private authenticated decision view and GitHub for merging. Do not interpret a
reaction or a reply as permission to execute code. A later interactive approval
must bind identity, action, head, policy revision, expiry, and evidence digest,
with a one-time nonce. Any changed input invalidates it. The UI should keep one
open request per reason, mark obsolete requests superseded, and distinguish
acknowledged from resolved. Honor quiet hours and bounded reminder policies.

## Visual authoring and process changes

The engineer's task is to understand why this PR will take a particular path,
change that path, and inspect the consequences before activation. The graph,
selected rule/action, trace, and source are the primary content. Runs and
operational configuration belong in separate views.

Use a small graph vocabulary: observe, ordered decision, action, wait, and
human handoff. Every edge has a condition or named result. The graph is a view
of JSON; it is not a second executable format. Keep node IDs stable, store
positions in optional `editor.json`, and exclude layout from execution digests.
Do not put arbitrary JavaScript in conditions. The initial expression language
supports typed comparisons and bounded `all`, `any`, and `not` composition.
Missing data is unknown and cannot pass a destructive guard.

Show the source and preserve stable semantic round trips. Unknown schema
versions open read-only. A newer action type appears as an unsupported block
with its original fields preserved. Validation names broken references,
unreachable actions, cycles without a wait/attempt ceiling, invalid types,
missing error routes, and permissions exceeding policy. Auto-layout should not
rewrite IDs or reorder first-match rules.

The editor offers file import, staged changes, semantic diff, recorded-fixture
simulation, and export. Activation is a separate authenticated operation. The
operator reviews changed behavior, permissions, ceilings, and affected waiting
PRs. An agent cannot publish a process change from its working checkout.

Pin an immutable workflow, prompts, schema and action-registry digest to a PR
lifecycle. Fresh PRs use the new active version. Waiting PRs retain their
version until explicitly migrated at a checkpoint. Migration invalidates
incompatible outputs, reevaluates state, and deduplicates existing external
effects. Global permission revocation applies immediately even to pinned old
versions. Rollback selects an older version for future work; it does not undo
already pushed commits or messages.

## Local evaluation with real PRs

The following commands are a proposed CLI, not commands available in this repo:

```sh
prflow validate ./team-pr
prflow replay ./team-pr --fixture ./fixtures/pr.json --clock 2026-09-15T10:00:00Z
prflow inspect ./team-pr --repo example-org/sample-app --pr 42 --provider codex
prflow run ./team-pr --repo example-org/sample-app --pr 42 --provider claude --mode workspace
prflow run ./team-pr --repo example-org/sample-app --pr 42 --mode apply --policy ./local-policy.json
```

`replay` uses recorded observations and stubbed agent results, with a fake clock,
no network, and no model call. `inspect` fetches a real PR read-only and allows
live analysis with the developer's existing supported login. `workspace` may
edit and test an isolated checkout but cannot publish, resolve threads, notify,
or push. `apply` requires an explicit locally trusted policy naming the exact
repository/ref and allowed effects. It still cannot merge in v1.

Use a private local data directory outside the checkout. Separate GitHub read
authentication from the model login; never print tokens in example commands.
Render the proposed effect list before apply. A developer's prior policy can
authorize repeated autonomous fixes within its bounds without asking at every
tool call. Compare process versions on the same fixture, list changed decisions
and expected spend, and retain sanitized exports only when explicitly requested.

Integration tests should cover duplicate/out-of-order webhooks, restart during
wait, lost lease, two workers racing, changed head during a repair, unknown
mergeability, partial reviews, forged bot activity, missing budget, invalid JSON,
prompt injection, forbidden egress, new thread before resolution, revocation,
ambiguous push, and process migration. Run contract tests for each installed CLI
version. Add model evaluation cases with human-reviewed expected evidence and
repair outcomes; schema validity is only one score.

## Delivery and acceptance

1. Prove one vertical slice locally: observe a fictional/real read-only PR,
   choose a rule, run each CLI's review, validate JSON, and render one packet.
   Demonstrate portable auth and sandbox separation before enabling writes.
2. Build durable single-host scheduling, control memory, timers, budgets, and
   effect reconciliation. Demonstrate crash recovery and stale-head rejection.
3. Enable automatic repair and conditional pushes for an opt-in same-repository
   pilot. Demonstrate bounded loops, a tested patch, thread-level receipts, and
   human merge handoff. Fork repair stays a separately authorized capability.
4. Add the editor over the stabilized process format, replay/diff, activation,
   rollback, and optional Repo Control integration. Grow the action catalog only
   for repeated needs seen in the pilot.

The first release is complete when a PR with a conflict and an actionable
review can progress through observed repairs to a current human merge packet,
survive a daemon restart, avoid stale or duplicate writes, stop at its budget,
and explain every decision. It must also run locally without a hosted runner,
and reject merge attempts regardless of process-file content.
