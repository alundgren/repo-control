# Technical foundation

## Shape

Repo Control has three parts:

```text
host environment -- token injection --> application server --> GitHub GraphQL API
                                         ^        |
                                         |        v
Browser UI -> named private API ---------+  private persistent SQLite cache
```

The browser talks only to the application server. The server owns GitHub
credentials, rate-limit handling, cache reads, and refresh work. The browser
never receives a GitHub token, and the API exposes purpose-built cache and
refresh operations rather than a generic GitHub GraphQL proxy.

## Modules

| Module | Responsibility |
| --- | --- |
| GitHub client | Fetches pull requests, issues, labels, parent relationships, blockers, and closing issues only for repositories owned by the authenticated personal account. |
| Snapshot service (`src/sync`) | Builds a bounded account overview and records its freshness and partial-result state. |
| Item refresh service | Fetches and replaces one pull request or issue, plus the relationship facts the detail needs. |
| Workflow classifier | Applies the installation's label-to-queue mapping and marks unknown labels for Triage. |
| Local cache | Stores normalized, private, view-serving facts and the last successful snapshot in persistent SQLite. It never becomes a second issue tracker or an archive. |
| Query API | Gives the browser views of cached data and starts explicit refresh operations. |
| Web UI | Renders queues and item detail. It does not derive readiness from issue text. |

## Data model

Use GitHub node IDs as primary keys. Repository name plus item type plus number
is a useful display key, but numbers collide across repositories.

An item stores its GitHub facts, cache freshness, labels, a bounded source-text
excerpt, linked closing issues, and open blockers. The server derives that
excerpt for the view; it does not persist a raw GitHub body or response. A
relationship record stores both endpoints and the relationship type. Keep only
the fields with an active product or operational need, and normalize enough to
update one item without rebuilding every list.

Store instance configuration separately from GitHub facts and cache generations.
It contains the label-to-queue mapping, default queue for absent or unknown
labels. A default mapping may use `ready-for-agent`,
`ready-for-human`; every installation can change or remove those labels. The
workflow classifier applies this configuration on the server, so the browser
receives a queue rather than inventing one.

The cache also stores the connected account, the personal-account-owned
repositories in scope, and refresh outcome. Do not persist a GitHub token in
this model. Organization-owned repositories are excluded even when the token
could see them.

## Data flow

1. A sampled sync filters to repositories owned by the connected personal
   account, then gets a bounded set of their open pull requests and issues.
2. The server enriches only the selected or displayed items with blockers,
   parent links, and closing-issue relationships.
3. The workflow classifier maps each item to a configured queue. Missing and
   unknown labels go to the configured default, initially Triage.
4. The snapshot service writes the result as one cache generation. The UI keeps
   the previous generation if the next sync fails.
5. A focused refresh reads one GitHub node, updates its normalized records, and
   returns the new detail state.

After a successful refresh proves that an item left the open version-one scope,
the cache deletes that item and its dependent relationships. When repository
access disappears, it deletes that repository's cached slice. Failed and
partial refreshes never infer deletion. Later releases must keep the same lean
data rule: retain data only while it has an active product or operational need,
bound history and metadata, and explicitly archive or delete data that no
longer qualifies.

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
- Private API responses use `Cache-Control: no-store`.
- Never log raw GitHub payloads. Committed fixtures are fictional.

## Credential and hosting contract

Version one uses a fine-grained personal access token for **All repositories**
under the personal account, with **Metadata**, **Issues**, and **Pull requests**
read-only permissions. Piploy's host-managed environment injects
`REPO_CONTROL_GITHUB_TOKEN`, `REPO_CONTROL_GITHUB_OWNER`, and
`REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT` when starting the application. Startup
validates the token format and future expiry locally, then reads the
authenticated viewer and repository metadata, issue, and pull-request fields.
It rejects organization viewers, a configured owner mismatch, and repositories
outside the authenticated personal account.

A bearer token cannot reveal its own repository-selection setting. The
operator must select **All repositories** when creating the token. Runtime
checks can verify returned repository access and required fields, but cannot
prove access to repositories GitHub did not return. Only server-side code reads
the token; it is never returned to the browser or stored in SQLite, and startup
logs use fixed safe messages rather than raw GitHub responses.

SQLite runs on a private persistent host volume, and the deployment is
Tailnet-restricted. The [Piploy operator runbook](piploy-operator-runbook.md)
defines the deployment payload, finite token expiry, revocation, and rotation.

## Future mutations

Read and write calls stay separate. A mutation endpoint must re-read the
target's current state, perform one named action, and return the result that
GitHub reports. The UI must ask for confirmation when an action has an
irreversible or externally visible effect. A successful mutation should use the
focused refresh path, not an account-wide sync.
