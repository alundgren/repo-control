# Architecture proposal

All diagrams describe the proposed system. The current Repo Control application
does not run arbitrary repository code or persist these workflow instances.
C4 uses "container" to mean a separately running application or data store;
the agent sandbox is also an operating-system isolation boundary.

## System context

```mermaid
C4Context
title PR workflow service context
Person(engineer, "Workflow engineer", "Edits versioned processes and tests them locally")
Person(team, "PR author and team reviewer", "Receives decisions, resolves ambiguity, and merges")
System(engine, "PR workflow service", "Observes PRs, applies rules, and runs bounded agent work")
System_Ext(github, "GitHub", "Source, PR facts, checks, reviews, and branch protection")
System_Ext(provider, "Codex or Claude provider", "Model inference through the selected CLI")
System_Ext(messages, "Messaging provider", "Optional delivery of decision packets")
System_Ext(repoControl, "Repo Control", "Optional private authoring and decision UI")
Rel(engineer, engine, "Supplies trusted process versions and local test requests")
Rel(team, engine, "Reads evidence and manages human requests")
Rel(team, github, "Reviews and merges the current PR")
Rel(engine, github, "Reads facts and performs explicitly permitted effects")
Rel(github, engine, "Sends signed change signals")
Rel(engine, provider, "Requests bounded review, classification, and repairs")
Rel(engine, messages, "Sends a structured request for attention")
Rel(messages, team, "Delivers a link and decision summary")
Rel(repoControl, engine, "Reads runs and submits authenticated authoring operations")
Rel(engineer, repoControl, "Optionally edits and simulates processes")
Rel(team, repoControl, "Optionally reads current decision packets")
```

GitHub remains authoritative for PR facts and merge policy. The service owns
attempts, process progress, budgets, and decision receipts. The public artifact
viewer has no access to private process APIs.

## Containers

```mermaid
C4Container
title Independently runnable daemon with optional Repo Control UI
Person(engineer, "Engineer", "Authors and operates processes")
Person(reviewer, "Team reviewer", "Reads decisions and merges on GitHub")
System_Ext(github, "GitHub", "PR facts and named remote effects")
System_Ext(provider, "Model provider", "Authenticated CLI inference")
System_Ext(messages, "Messaging provider", "Optional notifications")
Container_Boundary(service, "PR workflow service") {
  Container(editor, "Editor / local CLI", "Private web UI and CLI", "Validates, simulates, and exports process definitions")
  Container(daemon, "Control daemon", "Proposed TypeScript process", "Persists signals, decides work, and schedules attempts")
  ContainerDb(db, "Durable store", "SQLite on local volume", "Commits control state, timers, budgets, and effect receipts")
  Container(files, "Private artifact store", "Local volume", "Stores immutable process packages, outputs, and versioned notes")
  Container(broker, "Effect broker", "Restricted host service", "Checks grants and current evidence before external writes")
  Container(worker, "Agent worker", "Container or microVM", "Runs a CLI against one isolated PR checkout")
  Container(tests, "Test worker", "Separate isolated process or guest", "Runs repository code without provider or remote-write credentials")
}
Rel(engineer, editor, "Edits trusted process files and requests tests")
Rel(reviewer, editor, "Reads current decision packets")
Rel(editor, daemon, "Uses authenticated process and run API")
Rel(daemon, db, "Transacts leases, work, timers, and budgets")
Rel(daemon, files, "Pins process versions and result references")
Rel(daemon, github, "Refreshes required PR evidence")
Rel(github, daemon, "Delivers signed wake signals")
Rel(daemon, worker, "Dispatches input and bounded grant; receives validated output")
Rel(worker, provider, "Runs selected CLI with isolated provider authentication")
Rel(worker, tests, "Requests bounded tests on the candidate checkout")
Rel(tests, worker, "Returns test evidence")
Rel(daemon, broker, "Submits durable effect requests")
Rel(broker, db, "Checks grant, fencing token, and effect receipts")
Rel(broker, github, "Rechecks PR state and conditionally writes")
Rel(broker, messages, "Sends or reconciles configured decision packets")
Rel(messages, reviewer, "Delivers bounded notifications")
Rel(reviewer, github, "Performs human merge")
```

The broker can initially be a host module in the daemon process. It must remain
outside repository execution and expose only named operations. The collector
holds read credentials on the host. Workers receive bounded source and evidence
rather than unrestricted credential access. Container separation of CLI auth
and repository test execution must be verified for each provider adapter.

## Control daemon components

```mermaid
C4Component
title Control daemon responsibilities
Container_Ext(editor, "Editor / CLI", "Private interface", "Authors and observes work")
Container_Ext(worker, "Worker", "Isolated runtime", "Computes agent results")
Container_Ext(broker, "Effect broker", "Host operations", "Checks and performs remote effects")
ContainerDb_Ext(db, "Durable store", "SQLite", "Transactional control records")
System_Ext(github, "GitHub", "Current facts and signed signals")
Container_Boundary(daemon, "Control daemon") {
  Component(intake, "Signal intake", "Webhook, poll, and timer", "Deduplicates signals and makes due PRs runnable")
  Component(observe, "Observation collector", "GitHub read adapter", "Builds a pinned observation with coverage and freshness")
  Component(evaluate, "Rule evaluator", "Pure function", "Selects the first eligible rule and records its explanation")
  Component(schedule, "Attempt scheduler", "Lease and budget policy", "Reserves work and limits immediate continuation")
  Component(validate, "Result validator", "Schema and domain checks", "Accepts artifacts and rejects stale or invalid output")
  Component(registry, "Process registry", "Immutable package catalog", "Validates activation and pins execution versions")
}
Rel(editor, registry, "Validates and activates approved packages")
Rel(github, intake, "Sends change signals")
Rel(intake, db, "Persists inbox and due work")
Rel(intake, observe, "Requests a fresh observation for a claimed PR")
Rel(observe, github, "Reads required domains")
Rel(observe, evaluate, "Supplies facts and completeness")
Rel(registry, evaluate, "Supplies pinned rules and action contracts")
Rel(evaluate, schedule, "Returns decision and reason")
Rel(schedule, db, "Claims lease and reserves budget atomically")
Rel(schedule, worker, "Dispatches one bounded attempt")
Rel(worker, validate, "Returns typed payload and evidence")
Rel(validate, db, "Commits artifact references and effect outbox")
Rel(validate, broker, "Makes committed effects available")
Rel(validate, intake, "Requests reobservation or a durable wait")
```

These are responsibilities, not a requirement for six packages or interfaces.
The first implementation should keep code together until there is a concrete
reason to split it. A pure evaluator and explicit adapters are useful from the
start because local replay depends on them.

## Process state machine

PR facts are independent inputs. This machine records execution progress.

```mermaid
stateDiagram-v2
  [*] --> WaitingSignal
  WaitingSignal --> Observing: webhook / poll / due timer
  Observing --> Deciding: complete enough observation
  Observing --> WaitingTimer: temporary read failure
  Deciding --> Running: eligible action + reserved budget
  Deciding --> WaitingSignal: draft or no new work
  Deciding --> WaitingTimer: debounce / pending reviewer
  Deciding --> WaitingHuman: decision or exhausted budget
  Running --> Validating: candidate result
  Running --> WaitingTimer: retryable failure within budget
  Running --> WaitingHuman: blocked / exhausted attempts
  Validating --> Observing: artifact only
  Validating --> Applying: validated external effect request
  Validating --> Observing: superseded input
  Validating --> WaitingHuman: invalid result limit reached
  Applying --> Observing: confirmed or precondition rejected
  Applying --> Reconciling: remote outcome unknown
  Reconciling --> Observing: destination proves outcome
  Reconciling --> WaitingHuman: cannot establish outcome
  WaitingTimer --> Observing: deadline or earlier signal
  WaitingHuman --> Observing: new relevant evidence / authorized retry
  WaitingSignal --> Closed: observed close or merge
  Deciding --> Closed: observed close or merge
  Closed --> Observing: reopened, new lifecycle generation
```

Every active state also responds to close, draft, permission revocation, and
lease loss at checkpoints. The broker rejects effects immediately when those
preconditions fail. The worker may finish computing after cancellation, but its
result cannot advance the current attempt.

An already-dispatched remote request cannot be recalled. Revocation blocks new
dispatch, and the broker reconciles any request that was already in flight.

## Repair sequence and changed head

```mermaid
sequenceDiagram
  participant G as GitHub
  participant D as Daemon
  participant S as Durable store
  participant W as Agent worker
  participant B as Effect broker
  G->>D: Signed signal
  D->>S: Persist delivery
  D-->>G: Acknowledge
  D->>S: Claim PR lease and fencing token
  D->>G: Read head H1, base B1, reviews and checks
  D->>S: Record decision and reserve repair budget
  D->>W: Pinned evidence, checkout H1, bounded grant
  W->>W: Edit candidate H2 and run isolated tests
  W-->>D: Candidate manifest and thread evidence
  D->>S: Validate and commit effect request
  D->>B: Apply committed push request
  B->>S: Verify lease, policy, and effect state
  B->>G: Read current PR and ref
  alt Current ref is H1 and policy still permits
    B->>G: Conditional fast-forward to H2
    G-->>B: Confirm or ambiguous transport result
    B->>G: Reconcile remote ref if outcome is unknown
    B->>S: Store receipt or unknown outcome
    D->>G: Reobserve H2 and specific threads
    D->>S: Plan eligible thread resolutions individually
  else Ref changed or PR is now draft
    B->>S: Reject stale request
    D->>G: Refresh current evidence
  end
  D->>S: Save next decision or durable wait
```

## Long wait and process upgrade

```mermaid
sequenceDiagram
  participant E as Engineer
  participant D as Daemon
  participant S as Durable store
  participant W as Worker
  D->>S: Commit wait until T, PR pinned to process v1
  D->>W: Stop idle sandbox after checkpoint
  E->>D: Activate validated v2 for new PRs
  D->>S: Record active v2 and retain v1 for the waiting PR
  Note over D,S: Daemon may restart. No worker must remain alive.
  D->>S: On startup, query due timers and expired leases
  S-->>D: PR due at T, pinned v1
  D->>D: Observe and evaluate v1 with current global policy
  opt Explicit migration at checkpoint
    E->>D: Migrate selected PR to v2
    D->>S: Pin v2, invalidate incompatible artifacts, retain receipts
    D->>D: Reevaluate current observation
  end
```

## Placement options

| Option | Benefits | Costs and reason to choose |
| --- | --- | --- |
| Module inside Repo Control server | One install; existing SQLite, webhook handling, UI, and settings conventions. | Worker scheduling shares HTTP availability. Team repository scope is a new contract. Reasonable for a small personal prototype if untrusted execution is still external. |
| Independent daemon in this repository | Separate restart and credential boundaries; same language/tooling; optional private UI adapter. | Adds a process/API and deployment configuration. Recommended starting architecture for team use. Source location can change later. |
| Standalone repository and service | Independent release and integration story for teams without Repo Control. | Cross-repository schema changes, duplicated hosting work, and another product interface. Choose when an external user or separate release cadence justifies it. |

Process independence does not require choosing a separate source repository now.
Keep workflow contracts independent of the Repo Control cache so either path
remains possible. Prefer a dedicated workflow database over letting the editor
and daemon write the same SQLite tables directly.

## What Repo Control already supplies

| Existing evidence | Useful pattern | Required new work |
| --- | --- | --- |
| [Webhook delivery](../../src/webhook/index.ts), [store](../../src/webhook/store.ts) | Bounded signature checks, durable delivery ledger, restart recovery. | App installation scope, review/check events, and per-PR work coalescing. |
| [Sync](../../src/sync/index.ts), [cache](../../src/cache/index.ts) | Stable node IDs, complete/partial reads, transactional updates. | Team and organization authorization, workflow lifecycle retention, full PR evidence collection. |
| [Priority service](../../src/priority/index.ts), [store](../../src/priority/store.ts) | Durable attempt reservation and stale-head handling. | General action contracts, timers, budgets, leases, and effect receipts. Its tables should remain classification-specific. |
| [Exploration engine](../../src/exploration/engine.ts) | Injected repository/model adapters, cancellation, bounded context. | CLI execution, durable sessions, isolated checkouts, and authentication separation. |
| [Merge service](../../src/merge/index.ts) | Fresh readiness check and expected-head mutation. | General effect broker. V1 process execution never invokes merge. |
| [Coordinator](../../src/coordination/index.ts), [event hub](../../src/events/index.ts) | Short shared-cache coordination and UI change events. | Durable job ownership. Never hold the existing cache gate across an agent run. The event hub is not a queue. |
| [Artifact viewer](../artifacts.md) | Self-contained presentation sharing. | Nothing for this proposal. Public artifacts must never call private process APIs. |

The current [GitHub connection contract](../architecture.md#credential-and-hosting-contract)
explicitly excludes organization-owned repositories. Team use therefore needs
an installation-scoped GitHub App or another explicitly scoped authorization
model. Reusing the personal-account sync unchanged would miss the main use case.

## Material open questions

- Is the pilot limited to trusted same-repository branches, or must it execute
  arbitrary fork contributions? This determines the required isolation boundary.
- Which deployed CLI/authentication combinations are permitted for unattended
  team use, and how can each isolate credentials from arbitrary repository code?
- Does the first host support KVM, gVisor, or only standard containers?
- Will an existing durable-workflow service be operated already? That can change
  the SQLite recommendation without changing action and effect contracts.
