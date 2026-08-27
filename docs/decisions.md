# Decisions

## The product is called Repo Control

The name describes a personal place to inspect and eventually act on repository
work. It does not imply that the project is made by or affiliated with GitHub.

## Version one is personal-account-only with one operator-consented mutation

Version one reads only repositories owned by the authenticated personal
account. Organization-owned repositories remain excluded even when the token
can read them. It does not merge, edit, assign, comment, approve, or make any
user-directed GitHub mutation. When the operator configures the receiver secret
and exact HTTPS callback URL, an explicit sync may create one missing receiver
webhook per active non-fork owned repository. Configuration is the operator's
consent; there is no UI control, confirmation dialog, or startup provisioning.
Existing matching or unrelated hooks are never repaired, disabled, updated, or
deleted. Callback and secret rotation are manual operations.

## Full lists come from reconciled cache generations

The initial account sync paginates separate searches for every open issue and
pull request in repositories owned by the authenticated personal account. A
successful full pass replaces the active cache generation, so closed, deleted,
and inaccessible work does not linger indefinitely. GitHub search has a
1,000-result cap per query. When it applies, Repo Control marks the generation
partial rather than calling it a complete inventory.

Each full search uses GitHub's `sort:updated-asc` qualifier. The ascending
update order keeps cursor traversal stable while the account changes, rather
than relying on the default result order.

Later user-triggered syncs read items updated since the last full pass with a
five-minute overlap. Node-ID upserts make overlap safe. An unset cursor makes
the next explicit sync run a full pass. It is unset before the first full pass,
after a partial full pass, and when webhook provisioning creates a repository
hook. The last case makes the next explicit sync catch up work that existed
before the hook. A full pass also happens after 24 hours. Repo Control does not
poll GitHub in the background.

## A fine-grained token stays outside application storage

The first release uses a fine-grained personal access token with Metadata,
Issues, Pull requests, and Webhooks read-and-write permissions. Piploy's daemon injects it from its
host-managed environment; the server reads it but the browser, logs, and SQLite
do not. A token is finite: expiry, revocation, and rotation are normal operator
events.

## Private SQLite is a lean cache, not a history store

The Tailnet-restricted deployment keeps private cached facts in persistent
SQLite. The cache retains only bounded data with an active product or
operational need, including source-text excerpts rather than raw GitHub
payloads. Successful refreshes delete data that left the open scope or lost
repository access; failed or partial refreshes do not. Later releases must
explicitly archive or delete data that is no longer needed.

## Epic context is metadata plus a separate view, not a queue

Reversed: "No epic view in version one." With the configurable `epic` label
(stored in instance configuration, default `epic`) and GitHub's native sub-issue
graph, epic awareness landed without re-crowding triage. Epics are never
classified into any queue, so Triage keeps only open work that needs sorting.

The rule that replaced the old trade-off: nothing encodes "done". Visibility is
GitHub's open/closed state alone — a closed epic disappears everywhere; the
child fraction is inert display data the account owner interprets. Nested epics
are tolerated as ordinary children rather than validated.

## Readiness means label plus dependencies

Labels express the account owner's workflow. GitHub dependency relationships
decide whether an issue is actually startable. Repo Control shows `Unblocked`,
the open blocker, or `Dependency status unavailable`.

## Refresh has two scopes

`Sync account` reconciles the account cache. `Refresh this item` fetches one
selected item after a known GitHub change. The two actions
must remain visibly different so a focused update does not look like a global
sync.

## The prototype uses fictional data

The original design exercise used real issue data from another repository.
This public repository keeps only fictional fixtures so it does not disclose a
person's private work history or make the app look tied to one account.
