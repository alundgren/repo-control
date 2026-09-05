# UX notes for Repo Control

**What it is for.** Repo Control helps one person decide which pull request,
issue, or queue needs attention across the repositories they connect.

**Where it is used.** It is laptop-first for an account-wide work queue. The
interface stays usable at narrower widths when the work needs a quick check.

**Archetypes.** Admin work queue for the private application. Overlay for the
public artifact viewer.

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
| Share dark ground | `#292019` |
| Share dark text | `#C1AF9A` |

Every implementation maps these roles to its native token system. The roles,
not CSS property names, are the stable contract.

The two Share dark roles apply only to the collapsed public-viewer tab. They
do not introduce a dark application theme.

## Type

The application self-hosts IBM Plex Sans for prose and IBM Plex Mono for
labels and values people compare. It uses the warm-paper type scale: 16px body
text at 1.6 line-height, 28px to 40px page titles at weight 600, 22px sections
at weight 600, 17px subsections at weight 600, 13.5px secondary text, and
11px to 12px mono labels at weight 500. Only weights 400, 500, and 600 are
used.

## Components

- Application shell: the page frame and reading width.
- Brand: product name with one accent mark.
- Connection state: the title, explanation, and availability note shown before
  an account connects.
- Work navigation: the five queue views with displayed-item counts. Ready for
  agent counts only issues without a configured claim or confirmed open
  blocker. It becomes a
  two-column document-flow navigation on narrow screens.
- Work queue: on desktop, a three-column scan-and-read layout keeps navigation,
  the page header and loaded-work search, and the quick read in separate
  columns. A selected row keeps the list visible while a plain-text quick-read
  area stays in the right column; GitHub links stay in that area.
- Sync status: a quiet success or warning dot, reconciliation scope, and an
  underlined account-wide sync action.
- Live update availability: a quiet warning beside sync freshness when the
  server event stream is unavailable. It never disables manual sync or focused
  refresh.
- Work row: a compact number, title, repository, age, and available readiness
  or change-size facts. The whole row is the selection control. The quick-read
  area carries the bounded excerpt, relationship links or their unavailable
  state, item freshness, and the focused refresh control. Status facts use
  the success, warning, and secondary text roles. Ready rows do not repeat an
  `Unblocked` fact. Issues with unavailable dependency coverage stay visible
  and keep their warning.
- Loaded-work search: Ready for agent search includes claimed and
  confirmed-blocked issues hidden from its normal list. Now search includes the
  complete loaded collection. Hidden Ready results name the claim, blocker, or
  combined reason. Searches in other dedicated views stay within that view.
  Account sync, focused refresh, and live updates clear a Ready selection when
  the issue becomes claimed or blocked, then announce the reason. The Ready
  count and Now preview update with the row.
- Pull-request diff overlay: a selected pull request opens a full-viewport
  modal above the mounted queue. On laptop screens, its single-row sticky
  header is at most 3.5rem high and keeps the repository, pull request, head
  commit, change totals, Grouped and Files controls, pending-comment count,
  conditional Discard all action, and close action together. Long titles
  truncate in that row; the title disclosure shows the complete text to
  keyboard and pointer users. On narrow screens, the same header uses compact
  title, head-commit, and control lines so every action remains reachable
  without horizontal page scrolling. Grouped is selected on open. A persistent bottom review bar keeps
  the current-head comment count, commit, review outcome, submit action, merge
  action, and merge readiness in one place. The optional review summary opens
  above that bar as the explicit submission confirmation step. The server
  assigns every file to one group from its path and filename. Category groups
  precede directory groups. Generated group labels are lowercase when every
  changed path is lowercase and otherwise start with an uppercase letter. Each
  view keeps its own scroll position and per-file fold state. The
  first file with patch text starts unfolded while every other file starts folded.
  The close control and Escape return to the exact queue state and opening
  control. Each comment form belongs to a path, line, old or new side, and the
  displayed head SHA. Saved forms appear with their line in both Grouped and
  Files, while a live pending count stays in the overlay controls. Drafts are
  limited to 100 per pull request and head SHA, 16 KiB of UTF-8 text per body,
  and 1 MiB of serialized draft data across the tab. A rejected addition or edit
  leaves saved drafts unchanged and explains which limit was reached. Drafts
  live in the current browser tab and use session storage for same-tab reloads.
  If storage is unavailable or a write fails, the form keeps working in memory
  and warns that reload recovery is unavailable. Drafts saved against an earlier
  head SHA remain in a separate stale section where their text can be copied or
  discarded. Closing the overlay and switching arrangements never clears,
  moves, or duplicates them. Each draft has its own discard action, and Discard
  all immediately removes every current and stale draft for that pull request.
  When the operator enables review submission, the review bar
  lets the person choose Comment, Approve, or Request changes and add an optional
  summary. The submit control states how many comments belong to the displayed
  head and asks for confirmation before contacting GitHub. Comment and Request
  changes require a summary or line comment. Approve may be empty. A changed
  head, failed verification, or GitHub rejection keeps the drafts and explains
  what stopped. An ambiguous response says `Submission outcome unknown`, keeps
  the drafts, and links to GitHub for verification before any retry. Confirmed
  success clears only drafts for the submitted head, runs a focused refresh,
  and keeps the overlay open. If the saved reload copy cannot be confirmed as
  removed, the result warns that the review was submitted and must not be
  retried. Merge remains a separate danger-marked action within the review bar.
  It reads current GitHub state when the overlay opens and shows checking,
  pending checks, a named block, unavailable, or not-permitted text. If GitHub
  is still calculating mergeability, Check again repeats the readiness read.
  Network and mutation failures never retry automatically. Only a configured
  and currently ready pull request gets a Merge control. Its first press slides
  from a lock icon to a merge icon and arms the same control for three seconds.
  A second press during that window starts a squash merge; an unused window
  locks itself again. The nearby status states that Repo Control will not delete
  the pull request branch. A moved head, permission denial,
  policy rejection, or validation failure states that nothing was retried. An
  ambiguous response sends the person to GitHub before another attempt.
  Confirmed success silently discards every pending draft for the pull request
  and closes the overlay while focused refresh and the item event remove the
  pull request from the queue. If live updates removed the opening control, focus
  returns to the queue heading. Added and removed rows use low-saturation tints derived from the
  success and warning roles, plus visible `+` and `−` gutter markers so colour
  is never the only distinction. Omitted, incomplete, and size-limited patches,
  a partial file list, and a failed read each state what is missing and link to
  GitHub.
- Relationship pills: small static mono pills after status facts — a shortened
  epic title with its `closed/total` fraction on issue rows that belong to an
  epic (`Epic:` prefixes stripped before word-boundary truncation), and linked
  closing issues as `repository#number` on pull-request rows. They are
  metadata, never clickable, and never read as status.
- Epics navigation row: one plain row inside the issue-queue navigation group,
  styled like the other rows, counting open epics.
- Epics view: the same three-column scan-and-read layout as the queues. Epic
  rows carry title, thin progress track, mono `closed/total`, and recency,
  ordered most-recently-updated first. Selecting an epic shows a minimal quick
  read (identity, excerpt, raw fraction with bar, freshness, GitHub link) and
  opens no child details and filters no lists.
- Public artifact viewer: the artifact owns the full browser viewport. A
  72 by 28 pixel Share tab sits at the bottom-right edge. Its neutral treatment
  has no fill or halo. On neutral and `light` uploads, primary text appears at
  58% opacity and the primary-text boundary at 28%. A `dark` hint uses Share
  dark text at 58% and a field boundary at 28%. The expanded panel always
  keeps the warm-paper treatment. Hover or keyboard focus opens the panel
  temporarily. Click or tap pins it. The panel contains a 128 pixel QR code,
  Copy link, Download, copy status, and a selectable link when clipboard
  access fails. Hidden panel controls leave both keyboard order and the
  accessibility tree.

## Deviations

The right-hand quick-read area remains because it makes the queue a stable
scan-and-read surface. At narrow widths, selection temporarily replaces the
list and a Back control restores it.

The public viewer uses the system UI font stack instead of embedding IBM Plex.
The viewer response must stay self-contained and its CSP permits no font
request. The QR graphic alone uses pure white and black because scanner
reliability needs maximum contrast at 128 pixels. The closed Share tab may
cover a 72 by 28 pixel area of the artifact. Its transparent, low-contrast
treatment deliberately falls below the usual contrast for an interactive
control so it obscures less of the artifact. The labeled 72 by 28 pixel hit
area remains in place, keyboard focus adds a high-contrast outline, and the
opened panel returns to standard contrast. The open panel may cover more, but
it never changes the artifact iframe's viewport or layout.
