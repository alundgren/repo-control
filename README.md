# Repo Control

Repo Control is a self-hosted control panel for GitHub pull requests and
issues. It starts read-only, showing the work that needs attention across the
repositories owned by the authenticated personal account. Later versions may
offer carefully confirmed actions such as merging a pull request or editing an
issue.

The app is intended to be useful for one person, but it does not depend on a
particular GitHub account or repository. Anyone can run their own copy.

## Start here

- Open [the prototype](prototype/index.html) in a browser. It has fictional
  data and needs no server or GitHub token.
- Read the [product brief](docs/product-brief.md) for the version-one scope.
- Read the [technical foundation](docs/architecture.md) before adding an app
  framework or authentication.
- [Decisions](docs/decisions.md) records the choices that shaped the
  prototype.

## Current status

This repository now includes the first application shell. It does not call
GitHub, persist credentials, or mutate GitHub data yet.

## Version-one operating contract

The first deployed release is a private, Tailnet-restricted service. It reads
only repositories whose owner is the authenticated personal account;
organization-owned repositories stay out of scope even when the token could
read them.

Create a fine-grained personal access token with read permissions for
**Metadata**, **Issues**, and **Pull requests**. The host, not the application,
manages the secret: Piploy's daemon injects it as
`${hostEnv:REPO_CONTROL_GITHUB_TOKEN}` when the application container starts.
The server alone reads that environment variable; browser code, SQLite, logs,
and responses never receive the token.

The deployment keeps its persistent SQLite cache on a private host-managed
volume. Expose the application only through the Tailnet, not the public
internet. The cache contains only the lean, view-serving facts described in
the [technical foundation](docs/architecture.md); it is private operational
data, not an export or archive.

Personal access tokens expire, can be revoked, and must be rotated. To rotate
one, update the Piploy daemon environment, restart the daemon, then recreate
the application container. A revoked or expired token has the same recovery
path after replacing it with a newly created token.

## Run the shell

Use Node 24 and pnpm 11. Corepack can provide the pinned pnpm version:

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm start
```

The server listens on port 3000 by default. Set `PORT` to choose another port.

Use `corepack pnpm lint` for linting. During a focused red-green loop, run one
source test file with:

```sh
corepack pnpm test:focused -- src/server/app.test.ts
```

Run `corepack pnpm test` for the full test suite.

## License

[MIT](LICENSE)
