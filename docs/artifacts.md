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
  --header 'X-Artifact-Appearance: light' \
  --header 'X-Artifact-Share-Position: right-center' \
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

`X-Artifact-Appearance` is optional on every upload endpoint. Its exact value
may be `light` or `dark`. Omit it when the artifact has mixed or unknown
appearance. Any other present value, including an empty value, surrounding
whitespace, different casing, comma-joined values, or a repeated header,
returns `400` before publication. The response does not echo the hint.

`X-Artifact-Share-Position` is also optional on every upload endpoint. Its
exact value may be `bottom-right`, `right-center`, `top-right`, `bottom-left`,
`left-center`, or `top-left`. A publisher should try them in that order and
use the first position known not to cover navigation or important content.
Omitting the header uses `bottom-right`. Empty, whitespace-padded,
differently cased, comma-joined, repeated, and unsupported values return
`400` before publication. The response does not echo the hint. The metadata
contract remains optional so a future artifact viewer can ignore it when the
position does not apply.

Upload responses use `Cache-Control: no-store`. Rejections return only a safe
error code:

| HTTP status | Error code | Meaning |
| --- | --- | --- |
| `400` | `artifact_empty` | The request contained no document bytes. |
| `400` | `artifact_appearance_invalid` | The optional appearance header was present but was not exactly `light` or `dark`. |
| `400` | `artifact_share_position_invalid` | The optional Share position header was present but was not one exact supported value. |
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

`GET /public/:id/view` returns a self-contained viewer rather than the uploaded
HTML as the top-level document. The viewer embeds the stored bytes as base64,
decodes them with `atob` into a `Uint8Array`, creates an HTML `Blob`, and loads
its object URL in a full-window iframe. It does not parse, rewrite, inspect, or
inject markup into the artifact. The object URL stays live until the viewer is
closed, so delayed scripts, blob workers, and other later behavior continue to
work. Download responses remain the original byte sequence.

Base64 expands a 10 MiB artifact to at most 13,981,016 bytes. The viewer code
and markup are limited to another 131,072 bytes, making the maximum response
14,112,088 bytes, about 13.46 MiB. During reconstruction, the app may hold the
base64 text and decoded binary string at two bytes per code unit, plus the
10 MiB typed array and a 10 MiB Blob backing allocation. That conservative
peak is 69,905,072 bytes, about 66.67 MiB, before browser networking, the
parsed artifact DOM, media decoding, or engine bookkeeping. The viewer clears
the embedded text after decoding. The Blob remains for the viewer lifetime.

The viewer and blob document use the same restrictive Content Security Policy.
It allows inline scripts and styles, data and blob assets, blob workers, media,
downloads, the artifact's blob iframe, and blob subframes. Blob subframes are
newly allowed because `frame-src blob:` is also required to load the artifact
itself. They inherit the artifact iframe's sandbox and request restrictions.
The iframe sandbox omits same-origin permission and allows only scripts and
downloads. External connections and network-loaded frames, forms, objects,
popups, parent access, and top-level navigation remain blocked. The viewer
response uses `X-Frame-Options: DENY`; omitting `frame-ancestors` from the
inherited CSP is necessary so WebKit can load the sandboxed blob iframe and its
blob children.

The 28 by 28 pixel collapsed Share button contains a centered 16 pixel
connected-nodes icon with the accessible name `Share artifact`. Its background
and border are transparent. The icon uses the same 58% light or dark aware
Share color as the earlier text control. The button sits 8 pixels inside its
selected viewport edge. The panel opens toward the viewport interior and
stays at least 8 pixels from every viewport edge. On short viewports it uses
the available height and scrolls its own contents without adding viewer-page
scrollbars or changing the artifact iframe.

The Share panel copies and encodes the exact canonical `/view` URL and links to
the existing `/download` URL. QR generation and interaction code are carried
inside the response and make no runtime request. If the Clipboard API rejects
the copy, the panel selects the canonical URL for manual copying and does not
report success.

The optional appearance hint changes only the collapsed Share icon. Neutral
and light use `rgba(96, 73, 57, 0.58)`, and dark uses
`rgba(193, 175, 154, 0.58)`. The collapsed button has no fill, visible border,
or halo. The expanded panel and QR code do not change. The server does not
inspect document pixels, markup, scripts, styles, or type to choose a
treatment or position, and it does not expose artifact CSS to the viewer.

SQLite stores the appearance and Share position hints in nullable columns.
Rows created before the columns were added, and uploads without their headers,
read as neutral and `bottom-right`. Both migrations are additive, so an
earlier application can still read and insert rows after a rollback. Removing
the headers restores those defaults for later uploads. The migration does not
alter uploaded or downloaded bytes.

Previously cached immutable `/view` responses may retain the earlier Share
control until their 30-day cache entry expires. An older binary ignores the
nullable position column after rollback. No reverse migration is required.

Install the browser binaries used by the local Playwright suite through the
pinned package manager:

```sh
corepack pnpm browser:install
```

`corepack pnpm test:focused -- src/artifact/viewer.browser.test.ts` runs that
browser file alone in Chromium and WebKit. The full `corepack pnpm test`
command runs both the Vitest suite and browser tests.

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
