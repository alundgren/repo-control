# Full-screen pull-request review: design options

Status: decided, not built. Option A, the overlay, was chosen, with aspect
tabs over the same change. The work is planned as epic #69. The other two
options are kept here because they remain the upgrade path if the overlay
stops being enough.

## What this covers

From a selected pull request in the work queue, open a full-screen review
surface and close it again, landing back on the same view, the same filter, and
the same selected row. The full-screen surface lists changed files, folds and
unfolds a diff per file, accepts comments on a line and on a whole file, and
submits the collected comments to GitHub as one batch review.

Three options follow. They differ in where the surface lives, whether the
browser URL knows about it, and where draft comments are kept. Everything in
"What every option needs" applies to all three.

## Where this starts from

- `src/web/App.tsx` holds all view state in React state, including `view`,
  `query`, `selectedItemId`, and scroll position implied by the DOM. There is
  no router, no `history` use, and no hash handling.
- The private API (`src/api/plugin.ts`) exposes `GET /api/overview`,
  `POST /api/sync`, and `POST /api/items/:nodeId/refresh`. Nothing else.
- The GitHub client (`src/github/read-client.ts`) is GraphQL-only and read-only.
  It fetches search pages, focused items, relationship batches, and epic
  progress. It fetches no file lists and no patches.
- The cache stores lean, view-serving facts. Diff text is not in it.
- Documented product position: version one performs no user-directed GitHub
  mutation (`docs/decisions.md`). The production token is `Pull requests:
  read-only` (`docs/architecture.md`).

## What every option needs

These items are independent of which option is chosen. They are the bulk of the
work.

### 1. A decision change, not just a feature

Submitting a review is a user-directed mutation. It contradicts the recorded
version-one decision. `docs/decisions.md` needs a new decision that names the
first user-directed mutation, the confirmation rule, and why the read and write
paths stay separate. `docs/architecture.md` already reserves the shape for this
under "Future mutations": re-read current state, perform one named action,
return what GitHub reports, refresh the item in a focused way afterwards.

### 2. A token permission upgrade

`Pull requests: Read and write` replaces the read-only grant. The operator
runbook (`docs/piploy-operator-runbook.md`) and the credential contract in
`docs/architecture.md` both state the current scope and need updating. Startup
validation should confirm the write scope is present before the review UI
offers a submit control, and degrade to a read-only diff viewer when it is not.

### 3. A new GitHub read path for patches

GraphQL's `pullRequest.files` connection gives path, additions, deletions, and
change type. It does not give patch text. Patch text comes from REST
`GET /repos/{owner}/{repo}/pulls/{number}/files` (a `patch` field per file,
omitted for very large or binary files) or from the `.diff` media type on the
pull request itself. The client is GraphQL-only today, so this adds a REST
surface, its own error mapping, and its own rate-limit accounting. Keep it
inside the existing client module boundary so the browser still talks only to
named private endpoints.

Verify before building: per-file `patch` is truncated or omitted above GitHub's
size thresholds, and the files endpoint pages at 100 files per request with a
3000-file ceiling. The UI needs a defined "diff too large, open on GitHub"
state for both.

### 4. Batch submission shape

One private endpoint, for example `POST /api/items/:nodeId/review`, takes the
whole batch: an optional body, an event (`COMMENT`, `APPROVE`,
`REQUEST_CHANGES`), and a list of comments carrying `path`, `side`, `line`,
optional `start_line`, and a file-level marker.

Verify before building: REST `POST /repos/{owner}/{repo}/pulls/{number}/reviews`
accepts the comment array in one call and supports `subject_type: "file"` for
file-level comments. The GraphQL `addPullRequestReview` path is a worse fit for
file-level subjects. Confirm both against current GitHub docs before choosing,
because this single fact decides whether "comment on a file" is one request or
several.

Rules that follow from the architecture:

- Re-read the pull request head SHA immediately before submitting. Comments
  anchored to an outdated SHA land on the wrong lines or fail.
- Submitting is externally visible, so it needs an explicit confirmation step,
  and it must never be triggered by a stray keystroke.
- After success, run a focused refresh of that item, not an account sync.
- Partial failure needs a defined outcome. Prefer one atomic request so there is
  no half-posted review to reconcile.

### 5. Fold, unfold, and expanded context

A patch only contains changed hunks with a few context lines. GitHub's "expand
context" control fetches the surrounding file content. Supporting it means
fetching the blob at the head SHA, which is a second read path and more bytes.
Recommendation: ship without context expansion, and add it only if reviewing
without it proves painful.

Default fold state is a real UX decision. Suggested rule: unfolded when the file
has few changed lines and the total on-screen diff stays modest, folded
otherwise, with per-file toggles and an expand-all control. Record the chosen
rule in `docs/ux.md`.

### 6. UX and accessibility work

`docs/ux.md` gains a component entry for the review surface: file list, file
header, diff rows, comment form, and the pending-comment count. The diff uses
the existing palette roles. Added and removed lines need a role mapping that is
not colour alone, because the warm-paper palette has no green/red pair and the
success and warning roles are already carrying status meaning elsewhere. A
left gutter marker plus a low-saturation tint is the safer route.

Keyboard and screen-reader needs: focus moves into the surface on open and
returns to the originating row on close, Escape closes, the diff is navigable
without a mouse, and the pending-comment count is announced.

### 7. Testing

Per the repo's testing rule, each slice gets one focused failing test at a
public seam first: the API route contract, the read-model shape, and the
rendered surface through Testing Library. Fixtures stay fictional. The batch
submit path deserves a test that proves nothing is sent to GitHub until the
confirmation step.

## Option A: Overlay over the current app

The full-screen surface is a React overlay rendered by `App`, above the existing
three-column shell, with the queue still mounted underneath.

- Open from the quick-read area ("Review changed files") and with a keyboard
  shortcut on the selected row. Close with Escape or a close control.
- No URL change. Returning to the same state is free, because nothing unmounted.
- Diff fetched on open from `GET /api/items/:nodeId/diff`. Held in memory for
  the session only, with a small server-side memo keyed by node ID and head SHA
  so an accidental reopen does not re-spend rate limit.
- Draft comments live in React state, mirrored to `sessionStorage` keyed by node
  ID and head SHA so a reload does not lose typing.
- Submit posts the batch, shows the confirmation, then closes back to the queue.

Strengths: smallest change by a wide margin. No router, no schema, no new
persistence. The "return to the same state" requirement is satisfied by
construction. Easy to delete if the shape turns out wrong.

Weaknesses: no shareable or bookmarkable URL, and the browser back button does
not close the surface, which people will try. Drafts are tied to one tab and one
browser. A closed tab loses work, and `sessionStorage` has a size ceiling that a
long review with quoted code can approach.

Best when the goal is to learn whether reviewing here beats reviewing on GitHub.

## Option B: Routed review workspace

The surface is a real route, entered by pushing history state, for example
`#/pull/<repositoryId>/<number>/files`, with the queue view, filter, and
selection captured in the state the route replaced.

- Back button, Escape, and the close control all pop back to the exact prior
  state, because that state is stored in the history entry rather than inferred.
- Diff fetched through the same private endpoint, but cached in SQLite keyed by
  pull-request node ID and head SHA, with an expiry and a size ceiling, in the
  pattern the artifact service already uses. Re-opening is instant, and the
  GitHub read budget is protected.
- Draft comments persist server-side, one open draft per pull request, so a
  reload, a crash, or a different machine on the Tailnet resumes the same
  review. A draft records the head SHA it was written against and is marked
  stale when the pull request moves on.
- Submit posts the batch, clears the draft, and runs a focused refresh.

Strengths: the durable product answer. Reviews survive interruption, which is
the normal case for a real review. URLs are linkable. Stale-draft handling is
explicit instead of accidental.

Weaknesses: the most machinery. Two new tables, an expiry policy, a staleness
policy, and a first router in an app that has none. Persisting diff text and
draft comments needs an explicit argument against the lean-data rule in
`docs/architecture.md`, including what is deleted and when. Draft comment text
is private content held on disk, so the privacy rule in `AGENTS.md` applies to
logs and fixtures around it.

Best when review in Repo Control is meant to be the real workflow rather than
an experiment.

Not chosen for the first delivery. The persistence argument still stands: a
review that cannot survive a closed tab will send you back to GitHub the first
time it matters. Server-held drafts are the named upgrade from Option A, and
are deferred in #73 rather than dismissed.

## Option C: Review as its own page

The review surface is served as its own document, for example
`GET /review/<nodeId>`, opened in a new browser tab from the queue.

- The queue tab is never unmounted, so "close and get back to the same state"
  is literally closing a tab.
- Two pull requests can be reviewed side by side, and a review can sit open on a
  second monitor while the queue keeps updating.
- Drafts must be server-held, as in Option B, because two tabs otherwise
  disagree about what is pending.

Strengths: complete separation of scanning from reviewing. No overlay, no focus
trap, no layout compromise with the three-column shell. Matches the existing
"open on GitHub in a new tab" habit.

Weaknesses: a second application entry point, a second shell, and a second SSE
subscription per open tab. Keyboard flow between queue and review is whatever
the browser offers. The queue tab can drift out of date relative to a review
submitted in another tab unless the change event stream is wired to reconcile
it. Needs all of Option B's persistence work plus the extra entry point.

Best when reviewing is a long, focused session rather than a step in the queue
flow.

## Comparison

| | A: Overlay | B: Routed workspace | C: Own page |
| --- | --- | --- | --- |
| Restores prior state | By construction | From history state | Tab never left |
| Back button closes it | No | Yes | N/A |
| Linkable URL | No | Yes | Yes |
| Drafts survive reload | Same tab only | Yes | Yes |
| Drafts survive tab close | No | Yes | Yes |
| New persistence | None | Diff cache, draft store | Diff cache, draft store |
| New app entry point | No | No | Yes |
| Relative build size | Small | Medium | Medium plus |

## A staged path

The options are not mutually exclusive over time, and the read half is worth
separating from the write half.

1. Read-only diff viewer, Option A shape. Proves the file list, folding, and
   diff rendering without touching token scope or the mutation decision.
2. Comment drafting with no submit control. Proves the comment placement model
   and the batch preview.
3. Token scope, decision record, and the single batch submit endpoint with
   confirmation.
4. Promote to Option B, or to C, once the surface has earned it.

If the answer is "go straight to the durable one", steps 1 and 2 still work as
slices; only their storage changes.

## Open questions

- Split or unified diff? Unified is far less work and fits the current column
  widths. Split needs a wider surface than the three-column shell has.
- Does the review need to show existing review comments and replies from
  GitHub, or only new ones? Showing them adds another read and a threading
  model, and its absence will be felt on any pull request with prior discussion.
- Should approve and request-changes be offered at all in the first version, or
  only plain comment reviews? Restricting to `COMMENT` keeps the first mutation
  as low-stakes as possible.
- What happens to a pending draft when the head SHA moves mid-review? Options:
  block submission, submit anyway and let GitHub reject stale lines, or offer to
  re-anchor. This needs a decision before drafts are persisted.
- Should the diff be reachable for a pull request that is not in the loaded
  cache generation?
