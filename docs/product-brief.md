# Product brief

## Purpose

Repo Control gives a GitHub account owner one place to see pull requests and
issues across repositories they personally own. The first job is to answer
three questions without opening several GitHub tabs:

- What pull requests should I inspect?
- What issue can an agent start now?
- What needs a decision or a pass through triage?

## Version one

Version one is read-only.

- Show open pull requests, with rough size, a bounded in-place textual body
  excerpt, and a link back to GitHub.
- Show open issues in three queues: ready for agent, needs me, and triage.
- Show open blockers and linked closing issues when GitHub supplies them.
- Make repository identity and data freshness visible.
- Support one sampled account-wide refresh and a focused refresh for one pull
  request or issue.
- Show dedicated full-list views for every item in the current cache
  generation. A full list is not a claim that a sampled GitHub refresh was
  exhaustive; the view keeps its sampled scope and partial-result state.
- Work for any person who connects their own GitHub account. Version one
  includes only repositories whose owner is that personal account, even if the
  token can read organization-owned repositories. Production code derives
  ownership from the authenticated GitHub account and reads queue labels from
  its instance configuration. The prototype is the deliberate exception: it
  uses fictional fixture data.

## Not in version one

- Merge, edit, assign, comment, approve, or any other GitHub mutation.
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

The account-wide refresh is deliberately sampled and bounded. It updates the
cached overview without making a request per visible row.

A focused refresh fetches one selected pull request or issue after the person
knows something changed on GitHub, such as merging a pull request or assigning
an issue. It updates that item and the relationship facts shown with it. It
does not force an account-wide sync.

## Later direction

Mutating actions must be separate from the read-only work queue. Each action
needs a clear target, the state GitHub will change, and an outcome visible in
the item detail. Version one should preserve this separation in its data and
UI boundaries, without building actions early.
