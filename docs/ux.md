# UX notes for Repo Control

**What it is for.** Repo Control helps one person decide which pull request,
issue, or queue needs attention across the repositories they connect, then gives
the information needed for that task most of the available space.

**Where it is used.** It is laptop-first for an account-wide work queue. The
interface stays usable at narrower widths when the work needs a quick check.

**Archetypes.** Admin work queue for the private application. Overlay for the
public artifact viewer.

## Space follows the task

| View | Main task and content | Secondary controls and context |
| --- | --- | --- |
| Now and queues | Choose work from titles, recency, blockers, and change facts. | Compact navigation, search, and sync status. Facts are plain text, not pills. |
| Issue reading window | Read the full issue title and formatted body. | A corner GitHub link and close control, then relationships, freshness, and refresh below the body. |
| Pull request review | Inspect code in the chosen aspect. | File navigation opens on request. A compact header contains the aspect dropdown and merge action. |
| AI priority | Read files in the selected tier and their reasons. | Tier controls carry selection and counts. Details explains the tier and classification. |
| Settings | Find a repository and change its visibility. | Staged changes and queue impact appear when there is a change to apply. |
| Public artifact | Read or interact with the artifact at full viewport size. | The small Share control opens sharing tools on request. |

Repeated labels, outlined metadata, nested containers, and permanent help text
spend space that belongs to the task. Remove them unless they answer a question
needed at that point. Errors, incomplete evidence, draft recovery failures, and
confirmation consequences remain visible. A compact layout must keep text
readable and controls discoverable.

## Palette

Ground: warm paper.

| Role | Value |
| --- | --- |
| Background | `#F2EADE` |
| Surface | `#EADFCD` |
| Raised surface | `#E0D2BD` |
| Divider | `#C1AF9A` |
| Field | `#F9F6F0` |
| Primary text | `#604939` |
| Secondary text | `#66574D` |
| Accent | `#784F26` |
| Link | `#3D5D71` |
| Success | `#3D6034` |
| Warning | `#7E5220` |
| Danger | `#8F3A2D` |
| Overlay backdrop | Primary text at 22% opacity |
| Share dark ground | `#292019` |
| Share dark text | `#C1AF9A` |

Every implementation maps these roles to its native token system. The roles,
not CSS property names, are the stable contract.

The two Share dark roles apply only to the collapsed public-viewer tab. They
do not introduce a dark application theme.

## Type

The application self-hosts IBM Plex Sans for prose and IBM Plex Mono for
labels and values people compare. It uses the warm-paper type scale: 16px body
text at 1.6 line-height, 28px page titles at weight 600, 22px selected-item titles, 17px queue sections
at weight 600, 13.5px secondary text and diff group headings, and
11px to 12px mono labels at weight 500. Only weights 400, 500, and 600 are
used. Code uses 14px IBM Plex Mono at 1.5 line-height so more lines fit without
reducing the prose size.

## Components

- AI priority review aspect: a five-tier strip selected through the review aspect dropdown filters both navigation and actual file diffs. Every fresh entry
  starts at 5 Critical. Counts stay visible, including zero, and lower tiers
  select an exact tier. All files start expanded. Reasons appear beside filenames in secondary prose,
  separated by spacing and a divider, and wrap when needed.
- Priority status and Details: a quiet current-head indicator uses the existing
  success role. Details contains enqueue and attempt information plus incomplete
  evidence. Waiting, failed, expired, ineligible, stale, and unavailable states
  hide scores and offer Review all files. There is no manual inference retry.
  Empty tiers stay empty until the person chooses another tier.
- Narrow priority review: all five tier controls fit in one row with stacked
  number and count above the label. The file navigator starts closed and opens
  through Navigator in every aspect, on laptop and narrow screens. Paths
  wrap and code scrolls inside its diff. This uses the existing palette, type,
  field, divider, and raised roles without adding visual tokens.

- Application shell: the page frame and reading width.
- Brand: product name with one accent mark.
- Connection state: the title, explanation, and availability note shown before
  an account connects.
- Work navigation: the five queue views with displayed-item counts. Ready for
  agent counts only issues without a configured claim or confirmed open
  blocker. It becomes a
  two-column document-flow navigation on narrow screens.
- Settings entry: the last control in the laptop work navigation. On narrow
  screens it becomes the compact gear control in the application header.
  Settings replaces the work list.
- Settings search: the primary field matches supported setting names,
  repository names, and the fixed words `ignore`, `hide`, `restore`,
  `repository`, and `sync`. An empty field suggests Repository visibility and
  links to currently hidden repositories.
- Repository visibility result: each repository states its loaded item count,
  saved or staged visibility, and one Hide or Restore action. Hidden
  repositories without active work remain available for restoration.
- Staged settings summary: every unsaved change is a sentence naming the
  repository and direction. Discard restores the saved set. Apply changes
  replaces the complete hidden set once and disables another submission while
  pending.
- Settings impact: current and proposed counts for Now, pull requests, Ready
  for agent, Needs me, Triage, and Epics, followed by the current-selection
  result and accurate account-sync copy. It appears only while changes are
  staged and sits beside the action on laptop
  and below it on narrow screens without horizontal scrolling.
- Settings save states: pending leaves saved queues in force. Failure keeps the
  staged changes and offers Apply changes or Discard. A stale revision loads
  the latest saved set, preserves staged intent, recalculates impact, and
  requires another explicit choice. Live settings events reload the overview;
  a tab with staged work enters the same conflict review.
- Visibility empty states: when every active repository is hidden, the work
  view says the queue is intentionally empty and links to Restore repositories.
  An empty queue or search links back to Repository visibility.
- Work queue: navigation and the work list occupy two desktop columns. The list
  uses the remaining width. There is no permanent detail panel.
- Description review aspect: the existing review dropdown opens the full PR title
  and safely rendered Markdown body with a corner GitHub link. Only confirmed
  merge conflicts add an inline notice. The compact review header remains in place.
- Overlay scrollbars: thin divider-colored thumbs on transparent tracks retain
  scroll position and standard wheel, touch, and keyboard scrolling without a
  bright native track. Document code and tables keep independent horizontal scrolling.
- Issue reading window: clicking an issue or epic opens a centered inset modal
  above the mounted queue. A compact header keeps repository identity, GitHub
  link, and close available while the title and full Markdown body scroll.
  Tables, task lists, quotes, and code render without executing raw HTML or
  unsafe URL schemes. Loading, retry, and empty-body states stay in the document.
  Relationship facts and focused refresh follow the body. Escape and close
  return focus and scroll to the opening row. Narrow screens retain a small
  inset and scroll the document internally.
- Sync status: a quiet success or warning dot, freshness disclosure, and an
  underlined account-wide sync action. The disclosure contains reconciliation
  totals; partial results remain visible in its summary.
- Live update availability: a quiet warning beside sync freshness when the
  server event stream is unavailable. It never disables manual sync or focused
  refresh.
- Work row: a compact number, title, repository, age, and available readiness
  or change-size facts. The whole row opens the issue reading window or the existing PR review. Status facts use
  the success, warning, and secondary text roles. Ready rows do not repeat an
  `Unblocked` fact. Issues with unavailable dependency coverage stay visible
  and keep their warning.
- Work-queue ordering: Now previews, dedicated issue queues, pull requests,
  epics, and work-item search results show the most recently updated item first.
  Readiness and item kind do not override update time. Existing queue membership
  and blocked-item visibility rules still apply.
- Loaded-work search: Ready for agent search includes claimed and
  confirmed-blocked issues hidden from its normal list. Now search includes the
  complete loaded collection. Hidden Ready results name the claim, blocker, or
  combined reason. Searches in other dedicated views stay within that view.
  Account sync, focused refresh, and live updates clear a Ready selection when
  the issue becomes claimed or blocked, then announce the reason. The Ready
  count and Now preview update with the row.
- Pull-request diff overlay: a full-viewport modal above the mounted queue.
  The compact sticky header shows repository, PR number, title disclosure,
  Navigator, and a styled native aspect dropdown. AI priority is selected on open at tier 5 Critical.
  Head hashes and change totals are omitted from the header. File navigation
  starts closed. Every file starts expanded in every aspect, including files
  with unavailable patches. Each aspect remembers its scroll and fold state.
  File headings place short AI reasons beside the monospace filename in
  secondary prose, separated by spacing and a divider, with wrapping on narrow
  screens. Code scrolls horizontally within its patch; the page does not.
  There are no comment editors, review submission controls, or bottom bar.
  Close and Escape return to the queue and its opening control.
  Merge sits at the upper right with space separating it from other controls.
  It checks current GitHub readiness and preserves the reviewed head check.
  The first press arms the button for three seconds, and a second press
  performs a squash merge. Escape or timeout locks it again. The button stays disabled
  while readiness is loading or merging is unavailable, with no status popup
  or hover label. The armed instruction and merge failures remain visible.
  Unknown mergeability retains the explicit recheck action. Nothing retries automatically.
  Confirmed merge closes the overlay. Missing, incomplete, and limited patches
  retain their explanation and GitHub fallback.
- Relationship facts: plain static mono text after status facts, a shortened
  epic title with its `closed/total` fraction on issue rows that belong to an
  epic (`Epic:` prefixes stripped before word-boundary truncation), and linked
  closing issues as `repository#number` on pull-request rows. They are
  metadata, never clickable, and never read as status. Readiness and relationship
  facts have no enclosing pill or border.
- Epics navigation row: one plain row inside the issue-queue navigation group,
  styled like the other rows, counting open epics.
- Epics view: the same queue layout. Epic rows carry title, a progress track,
  mono `closed/total`, and recency, ordered most-recently-updated first.
  Selecting an epic opens its issue reading window with progress facts below
  the body. It opens no child details and filters no lists.
- Public artifact viewer: the artifact owns the full browser viewport. A
  transparent 28 by 28 pixel Share button contains a 16 pixel connected-nodes
  icon and sits 8 pixels inside one of six supported viewport-edge positions.
  The default is bottom-right. Neutral and `light` uploads use the existing
  primary Share color at 58% opacity, while a `dark` hint uses the existing
  light Share color at 58%. The expanded panel always
  keeps the warm-paper treatment. Hover or keyboard focus opens the panel
  temporarily. Click or tap pins it. The panel contains a 128 pixel QR code,
  Copy link, Download, copy status, and a selectable link when clipboard
  access fails. It opens inward, remains 8 pixels inside the viewport, and
  scrolls internally when viewport height is limited. Hidden panel controls
  leave both keyboard order and the accessibility tree.

## Deviations

The Repository visibility screen follows option 03 on slide 5 of the pinned
settings concepts. The production version uses full queue names in the impact
list, supports multiple staged changes instead of the mockup's one sentence,
and says "hidden" rather than "ignored" in most interface copy. The impact list appears only while changes are staged, beside plain change
sentences and Apply changes. This keeps the search task clear until there are
consequences to review. Browser tests check laptop and narrow layouts through
visibility, dimensions, and interactions. Screenshots used for manual inspection
stay in temporary storage outside the checkout; image baselines are not committed.

The public viewer uses the system UI font stack instead of embedding IBM Plex.
The viewer response must stay self-contained and its CSP permits no font
request. The QR graphic alone uses pure white and black because scanner
reliability needs maximum contrast at 128 pixels. The closed Share button may
cover a 28 by 28 pixel area of the artifact. Its transparent, low-contrast
treatment deliberately falls below the usual contrast for an interactive
control so it obscures less of the artifact. The icon's hit area has the
accessible name `Share artifact`; keyboard focus adds a high-contrast outline,
and the opened panel returns to standard contrast. The open panel may cover
more, but it never changes the artifact iframe's viewport or layout.
Publisher-selected placement is bounded to six fixed positions because the
isolated viewer cannot inspect artifact content for collisions.
