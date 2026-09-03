# Repo Control guidance

## Public repository

This repository is public. Treat information about the account owner and any
private repository as private, even when it appears in local GitHub data.

Do not put private information in code, fixtures, tests, documentation, issue
or pull-request text, commit messages, review comments, screenshots, logs, or
generated files. This includes repository names, issue and pull-request titles
or bodies, branch names, file paths, account details, machine details,
credentials, tokens, and work history.

Use fictional fixtures in committed examples. When development needs real
GitHub data, keep it local, do not commit responses or exports, and redact it
before sharing it in any public GitHub discussion.

Before creating a public commit, issue, pull request, or comment, check the
changed text for private account or repository information. If the boundary is
unclear, ask before publishing.

## Product direction

Repo Control is account-neutral and self-hosted. Do not hard-code an account
owner, repository list, or personal workflow into production code.

## UX and design-system guidance

The shared `ux-design` guidance defines the visual system. [`docs/ux.md`](docs/ux.md)
records this application's task, chosen roles, components, and intentional
deviations. Keep it current when a UI change adds a visual role or component.

Use semantic design tokens in the implementation. The token technology may
change, but it must bind the roles in `docs/ux.md` rather than reintroducing
literal presentation values in component styles. Self-host the documented
fonts and keep their licence with the assets.

## Testing

Test externally observable behaviour through stable public interfaces. Tests
should fail when important behaviour regresses. Do not assert private
collaborators, implementation order, or incidental logging.

Add or update tests when a change introduces behaviour, changes a contract, or
fixes a bug that existing tests do not cover. Choose the implementation and
test-writing order that is most efficient for the task.

Run the tests and static checks relevant to the changed code. Expand validation
when the change affects shared infrastructure, crosses module boundaries, or
has a high cost of failure. Run the full suite when focused checks do not give
enough confidence. Report any relevant check that was skipped or failed and
explain why.

Use the pinned pnpm version through Corepack. For a focused test:

```sh
corepack pnpm test:focused -- src/server/app.test.ts
```

`test:focused` accepts exactly one source test-file path after `--` and runs
only that test program with compact output. Use the repository scripts for
typechecking and the full suite when those checks are warranted.
