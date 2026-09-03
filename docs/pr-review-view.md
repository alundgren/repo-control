# Full-screen pull-request review: design options

Status: Option A's bounded diff overlay and tab-local line-comment drafting are
built. Review submission, merge, and the aspect tabs remain planned under epic
#69. The other two options remain possible upgrades if the overlay stops being
enough.

## What this covers

From a selected pull request in the work queue, open a full-screen review
surface and close it again, landing back on the same view, the same filter, and
the same selected row. The full-screen surface lists changed files, folds and
unfolds a diff per file, accepts line comments and an overall review summary,
and submits them to GitHub as one review. Native file-level comments need a
multi-call workflow and are deferred to issue #77.

Three options follow. They differ in where the surface lives, whether the
browser URL knows about it, and where draft comments are kept. Everything in
"What every option needs" applies to all three.

## Historical starting point

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

Review submission needs `Pull requests: Read and write`. Merge needs `Contents:
Read and write`, which also permits content and ref changes beyond merge. The
operator runbook (`docs/piploy-operator-runbook.md`) and the credential contract
in `docs/architecture.md` both state the current scope and need updating.

A fine-grained personal access token cannot report its granted permissions to
the application. `REPO_CONTROL_GITHUB_WRITE_ACTIONS` therefore defaults to
empty, and the operator enables `review`, `merge`, or both only after granting
the documented permissions. This setting records operator intent rather than
proving the token grant. GitHub permission and policy failures remain
authoritative.

### 3. A new GitHub read path for patches

GraphQL's `pullRequest.files` connection gives path, additions, deletions, and
change type. It does not give patch text. Patch text comes from REST
`GET /repos/{owner}/{repo}/pulls/{number}/files` (a `patch` field per file,
omitted for very large or binary files) or from the `.diff` media type on the
pull request itself. The client is GraphQL-only today, so this adds a REST
surface, its own error mapping, and its own rate-limit accounting. Keep it
inside the existing client module boundary so the browser still talks only to
named private endpoints.

The files endpoint pages at 100 files per request and stops after 3,000 files.
The private endpoint also limits aggregate UTF-8 patch text to 5 MiB. An omitted
patch, a parsed hunk count that disagrees with GitHub's additions and deletions,
the byte budget, and the file ceiling all produce explicit partial or
unavailable states. Patch text is held only for the open overlay and is never
persisted or server-memoized.

### 4. Batch submission shape

One private endpoint, for example `POST /api/items/:nodeId/review`, takes the
expected head SHA, an optional summary, an event (`COMMENT`, `APPROVE`, or
`REQUEST_CHANGES`), and line comments carrying `path`, `side`, and `line`.
`COMMENT` and `REQUEST_CHANGES` need at least a summary or one line comment.
`APPROVE` may be empty when GitHub accepts it.

GitHub's REST create-review `comments` input and GraphQL
`DraftPullRequestReviewThread` input do not expose a native file subject. The
separate REST comment and GraphQL thread mutations do, but using them requires a
pending review and several writes. Version one keeps a single add-review
operation and line comments only. Issue #77 owns the decision about a later
multi-call file-comment workflow.

Rules that follow from the architecture:

- Re-read the pull request head SHA immediately before submitting and block a
  detected change. Send the expected commit ID with the review. GitHub offers
  no atomic compare-and-submit guarantee for reviews, so the documentation and
  failure handling must not claim the reread closes every race.
- Submitting is externally visible, so it needs an explicit confirmation step,
  and it must never be triggered by a stray keystroke.
- After success, run a focused refresh of that item, not an account sync.
- An ambiguous network result preserves the draft, never retries automatically,
  says that the submission outcome is unknown, and sends the person to GitHub
  before any retry.

### 5. Fold, unfold, and expanded context

A patch only contains changed hunks with a few context lines. GitHub's "expand
context" control fetches the surrounding file content. Supporting it means
fetching the blob at the head SHA, which is a second read path and more bytes.
Recommendation: ship without context expansion, and add it only if reviewing
without it proves painful.

The first file with available patch text starts unfolded. Every other file
starts folded, with an independent toggle. Record this rule in `docs/ux.md`.

### 6. UX and accessibility work

`docs/ux.md` gains a component entry for the review surface: file list, file
header, diff rows, line-comment form, and the pending-comment count. The diff uses
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

- Open from the quick-read area ("Review changed files"). Close with Escape or
  a close control.
- No URL change. Returning to the same state is free, because nothing unmounted.
- Diff fetched on open from `GET /api/items/:nodeId/diff` and held only for the
  open overlay.
- Draft comments live in React state, mirrored to `sessionStorage` keyed by node
  ID and head SHA so a reload does not lose typing. Draft count, body size, and
  aggregate tab storage are bounded.
- Submit posts the batch after confirmation, clears the matching draft after a
  confirmed success, and keeps the overlay open so merge remains available.

Strengths: smallest change by a wide margin. No router, no schema, no new
persistence. The "return to the same state" requirement is satisfied by
construction. Easy to delete if the shape turns out wrong.

Weaknesses: no shareable or bookmarkable URL, and the browser back button does
not close the surface, which people will try. Drafts are tied to one tab and one
browser. A closed tab loses work. Storage failure degrades to in-memory drafts
with an explicit warning that reload recovery is unavailable.

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
2. Line-comment drafting with no submit control. Proves placement, reload, stale
   heads, and discard behavior.
3. The single review mutation, explicit operator enablement, and confirmation,
   deployed with write actions disabled.
4. Squash merge with expected-head protection, still disabled in production.
5. Operator token rotation and explicit production enablement.
6. Promote to Option B or C once the review surface has earned it.

If the answer is "go straight to the durable one", steps 1 and 2 still work as
slices; only their storage changes.

## Decisions for epic #69

- Version one renders unified diffs.
- It shows new tab-local line drafts, not existing GitHub review threads.
- Review events are Comment, Approve, and Request changes.
- A moved head leaves the stale draft visible for copy or discard and blocks a
  submission when the immediate reread detects the change.
- The overlay opens only for a pull request in the loaded queue.
- Version one does not delete the source branch after merge. Issue #78 owns the
  cleanup-policy question because GitHub offers no expected-SHA condition on a
  ref deletion.
