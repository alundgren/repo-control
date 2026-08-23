# Repo Control

Repo Control is a self-hosted control panel for GitHub pull requests and
issues. It starts read-only, showing the work that needs attention across the
repositories a person connects. Later versions may offer carefully confirmed
actions such as merging a pull request or editing an issue.

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

## Status

This repository currently holds a prototype and planning material. It does not
call GitHub, persist credentials, or mutate GitHub data yet.

## License

[MIT](LICENSE)
