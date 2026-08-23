# UX notes for Repo Control

**What it is for.** Repo Control helps one person decide which pull request,
issue, or queue needs attention across the repositories they connect.

**Where it is used.** It is laptop-first for an account-wide work queue. The
interface stays usable at narrower widths when the work needs a quick check.

**Archetype.** Admin work queue.

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

Every implementation maps these roles to its native token system. The roles,
not CSS property names, are the stable contract.

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
- Work navigation: the five queue views with loaded-item counts. It becomes a
  two-column document-flow navigation on narrow screens.
- Work queue: one page header with reconciliation freshness, an account-refresh
  action, loaded-work search, queue previews, and dedicated full lists. A
  selected row keeps the list visible while a plain-text quick-read area appears
  alongside it; GitHub links stay in that area.
- Sync status: a quiet success or warning dot, reconciliation scope, and an
  underlined account-wide sync action.
- Work row: a compact number, title, repository, age, and available readiness
  or change-size facts. The whole row is the selection control. The quick-read
  area carries the bounded excerpt, relationship links or their unavailable
  state, item freshness, and the focused refresh control. Status facts use
  the success, warning, and secondary text roles.

## Deviations

The right-hand quick-read area remains because it makes the queue a stable
scan-and-read surface. At narrow widths, selection temporarily replaces the
list and a Back control restores it.
