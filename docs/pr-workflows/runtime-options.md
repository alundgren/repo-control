# Runtime options for PR workers

Verified against official documentation on 2026-09-15. Statements labeled **Fact** describe documented behavior. Statements labeled **Recommendation** are design choices for this daemon. CLI flags change, so the adapter must probe the installed version at startup and refuse a run when a required capability is absent. The workflow is the daemon's own process. Its decisions do not depend on GitHub Actions or another hosted runner.

## Provider CLIs

### Codex CLI

**Fact.** OpenAI documents `codex exec` for noninteractive work, JSONL events, JSON Schema constrained final output, saved-login reuse, and session resume in [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). Sandbox mode controls what commands can do; approval policy controls when Codex asks. They are separate controls according to [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).

Representative read-only invocation. This illustrates output and permission
flags; it is not a complete isolation setup:

```sh
codex -a never -s read-only -C "$CHECKOUT" exec \
  --ignore-user-config \
  --json \
  --output-schema "$SCHEMA" \
  -o "$RESULT" \
  "$PROMPT"
```

On versions where `-a` is global, it must precede `exec`. The adapter should derive argument placement from its capability probe. For repair, use a daemon-owned [permission profile](https://learn.chatgpt.com/docs/permissions) that grants writes only to the checkout, denies credential paths and unrelated environment variables, and disables tool egress. A `workspace-write` preset is a fallback only after its effective paths have been verified.

Resume uses `codex exec resume SESSION_ID` or `--last`. The controller must still apply the current schema, permissions, and exact-head binding.

**Fact.** Codex supports local ChatGPT login for subscription access and API-key login for usage billing. OpenAI recommends API keys for programmatic workflows, treats `auth.json` as a password, and warns against exposing Codex execution in public or untrusted environments; see [Codex authentication](https://learn.chatgpt.com/docs/auth). Enterprise access tokens are documented for trusted noninteractive local workflows and private runners.

**Recommendation.** A developer may use their own subscription login for a single-user local pilot. That does not establish permission to turn the login into a team service. Use an organization API account or supported enterprise automation credential for a shared daemon, subject to its plan and administrator policy.

### Claude Code

**Fact.** Anthropic documents `claude -p`, JSON and streaming JSON output, `--json-schema`, fixed tool selection, permission-denial events, and resume in [Run Claude Code programmatically](https://code.claude.com/docs/en/headless). `--allowedTools` preapproves matching tools but does not remove other tools. Combine a fixed `--tools` set with `dontAsk` or explicit deny rules; see [Claude Code permissions](https://code.claude.com/docs/en/permissions).

Representative read-only invocation. This command alone is insufficient for
executing against an untrusted checkout:

```sh
claude -p \
  --output-format json \
  --json-schema "$SCHEMA_JSON" \
  --tools "Read,Glob,Grep" \
  --permission-mode dontAsk \
  --settings "$TRUSTED_SETTINGS" \
  "$PROMPT"
```

Current headless documentation includes `--permission-prompts none` for unattended runs. Older binaries may not expose it. Use it only after the probe confirms support. For repair, add `Edit,Write`; keep Bash unavailable unless an exact daemon-owned wrapper is required. The controller should run configured checks itself.

`--settings` does not by itself disable project configuration discovery. Before
using normal mode against repository content, the adapter must prove that
checkout-provided hooks, MCP configuration, plugins, and executable settings
cannot run. Fail the attempt if the pinned CLI and outer runtime cannot enforce
that restriction. A hostile-checkout fixture must test it before any real-PR
execution. API-backed `--bare` is the simpler candidate for this requirement;
subscription-backed normal mode remains conditional on that experiment.

Resume uses `--resume SESSION_ID`; `--continue` selects the most recent local conversation. Prefer the recorded session ID and reject it when bound inputs differ.

**Fact.** Claude's [sandbox documentation](https://code.claude.com/docs/en/sandboxing) says to set `sandbox.failIfUnavailable=true` when failure to establish the sandbox must stop execution, and `allowUnsandboxedCommands=false` to remove the escape option. Built-in file tools have their own permissions, so Bash sandbox rules alone do not protect credential files. `--bare` avoids project hooks, MCP configuration, memory, and other discovered configuration, but headless documentation says it accepts API-key authentication rather than subscription OAuth.

Anthropic documents subscription login and `claude setup-token` for scripts in [Claude Code for teams](https://code.claude.com/docs/en/team). Its [consumer terms](https://www.anthropic.com/legal/consumer-terms) prohibit credential sharing and automated access except through an API key or another expressly permitted method. Applicable terms depend on account type and jurisdiction.

**Recommendation.** Keep subscription-backed Claude use single-user. Use `--bare` with API authentication for a shared daemon where possible. If a local subscription pilot needs normal mode, run it under a dedicated OS account, load only trusted daemon settings, deny credential paths to both built-in tools and commands, and do not expose unrelated files.

## Network and credential boundaries

**Fact.** The provider client needs outbound network access to the selected model service. That does not require repository tools or tests to have general network access.

**Recommendation.** Treat these as separate egress paths:

1. The provider client reaches only operator-approved provider and authentication endpoints through a controlled route. If the client supports endpoint override, an API deployment can keep the key in a trusted local proxy. Otherwise use an isolated credential store. A subscription CLI may require that store; the provider spike must prove that model-controlled tools cannot read it.
2. Model tool subprocesses have no network by default. Grant narrow package-mirror or documentation domains only when the workflow requires them.
3. Repository checks run in a separate short-lived test sandbox with no provider, GitHub, SSH, daemon, or messaging credentials. Test egress is disabled by default and separately allowlisted when dependency restoration requires it.

A single container network toggle cannot express all three paths. Use separate processes and network namespaces, or an authenticated local proxy plus OS rules that identify the permitted client. Fail closed if the runtime cannot enforce the distinction.

The effect broker runs outside every PR and test sandbox. It alone holds GitHub credentials. The agent submits a candidate artifact; it never runs `git push`, approves, comments, or merges.

## Structured results and evidence

**Fact.** Both CLIs can require a final response that conforms to JSON Schema. This checks fields, types, and enum values. It does not prove that a cited file exists, an excerpt matches the reviewed commit, a test ran, or a repair is correct. Anthropic also notes that JSON Schema `format` is an annotation.

**Recommendation.** Validate paths, line ranges, and excerpts against the exact checkout. Record tests in the controller, including command, tool versions, exit status, and log digest. Bind any resumed session to provider, repository ID, PR number, head SHA, workflow digest, prompt version, schema version, and policy. Start a new conversation if any bound input changes.

## Isolation and reuse

| Runtime | Verified facts | Design inference |
|---|---|---|
| Rootless OCI | Docker runs the daemon and containers without root in a user namespace; see [Rootless mode](https://docs.docker.com/engine/security/rootless/). Containers share the host kernel, as described in [Docker Engine security](https://docs.docker.com/engine/security/). | Suitable for a trusted same-team pilot when the host threat model accepts a shared kernel. |
| gVisor | gVisor provides a userspace application kernel through OCI `runsc`; see [gVisor overview](https://gvisor.dev/docs/). Its [production guide](https://gvisor.dev/docs/user_guide/production/) documents compatibility limits and workload-dependent filesystem and network overhead. | Add when repository trust requires stronger syscall isolation and representative builds and tests pass. |
| Firecracker | Firecracker uses KVM microVMs. Its [design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) requires host network controls and recommends the jailer. | Use when public or multi-tenant execution justifies guest-kernel isolation and extra image, networking, storage, and operations work. |

Pre-pull immutable runtime images and cache Git objects and dependencies by trust scope and content digest. A stricter deployment can use a fresh writable overlay for every attempt. The baseline may reuse a validated warm sandbox only for the same repository, PR generation, head, workflow digest, provider identity, policy, and trust level. Reobserve a pushed head and perform an explicit workspace transition before reuse. Never reuse credential-bearing test state across PRs.

gVisor supports [checkpoint and restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/), with limitations in some [rootless configurations](https://gvisor.dev/docs/user_guide/rootless/). Firecracker [snapshots](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md) can duplicate identifiers, random state, connections, and application-held tokens. Create reusable snapshots before credentials, repository data, sessions, or network connections enter the environment.

Do not adopt vendor startup figures as daemon targets. Benchmark cold and warm setup, checkout, authentication, model time, representative tests, cleanup, peak memory, and total latency on the intended host.

## Repair and push checkpoint

**Recommendation.** Before the broker pushes, it must:

1. Re-read and match repository ID, PR number, head repository, head ref, and observed head SHA.
2. Accept only configured same-repository PR refs in the pilot; reject forks, tags, base/default branches, deletions, and history-rewriting updates.
3. Validate path policy, symlinks, submodules, file and byte limits, secret handling, and conflicts. Finalize an immutable candidate commit before tests. Preserve both required parents when conflict repair merges the base. Run required controller checks on that exact commit and store its SHA with the receipts.
4. Record expected old SHA, candidate SHA, target ref, and logical effect key before dispatch. Independently verify that the expected old head is an ancestor of the candidate. Mint a short-lived GitHub App installation token only for the push.
5. Use a transport that atomically compares the remote ref with the captured expected-old SHA. Push the identical tested commit. Never recreate it on retry. If the outcome is unknown, read the remote ref and reconcile it with the old and candidate SHAs.

GitHub documents that [updating a reference](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#update-a-reference) with an installation token requires repository `Contents` write permission. This REST permission reference does not establish an atomic expected-old precondition. A concrete Git transport option is the fully specified `--force-with-lease=<ref>:<expected-old>` form in [Git's push documentation](https://git-scm.com/docs/git-push). The broker must separately reject every non-fast-forward candidate, because the option alone can permit history rewriting. Never use an implicit lease based on a mutable tracking ref. The implementation spike must verify this behavior against the chosen GitHub transport.

`Contents` write covers more than one ref. Broker target checks and repository
branch rules are independent safeguards. The daemon exposes no merge operation.
A person merges.

## Pilot sequence

**Recommendation.** Start with fictional local repositories. Next, run read-only shadow reviews of allowlisted real PRs at an exact head without comments or pushes. Then permit local repairs and separate sandboxed tests but discard the candidate. Finally, enable the broker for one allowlisted same-repository PR and have a person inspect and merge its commit. A push may trigger automation already configured by that repository, but the daemon neither invokes nor waits for it.
