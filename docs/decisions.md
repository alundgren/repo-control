# Decisions

## The product is called Repo Control

The name describes a personal place to inspect and eventually act on repository
work. It does not imply that the project is made by or affiliated with GitHub.

## Repository names are short in the interface

Rows show a repository name such as `orbit-tools`, plus the issue or pull
request number. A full owner name is unnecessary for a person viewing their
own connected repositories, but it remains available in the data for unique
identity and links.

## The main view is a glance, not a dashboard

The overview shows only a small preview of each queue. Dedicated views hold the
full lists. The detail opens beside the list so a quick read does not lose the
current place.

## Focus and order are secondary controls

They help only while choosing agent work. They stay behind a small disclosure
instead of competing with the queues for attention.

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
