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

Test observable behaviour at an agreed public seam. Do not assert private
collaborators, implementation details, or incidental logging.

For each vertical slice, add one focused failing test, run only that source
test file, then make the smallest change that turns it green. Typecheck after
structural or type-signature changes. Run the full suite once after all slices
are complete.

Use the pinned pnpm version through Corepack:

```sh
corepack pnpm test:focused -- src/server/app.test.ts
corepack pnpm typecheck
corepack pnpm test
```

Every test-bearing deliverable must provide the same `test:focused` contract:
it accepts exactly one source test-file path after `--` and runs only that test
program with compact output. The full `test` command runs the suite.
