# AI file priorities

AI priority is an optional review aspect inside **Review changed files**. It
starts with tier 5 files and gives each file a short reason. The tier controls
filter both the file navigator and the existing diff. Line comments and review
submission work across all aspects. Classification never submits a review.

## Server setup

Set both variables in the server environment, then restart Repo Control:

```text
REPO_CONTROL_PRIORITY_ENDPOINT=https://classification.agents.do-ai.run/api/v1/chat/completions?agent=true
REPO_CONTROL_PRIORITY_API_KEY=<agent access key>
```

Replace `classification` with the hostname of your DigitalOcean agent. Configure
that agent to use **GLM-5.3 Flash** with no tools, routing, retrieval, or other
attached agents. DigitalOcean agent endpoints use the agent's configured model
and can ignore the request's model field. Repo Control requires the response to
identify `glm-5.3-flash` before accepting it. Use an agent access key for an
agent endpoint. See the [agent API reference](https://docs.digitalocean.com/reference/api/reference/agent-inference/).

Alternatively, use `https://inference.do-ai.run/v1/chat/completions` with a
DigitalOcean serverless model access key. This endpoint selects the requested
model directly. See the [serverless API reference](https://docs.digitalocean.com/products/inference/reference/api/serverless-inference/).

Every request is one `POST` with Bearer authentication and these fixed fields:

```json
{
  "model": "glm-5.3-flash",
  "reasoning_effort": "high",
  "stream": false,
  "n": 1,
  "tool_choice": "none",
  "max_completion_tokens": 65536
}
```

DigitalOcean documents [high reasoning effort](https://docs.digitalocean.com/products/inference/how-to/use-reasoning/)
and [GLM-5.3 Flash support](https://www.digitalocean.com/community/conceptual-articles/glm-5-3-flash-cost-per-token).
Repo Control sends no tool definitions and refuses tool calls, incomplete
responses, invalid file coverage, or reasons over ten words. It makes no repair
request and uses no SDK retry loop. Requests have a 120-second deadline,
redirects are rejected, request bodies are capped at 1 MiB, and response bodies
at 2 MiB. Only the documented HTTPS DigitalOcean hostnames and paths are accepted.

Omit both variables to keep the integration inactive. Partial or invalid
configuration prevents startup with a redacted setup message. Keys stay on the
server and are never included in the browser API. This setup does not configure
or deploy a DigitalOcean agent for you.

## Data sent

When enabled, eligible monitored PR content is sent to DigitalOcean, including
private repositories visible to the connected account. Each request contains
the PR title, up to 32 KiB of its description, the head revision, the complete
changed-path list and change metadata, and available patches. Patches are capped
at 16 KiB per file and 256 KiB total, divided equally among available patches
so later files retain evidence even when earlier patches are large.
One root `AGENTS.md` at the reviewed head
provides optional repository policy context, with a 16 KiB limit. No recursive
policy lookup or source-tree upload occurs. Oversized policy files are omitted.

PR text, policies, paths, and patches are untrusted evidence. A separate system
instruction defines the rubric and required output. The server validates every
returned path, tier, and reason. Missing or truncated evidence is recorded in
Details. If GitHub cannot supply the complete changed-file identity list, the
try fails without requesting classification. GitHub's existing diff API retains
its 3,000-file and 5 MiB patch bounds.

## Monitoring and durable state

While configured, Repo Control runs the existing account reconciliation on
startup and every five minutes. Sync remains single-flight. Successful full or
partial syncs, focused refreshes, and webhook updates discover open, non-draft
PRs from visible repositories. Webhooks remain optional. Hiding a repository
stops its classification work. Manual sync behavior remains available.

The SQLite `pull_request_priorities` table in `DATA_DIRECTORY/repo-control.sqlite`
keeps one lifetime job per GitHub PR node ID. It retains the original enqueue
time, attempts, last observed readiness, and validated result across cache
generations and restarts. A single worker processes one job at a time. Results
and attempt records are retained so rediscovery cannot reset the limit.

Each of at most two processing tries is reserved durably before GitHub reads.
Preparation failures and interrupted tries spend their reservation even if no
model request was sent. One failed try queues a final try after one minute.
Every pickup, including retry and restart recovery, skips jobs more than 24
hours past their original enqueue time. A pickup at exactly 24 hours is allowed.
Draft transitions and rediscovery never reset that time or the attempt count.

The worker checks current draft/state/head before inference and again before
accepting its result. A changed head during work discards the result and may
use the remaining try. A completed result that later becomes stale is hidden
and is not classified again. Completion uses the reserved attempt number so a
late response cannot overwrite a recovered try. The priority view checks
current GitHub state when opened and every 15 seconds while visible. If that
check is unavailable, scores are hidden until current state can be checked.

Queued, running, final retry, failure, expiry, ineligibility, stale, and disabled
states provide **Review all files**. There is no manual retry control that can
exceed the lifetime limit.

## Interactive exploration

The configured connection also enables Ask agent in the PR review. Interactive
conversations use a separate service and bounded requests; they do not change
classification jobs or their retries. A question can send requested unchanged
source as well as patch excerpts. The initial conversation screen discloses that
scope. See [PR exploration](pr-exploration.md) for its protocol, limits and UI.
