# Decisions and next experiments

## Accepted constraints

| Decision | Reason |
| --- | --- |
| The service owns scheduling and execution. | GitHub Actions and hosted runners are too slow and cumbersome for this use case. Poll, webhook, and durable timers all feed the daemon. |
| Automatic fix and push; humans merge in v1. | Explicit product direction. Routine repairs should progress unattended; the final merge remains a human decision. |
| Engineers author process files with a visual editor alongside. | JSON and Markdown must remain understandable and editable without the UI. These are this service's process files. |
| Keep agent-controlled remote writes scarce. | Analysis produces validated artifacts. A host broker handles narrow permitted effects. |
| Keep deterministic and agent memory per PR. | Durable control state and editable notes serve different purposes and have different trust levels. |
| Local experiments use the developer's supported Codex or Claude login. | Engineers should be able to test a process on real PR evidence before operating a daemon. Account entitlement and write authorization remain explicit. |

## Recommended, still revisable

| Proposal | Reason | Revisit when |
| --- | --- | --- |
| Independently runnable daemon, initially developed in this repository. | Isolate execution and credentials while reusing local tooling and optional Repo Control UI. | A standalone user or separate release cadence appears. |
| Single-host SQLite scheduler and effect outbox. | Small deployment with transactional timers, leases, and budgets. | Multiple active scheduler hosts or an already-operated durable runtime becomes a requirement. |
| Independent PR facts plus an ordered rule evaluator. | Conflicts, reviews, age, and draft status overlap. | A concrete process needs concurrent branches with joins. |
| Code/agent execution and separate capability grants. | The operation's permission determines its risk. | A new action cannot be represented without broad shell/network access. |
| Brokered conditional fast-forward push. | Supports autonomous fixes with bounded credentials and stale-ref rejection. | A necessary workflow requires rewriting published history. |
| Analysis-only default for unapproved forks. | A team branch pilot can prove repair behavior without exposing privileged execution to arbitrary authors. | Explicit fork repair policy and isolation tests are complete. |
| Immutable process packages, explicit checkpoint migration. | A prompt edit should not silently change waiting PR behavior. | Migration experience shows a simpler policy retains the same audit guarantees. |
| Database authority with JSON projections and revisioned Markdown. | Keeps the requested files while preserving crash-safe multi-record changes. | The product is reduced to a strictly single-process local tool. |

## Unresolved choices with useful experiments

1. Run the same pinned fictional PR through installed Codex and Claude CLIs.
   Measure output-schema support, interrupted resume, timeout behavior, usage
   reporting, login isolation, and credential access from tool subprocesses.
   Record exact versions and commands privately; document sanitized results.
2. Benchmark cold and warm container execution on the intended host, including
   checkout, authentication, model start, test setup, and teardown. Compare a
   stronger runtime only if untrusted repository execution is in pilot scope.
3. Prototype the SQLite inbox/lease/timer/outbox loop with a fake GitHub adapter.
   Kill it after remote acceptance but before a receipt, then demonstrate
   reconciliation without duplicate push or notification.
4. Validate the proposed process vocabulary on three cases: an ordinary repair,
   a stale bot reaction, and a security finding needing a specialist. Add syntax
   only for a case the existing rules cannot express clearly.
5. Confirm GitHub App installation permissions for organization repositories,
   source-fork policy, and the exact conditional push transport. Keep merge
   permission unavailable to the workflow even if hosting credentials are broad.
6. Test whether the decision packet answers the reviewer's actual question.
   Measure time to identify the requested decision, evidence gaps, and changes
   since the last human interaction. A short packet with useful links may be
   more effective than posting the whole review in Slack.

## Deliberately later

Automatic merge, interactive Slack approvals, arbitrary action plugins, a
marketplace, concurrent graph joins, organization-wide shared agent memory,
multi-tenant hosting, and distributed schedulers are outside v1. The examples
include future merge as a rejected capability to make that boundary testable.

## Change record

- 2026-09-15: initial exploration. Recorded automatic fix/push and human merge,
  daemon-owned execution, file-first authoring, independent facts, durable
  effects, local evaluation modes, and an interactive presentation concept.
  Runtime choices and CLI/auth details remain proposals pending the experiments
  above. No engine implementation or real-PR trial was performed for this packet.
- 2026-09-15: independent review added blocked/no-change repair payloads,
  suppression of unchanged concerns after human handoff, and logical effect
  identities separate from process-version provenance. Revocation prevents new
  dispatch; already-dispatched effects are reconciled.
