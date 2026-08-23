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

Read the [Piploy operator runbook](docs/piploy-operator-runbook.md) before
registering a deployment. It owns the payload, access checks, token lifecycle,
and local container verification. Production registration is currently blocked
until Piploy's public host-environment contract is reconciled.

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
