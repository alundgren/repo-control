# Technical foundation

## Shape

Repo Control has three parts:

```text
Browser UI -> application server -> GitHub GraphQL API
                     |
                 local cache
```

The browser talks only to the application server. The server owns GitHub
credentials, rate-limit handling, cache reads, and refresh work. The browser
never receives a GitHub token.

## Modules

| Module | Responsibility |
| --- | --- |
| GitHub client | Fetches account-scoped pull requests, issues, labels, parent relationships, blockers, and closing issues. |
| Snapshot service | Builds a bounded account overview and records its freshness and partial-result state. |
| Item refresh service | Fetches and replaces one pull request or issue, plus the relationship facts the detail needs. |
| Workflow classifier | Applies the installation's label-to-queue mapping and marks unknown labels for Triage. |
| Local cache | Stores normalized GitHub nodes and the last successful snapshot. It never becomes a second issue tracker. |
| Query API | Gives the browser views of cached data and starts explicit refresh operations. |
| Web UI | Renders queues and item detail. It does not derive readiness from issue text. |

## Data model

Use GitHub node IDs as primary keys. Repository name plus item type plus number
is a useful display key, but numbers collide across repositories.

An item stores its GitHub facts, cache freshness, labels, body text, linked
closing issues, and open blockers. A relationship record stores both endpoints
and the relationship type. Keep raw GitHub fields only where a view needs
them. Normalize enough to update one item without rebuilding every list.

Store instance configuration separately from GitHub facts and cache generations.
It contains the label-to-queue mapping, default queue for absent or unknown
labels, and local focus. A default mapping may use `ready-for-agent`,
`ready-for-human`, and `needs-refinement`, but every installation can change
or remove those labels. The workflow classifier applies this configuration on
the server, so the browser receives a queue rather than inventing one.

The cache also stores the connected account, repositories visible to that
connection, and refresh outcome. Do not persist a GitHub token in this model.

## Data flow

1. A sampled sync gets a bounded set of open pull requests and issues from the
   connected account's visible repositories.
2. The server enriches only the selected or displayed items with blockers,
   parent links, and closing-issue relationships.
3. The workflow classifier maps each item to a configured queue. Missing and
   unknown labels go to the configured default, initially Triage.
4. The snapshot service writes the result as one cache generation. The UI keeps
   the previous generation if the next sync fails.
5. A focused refresh reads one GitHub node, updates its normalized records, and
   returns the new detail state.

## Rate-limit and failure rules

- Use GraphQL field selection and batching. Do not issue one request per row.
- Put a fixed item and repository budget on a sampled sync. Display partial
  data and the scope used when the budget is reached.
- Track GitHub's remaining rate limit and reset time. Delay an automatic retry
  rather than hammering the API.
- A focused refresh has its own small request budget. It must not trigger a
  world sync.
- Show cached data with its last successful refresh time when GitHub fails.
- Treat missing dependency relationships as unavailable, not as unblocked.

## Authentication and hosting decision

This needs an early design choice, not an implementation guess. A single-user
deployment can start with a fine-grained personal access token stored only by
the server. A GitHub App becomes preferable if a public self-hosting path needs
least-privilege installation flow and account switching.

The first implementation issue should choose one route, define the encrypted
credential store, list exact GitHub permissions, and prove that browser code
cannot read the secret.

## Future mutations

Read and write calls stay separate. A mutation endpoint must re-read the
target's current state, perform one named action, and return the result that
GitHub reports. The UI must ask for confirmation when an action has an
irreversible or externally visible effect. A successful mutation should use the
focused refresh path, not an account-wide sync.
