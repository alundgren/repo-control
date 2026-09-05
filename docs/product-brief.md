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
receiver webhook that is missing from an eligible personal repository or
update the matching receiver when the required event specification advances.

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
- Let the account owner hide repositories from every work view and restore
  them through Settings. Account sync still caches current work from hidden
  repositories. Active-snapshot counts describe everything loaded from
  GitHub, while visible counts describe what the work views can show.
- Work for any person who connects their own GitHub account. Version one
  includes only repositories whose owner is that personal account, even if the
  token can read organization-owned repositories. Production code derives
  ownership from the authenticated GitHub account and reads queue labels from
  its instance configuration. The prototype is the deliberate exception: it
  uses fictional fixture data.

## Not in version one

- Merge, edit, assign, or user-directed GitHub mutations other than enabled
  pull-request review submission.
- AI summaries, agent dispatch, or a local model integration.
- Project-management features beyond the read-only epic view described below.
- Notifications, background polling, or multi-user collaboration.
- Organization-owned repositories or GitHub Apps.

## Epic rules

Epics are the account owner's convention for grouping issues toward a common
goal. An issue labelled with the instance's epic label (configurable alongside
the queue mapping; default `epic`) never enters a workflow queue and does not
clutter triage. Epics appear on their own view plus a small preview on Now;
membership travels on rows as static pills that can reach the epic. Nothing
encodes "done": visibility follows GitHub's open state only, and the
`closed/total` fraction is inert display data for the account owner to judge.

## Queue rules

The queues are a personal convention, not GitHub concepts. Each installation
configures its label-to-queue mapping. A new installation may offer
`ready-for-agent` and `ready-for-human` as defaults, but the app does not
treat those strings as universal.

Ready for agent omits issues with a confirmed open blocker and issues carrying
the installation's claimed label. The claimed label is instance configuration
and defaults to `claimed`. Its navigation count and Now preview use the same
filtered queue. The cache and API retain every loaded issue, so Ready and Now
searches can still find hidden work and say whether a claim, an open blocker,
or both kept it out of Ready. `scope.itemCount` and `scope.repositoryCount`
count the complete active snapshot. Visible item and repository counts exclude
hidden repositories. The ignored count includes remembered hidden repositories
that have left the active snapshot.

Incomplete dependency data never hides an issue from Ready. Repo Control keeps
the issue visible with a dependency-status warning instead of guessing that it
is blocked or unblocked. Other dedicated-view searches remain within their
complete queue or pull-request collection. An unlabelled open issue belongs in
Triage.

## Refresh rules

The account-wide refresh reconciles every open issue and pull request that
GitHub search returns for the personal account. It updates the
cached overview without making a request per visible row.

A focused refresh fetches one selected pull request or issue after the person
knows something changed on GitHub, such as merging a pull request or assigning
an issue. It updates that item and the relationship facts shown with it. It
does not force an account-wide sync.

A focused refresh stops before contacting GitHub when its cached item belongs
to a hidden repository. Account sync and webhook processing may keep that
cached work current, but no work view, search result, count, selection, epic,
closing issue, or blocker detail exposes the hidden repository. Restoring a
repository reveals only work in the active snapshot. It never reads an older
generation to fill the view.

When both the receiver secret and a validated public receiver URL are set, an
explicit account sync also inventories the personal account's repositories and
creates a missing receiver webhook for each active, non-fork repository. This
is repeat-safe and needs no browser control or startup task. A versioned
provisioning result may update the one matching receiver when the required
event set changes. Repo Control never changes unrelated hooks; callback and
secret rotation remain manual operator work.

## Mutation boundary

Mutating actions stay separate from the read-only work queue. Each action
needs a clear target, the state GitHub will change, and an outcome visible in
the item detail. Pull-request review submission is the first such action. It is
operator-enabled, requires confirmation, and sends the summary and line comments
as one review.
