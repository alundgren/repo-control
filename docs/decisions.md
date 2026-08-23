# Decisions

## The product is called Repo Control

The name describes a personal place to inspect and eventually act on repository
work. It does not imply that the project is made by or affiliated with GitHub.

## Version one is personal-account-only and read-only

Version one reads only repositories owned by the authenticated personal
account. Organization-owned repositories remain excluded even when the token
can read them. It does not merge, edit, assign, comment, approve, or make any
other GitHub mutation.

## Full lists are cached views, not unbounded syncs

Dedicated views show every item in the current cache generation. A sampled
refresh remains bounded, so the interface preserves its scope and
partial-result state instead of suggesting the list is a complete GitHub
inventory.

## A fine-grained token stays outside application storage

The first release uses a fine-grained personal access token with Metadata,
Issues, and Pull requests read permissions. Piploy's daemon injects it from its
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

## No epic view in version one

Epic context may return later, but grouping it with triage made both jobs less
clear. The first version keeps Triage to open work that needs sorting.

## Readiness means label plus dependencies

Labels express the account owner's workflow. GitHub dependency relationships
decide whether an issue is actually startable. Repo Control shows `Unblocked`,
the open blocker, or `Dependency status unavailable`.

## Refresh has two scopes

`Sync sampled view` refreshes the bounded account-wide cache. `Refresh this
item` fetches one selected item after a known GitHub change. The two actions
must remain visibly different so a focused update does not look like a global
sync.

## The prototype uses fictional data

The original design exercise used real issue data from another repository.
This public repository keeps only fictional fixtures so it does not disclose a
person's private work history or make the app look tied to one account.
