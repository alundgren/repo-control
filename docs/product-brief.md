# Product brief

## Purpose

Repo Control gives a GitHub account owner one place to see pull requests and
issues across repositories they personally own. The first job is to answer
three questions without opening several GitHub tabs:

- What pull requests should I inspect?
- What issue can an agent start now?
- What needs a decision or a pass through triage?

## Version one

Version one reads GitHub work data. It also has one operator-consented
infrastructure mutation: during an explicit account sync it can create the
receiver webhook that is missing from an eligible personal repository.

- Show open pull requests, with rough size, a bounded in-place textual body
  excerpt, and a link back to GitHub.
- Show open issues in three queues: ready for agent, needs me, and triage.
- Show open blockers and linked closing issues when GitHub supplies them.
- Make repository identity and data freshness visible.
- Support one reconciled account-wide refresh and a focused refresh for one pull
  request or issue.
- Show dedicated full-list views for every item in the current cache
  generation. A full list reflects the last reconciliation; the view still
  exposes a partial-result state when GitHub's search cap prevents a full inventory.
- Work for any person who connects their own GitHub account. Version one
  includes only repositories whose owner is that personal account, even if the
  token can read organization-owned repositories. Production code derives
  ownership from the authenticated GitHub account and reads queue labels from
  its instance configuration. The prototype is the deliberate exception: it
  uses fictional fixture data.

## Not in version one

- Merge, edit, assign, comment, approve, or any user-directed GitHub mutation.
- AI summaries, agent dispatch, or a local model integration.
- Epic-specific navigation or project management views.
- Notifications, background polling, or multi-user collaboration.
- Organization-owned repositories or GitHub Apps.

## Queue rules

The queues are a personal convention, not GitHub concepts. Each installation
configures its label-to-queue mapping. A new installation may offer
`ready-for-agent` and `ready-for-human` as defaults, but the app does not
treat those strings as universal.

An issue with an open blocker stays visible in its labelled queue, but it is
not eligible for a next-item recommendation. An unlabelled open issue belongs
in Triage. If dependency data is unavailable, Repo Control says so and does
not guess.

## Refresh rules

The account-wide refresh reconciles every open issue and pull request that
GitHub search returns for the personal account. It updates the
cached overview without making a request per visible row.

A focused refresh fetches one selected pull request or issue after the person
knows something changed on GitHub, such as merging a pull request or assigning
an issue. It updates that item and the relationship facts shown with it. It
does not force an account-wide sync.

When both the receiver secret and a validated public receiver URL are set, an
explicit account sync also inventories the personal account's repositories and
creates a missing receiver webhook for each active, non-fork repository. This
is repeat-safe and needs no browser control or startup task. Repo Control never
repairs, disables, deletes, rotates, or otherwise changes an existing webhook;
those remain manual operator work.

## Later direction

Mutating actions must be separate from the read-only work queue. Each action
needs a clear target, the state GitHub will change, and an outcome visible in
the item detail. Version one should preserve this separation in its data and
UI boundaries, without building actions early.
