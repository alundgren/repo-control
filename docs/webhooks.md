# GitHub webhook operations

Repo Control accepts GitHub deliveries at one receiver: `POST
/webhooks/github`. The receiver reads at most 256 KiB, checks
`X-Hub-Signature-256` with `REPO_CONTROL_GITHUB_WEBHOOK_SECRET`, then parses
and stores only the delivery ID, event name, action, node ID, repository node
ID, item type, and number. It never logs the request body or secret.

Set the secret in the host environment before starting the server:

```sh
REPO_CONTROL_GITHUB_WEBHOOK_SECRET='a-long-random-value'
```

If the variable is missing, the server does not register the webhook route.
Manual sync, focused refresh, cached reads, and the private UI remain
available.

## Automatic receiver provisioning

Provisioning is opt-in. In addition to the receiver secret, set an absolute
HTTPS callback URL with exactly the `/webhooks/github` path and no credentials,
query string, or fragment:

```sh
REPO_CONTROL_GITHUB_WEBHOOK_CALLBACK_URL='https://hooks.example.com/webhooks/github'
```

On each explicit account sync, Repo Control fully inventories personal-account
repositories, then considers only active, non-fork repositories without a
terminal provisioning result. It pages their hooks looking only for an exact
callback URL. An exact match is left entirely untouched and recorded as
`already_present`; when absent, Repo Control creates one active JSON webhook
for the `issues` and `pull_request` events and records `created`.

Repo Control never updates, disables, deletes, repairs, or rotates a webhook,
even when an existing matching hook is inactive, has the wrong events, or uses
an old secret. Change the callback or secret manually in GitHub, then remove or
manage the affected webhook there. A failed hook read or creation records no
terminal result, so the next successful explicit sync retries safely. The PAT
needs **Webhooks: Read and write** in addition to the read permissions.

The webhook route acknowledges a valid new or duplicate delivery with `202`
only after its SQLite ledger transaction commits. A worker then claims pending
rows, refreshes cached items, and upserts opened, reopened, or transferred-in
items after GitHub confirms that the item is open and belongs to the connected
personal account. Failed work is marked for manual reconciliation. Pending
and interrupted processing rows resume after restart. Terminal ledger rows are
retained for 30 days and pruned after that period.

## Cloudflare Tunnel boundary

Expose a dedicated hostname and exact path. Keep the application origin on a
private address or Tailnet, and do not publish the browser, API, health, or
SSE paths through the tunnel. A minimal `cloudflared` ingress file looks like
this. Replace the example hostname with the operator's chosen hostname in
both Cloudflare DNS and this file.

```yaml
tunnel: repo-control-webhook
credentials-file: /etc/cloudflared/repo-control-webhook.json
ingress:
  - hostname: hooks.example.com
    path: ^/webhooks/github$
    service: http://127.0.0.1:3000
    originRequest:
      httpHostHeader: hooks.example.com
  - service: http_status:404
```

The catch-all rule is intentional. The origin also accepts only `POST` for
the receiver, while GitHub's webhook configuration should select only the
issue and pull-request events required by this release. Do not add a second
public ingress rule for `/api`, `/events`, `/`, or `/health`.

Tunnel ingress matches host and path, not HTTP methods. Add a Cloudflare WAF
custom rule on `hooks.example.com` that blocks every request except `POST` to
the exact receiver path. In expression form, the deny rule is:

```text
(http.host eq "hooks.example.com" and
 (http.request.method ne "POST" or http.request.uri.path ne "/webhooks/github"))
```

The origin route remains POST-only, so a mistake in the edge rule still fails
closed at the application.

## Supported deliveries and recovery

The worker handles issue changes and pull-request changes, including edits,
labels, assignments, milestones, transfers, state changes, and pull-request
commit updates (`synchronize`). A cached item emits an item-scoped event only
after its cache write or removal succeeds. Closed issues, closed pull requests,
merged pull requests, and repositories outside the connected account are
normal removal outcomes.

The browser uses `GET /events` over SSE. It buffers events while it silently
reconciles the overview after a reconnect, then applies them in order. A
temporary stream failure does not clear the loaded view or disable `Sync
account` and `Refresh this item`. If a delivery is marked for manual
reconciliation, use one of those explicit controls after checking the GitHub
item. There is no background polling.
