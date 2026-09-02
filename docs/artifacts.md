# Published HTML artifacts

Repo Control accepts self-contained Archify documents, presentations, and
mockups through its private API. It returns public view and download links for
each upload. The upload endpoints stay inside the Tailnet. Public links provide
bearer access, so publish only non-sensitive material.

## Enablement and rollback

Artifact publishing is disabled by default. Enable it with the HTTPS origin of
a dedicated public hostname:

```sh
REPO_CONTROL_ARTIFACT_PUBLIC_ORIGIN='https://artifacts.example.test'
```

The value must be an HTTPS origin without credentials, a path, a query string,
or a fragment. Repo Control fails startup if the value is invalid. The origin
constructs returned links only. It does not change the listener address or
make the private upload endpoint public.

To roll back, remove `REPO_CONTROL_ARTIFACT_PUBLIC_ORIGIN` and restart Repo
Control. The artifact routes will no longer be registered. Existing rows remain
in `repo-control.sqlite`, but the application cannot publish or serve them
until the setting returns. Scheduled artifact cleanup also stays off while the
module is disabled.

## Publishing contract

The private API has one endpoint for each supported type:

| Type | Upload endpoint |
| --- | --- |
| `archify` | `POST /api/artifacts/archify` |
| `presentation` | `POST /api/artifacts/presentation` |
| `mockup` | `POST /api/artifacts/mockup` |

Every type accepts only `text/html`. The optional charset must be UTF-8, and
the maximum document size is 10 MiB. The service preserves the uploaded bytes
exactly. This fictional example publishes a presentation:

```sh
curl --fail-with-body \
  --request POST \
  --header 'Content-Type: text/html; charset=utf-8' \
  --data-binary '@fictional-presentation.html' \
  'http://repo-control.internal.test:3000/api/artifacts/presentation'
```

A successful request returns `201` and this JSON contract:

```json
{
  "status": "published",
  "id": "abcdefghijklmnopqrstuvwxyzabcdef",
  "type": "presentation",
  "createdAt": "2026-08-31T10:00:00.000Z",
  "deleteAfter": "2026-09-30T10:00:00.000Z",
  "viewUrl": "https://artifacts.example.test/public/abcdefghijklmnopqrstuvwxyzabcdef/view",
  "downloadUrl": "https://artifacts.example.test/public/abcdefghijklmnopqrstuvwxyzabcdef/download"
}
```

Retries are not idempotent. A retry may create another artifact and consume
quota again.

Upload responses use `Cache-Control: no-store`. Rejections return only a safe
error code:

| HTTP status | Error code | Meaning |
| --- | --- | --- |
| `400` | `artifact_empty` | The request contained no document bytes. |
| `413` | `artifact_too_large` | The document exceeded 10 MiB while being read. |
| `415` | `artifact_media_type_unsupported` | The media type or charset was not accepted. |
| `507` | `artifact_quota_exceeded` | The stored payload total would exceed 1 GiB. |

Repo Control keeps at most 1 GiB of artifact payload bytes. A publication first
deletes expired rows, then checks the total and inserts the new row in one
SQLite immediate transaction. A full quota returns `507` with
`artifact_quota_exceeded`. SQLite can reuse pages after deletion, but Repo
Control does not run `VACUUM`, so the database file may stay near its previous
largest size.

## Retention and browser restrictions

Rows become eligible for deletion 30 days after publication. Cleanup runs at
startup, every eight hours, and before each publication. An expired artifact
can still load until one of those cleanup operations deletes it.

Successful public responses are cacheable for 30 days from each response. A
browser or Cloudflare cache may serve a fetched copy after SQLite deletes the
row. Retention limits origin disk use. It does not revoke a link.

HTML view responses run under a restrictive Content Security Policy and a sandbox
without same-origin permission. Inline scripts and styles, data and blob
assets, blob workers, and downloads are allowed. External requests, forms,
objects, nested frames, framing, popups, and cross-context navigation are
blocked. A raw top-level document cannot prevent every possible same-context
navigation. Uploaders remain trusted Tailnet participants, and the no-referrer
policy plus external-resource restrictions limit information leakage.

## Dedicated public hostname

Publish only the two read routes through a dedicated Cloudflare Tunnel
hostname. The exact public route expression is:

```text
^/public/[a-z]{32}/(view|download)$
```

A fictional `cloudflared` ingress file is:

```yaml
tunnel: repo-control-artifacts
credentials-file: /etc/cloudflared/repo-control-artifacts.json
ingress:
  - hostname: artifacts.example.test
    path: ^/public/[a-z]{32}/(view|download)$
    service: http://127.0.0.1:3000
    originRequest:
      httpHostHeader: artifacts.example.test
  - service: http_status:404
```

Tunnel ingress cannot restrict methods. Add a Cloudflare WAF rule that blocks
every request except `GET` on the exact public paths:

```text
(http.host eq "artifacts.example.test" and
 (http.request.method ne "GET" or
  not http.request.uri.path matches "^/public/[a-z]{32}/(view|download)$"))
```

The final `404` ingress rule is required. Do not publish `/api`, `/health`,
`/events`, `/webhooks/github`, or the browser UI through this hostname. The
origin also rejects `HEAD` for both artifact routes.
