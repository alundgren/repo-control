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
| GitHub read client | Paginates account-scoped searches for open issues and pull requests, then fetches relationship batches. It retains only results whose repository owner is the authenticated personal account. |
| GitHub webhook client | Separately pages repository hooks and creates one configured receiver hook. It never updates, disables, or deletes a hook. |
| Snapshot service (`src/sync`) | Reconciles the open account inventory, records the last complete reconciliation, uses an overlapping update-time read between full reconciliations, and coordinates opted-in webhook provisioning. |
| Item refresh service | Fetches and replaces one pull request or issue, plus the relationship facts the detail needs. |
| Workflow classifier | Applies the installation's label-to-queue mapping, keeps epic-labelled issues out of every queue, and marks unknown labels for Triage. |
| Local cache | Stores normalized, private, view-serving facts and the last successful snapshot in persistent SQLite. It never becomes a second issue tracker or an archive. |
| Query API | Gives the browser views of cached data and starts explicit refresh operations. |
| Webhook delivery | Verifies bounded signed deliveries, records a small SQLite ledger, resumes pending work, and starts focused refresh or upsert. |
| Webhook provisioning | Atomically replaces the complete owned-repository inventory, then records only `created` or `already_present` terminal outcomes per account and repository. |
| Change event stream | Publishes post-commit item changes to private SSE subscribers. Browser reconnects reconcile the authoritative overview before applying buffered events. |
| Web UI | Renders queues and item detail. It does not derive readiness from issue text. |

## Data model

Use GitHub node IDs as primary keys. Repository name plus item type plus number
is a useful display key, but numbers collide across repositories.

An item stores its GitHub facts, including its creation and update times, cache freshness, labels, a bounded source-text
excerpt, linked closing issues, and open blockers. The server derives that
excerpt for the view; it does not persist a raw GitHub body or response. A
relationship record stores both endpoints and the relationship type. Keep only
the fields with an active product or operational need, and normalize enough to
update one item without rebuilding every list.

Store instance configuration separately from GitHub facts and cache generations.
It contains the label-to-queue mapping, default queue for absent or unknown
labels. A new installation is seeded with `ready-for-agent` to `agent` and
`ready-for-human` to `human`, defaulting to `triage`; every installation can
change or remove those labels, and the seed never overwrites a mapping that is
already configured. The
workflow classifier applies this configuration on the server, so the browser
receives a queue rather than inventing one.

The cache also stores the connected account, the personal-account-owned
repositories in scope, and refresh outcome. Do not persist a GitHub token in
this model. Organization-owned repositories are excluded even when the token
could see them.

The provisioning inventory is separate from the view-serving snapshot: it holds
each owned repository's node ID, current name, fork state, archived state, and
observation time. A terminal provisioning ledger is keyed by account and
repository node IDs. It stores no callback URL, receiver secret, token, or
GitHub response body.

## Data flow

1. An initial sync paginates two account-scoped searches: all open issues and
   all open pull requests. Both use `sort:updated-asc`, which gives cursor
   traversal a monotonic order instead of GitHub's moving default. Every result
   must still name a repository owned by the connected personal account before
   it enters the cache.
2. The server enriches every returned item in small batches with blockers and
   closing-issue relationships. A failed or incomplete enrichment marks that
   dependency status unavailable. It never guesses that an issue is unblocked.
3. The workflow classifier maps each item to a configured queue. Missing and
   unknown labels go to the configured default, initially Triage.
4. The snapshot service writes the result as one cache generation only after
   all reads finish. The UI keeps the previous generation if a sync read fails.
5. A focused refresh reads one GitHub node, updates its normalized records, and
   returns the new detail state.
6. A signed issue or pull-request webhook records its delivery before
   acknowledgement. The asynchronous worker uses focused refresh for cached
   work and a validated focused upsert for an uncached open item.
7. A successful item write or removal publishes one item-scoped change. The SSE
   route sends it to connected browsers without making cache reads or manual
   sync depend on stream delivery.
8. When the operator has supplied both a receiver secret and a validated exact
   HTTPS callback URL, the same explicit sync fully pages the owned repository
   inventory and commits it atomically. Only then it serially checks each
   eligible repository without a terminal ledger outcome. An exact existing
   callback records `already_present`; otherwise it creates an active JSON hook
   for only issues and pull requests, then records `created`. A list or create
   failure records no terminal result, so a later explicit sync retries. No
   hook is ever repaired or removed.

After a complete inventory reconciliation, a user-triggered sync uses
`updated:>=` from that reconciliation with a five-minute overlap. Node IDs make
these upserts idempotent. An unset reconciliation cursor forces a full pass on
the next explicit sync. The cursor begins unset, stays unset after a partial
full pass, and is cleared when webhook provisioning creates a repository hook
so the following explicit sync catches up that repository's earlier work. A
full reconciliation also runs once the prior full one is 24 hours old. There
is no background polling. The full pass removes open-cache entries that were
closed, deleted, or became inaccessible. GitHub search exposes at most 1,000
results per query, so a type that reaches that cap is recorded as partial rather
than presented as a full inventory.

After a successful refresh proves that an item left the open version-one scope,
the cache deletes that item and its dependent relationships. When repository
access disappears, it deletes that repository's cached slice. Failed and
partial refreshes never infer deletion. Later releases must keep the same lean
data rule: retain data only while it has an active product or operational need,
bound history and metadata, and explicitly archive or delete data that no
longer qualifies.

## Rate-limit and failure rules

- Use GraphQL field selection and batching. Do not issue one request per row.
- Search pages contain at most 100 results. Paginate until GitHub finishes the
  connection, and report its 1,000-result search cap as partial data.
- Track GitHub's remaining rate limit and reset time. Delay an automatic retry
  rather than hammering the API.
- A focused refresh has its own small request budget. It must not trigger a
  world sync.
- Show cached data with its last successful refresh time when GitHub fails.
- Treat missing dependency relationships as unavailable, not as unblocked.
- Private API responses use `Cache-Control: no-store`.
- Emit one structured terminal event for each underlying sync, focused refresh,
  and webhook delivery. Events go to stdout, use an allow-list of safe fields,
  and never include raw GitHub payloads, request bodies, credentials, or error
  messages. Committed fixtures are fictional.

## Credential and hosting contract

Production uses a fine-grained personal access token for **All repositories**
under the personal account, with **Metadata**, **Issues**, and **Pull requests**
read-only permissions plus **Webhooks: Read and write**. Piploy's host-managed environment injects
`REPO_CONTROL_GITHUB_TOKEN`, `REPO_CONTROL_GITHUB_OWNER`, and
`REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT` when starting the application. Startup
validates the PAT format and future expiry locally, then reads the authenticated
viewer and repository metadata, issue, and pull-request fields. It rejects
organization viewers, a configured owner mismatch, and repositories outside
the authenticated personal account.

Local development may instead use a GitHub CLI OAuth access token. Set
`NODE_ENV=development`, `REPO_CONTROL_GITHUB_AUTH_MODE=oauth`,
`REPO_CONTROL_GITHUB_TOKEN`, and `REPO_CONTROL_GITHUB_OWNER`. OAuth tokens are
rejected in every other runtime mode, including production. A local OAuth token
does not need `REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT`; if supplied, Repo Control
still validates that it is a future UTC timestamp. This path exists only for
local testing and is never included in the production operating contract.

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
