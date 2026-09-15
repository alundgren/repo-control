# PR workflow engine exploration

Status: design proposal, 2026-09-15. The engine and its CLI do not exist yet.
This directory is an iteration packet, not a production workflow installation.

The proposed service watches team pull requests, runs a deterministic decision
loop, and uses Codex CLI or Claude Code for bounded review and repair work. It
can fix and push automatically. People merge in the first version. A daemon
owns scheduling, execution, and recovery. GitHub Actions and GitHub runners are
not dependencies.

## Start here

- [Presentation](presentation.html), a self-contained Repo Control HTML artifact.
  Download it and open it in a browser. It includes architecture diagrams, an
  interactive editor concept, and a fictional PR simulation.
- [Specification](specification.md) defines execution, permissions, memory,
  failure handling, costs, testing, and delivery stages.
- [Architecture](architecture.md) contains the editable Mermaid C4, state, and
  sequence diagrams, plus the Repo Control integration assessment.
- [Contracts](contracts.md) explains the illustrative JSON schemas and examples.
- [Research](research.md) records primary sources, alternatives, and uncertainties.
- [Runtime options](runtime-options.md) covers verified CLI capabilities,
  authentication boundaries, containers, and microVMs.
- [Decisions](decisions.md) separates accepted constraints from recommendations
  and gives the next session a concrete agenda.

## Working files

`examples/team-pr/workflow.json` is the proposed process definition. The files
under its `prompts/` directory are agent instructions. `schemas/` contains JSON
Schema contracts. `examples/results/` contains fictional action results and a
human decision packet. These are a candidate format, not an implemented API.
They belong to this engine and have no relationship to `.github/workflows`.

`presentation.template.html` owns slide copy, interaction code, and design
tokens. `build_presentation.py` embeds the example process, architecture
drawings, IBM Plex fonts, and their licence into `presentation.html`. It makes
no network calls. The output works inside Repo Control's isolated artifact
viewer without a CDN, external assets, browser storage, or a server.

```sh
python3 docs/pr-workflows/build_presentation.py
python3 docs/pr-workflows/validate.py
```

The validator checks the example contracts and cross-file references with the
documented Python JSON Schema dependency, and checks the generated artifact.
See [validation instructions](contracts.md#validation) for an isolated install.
The browser check uses the repository's pinned Playwright dependency:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec node docs/pr-workflows/check-presentation.mjs
```

Browser evidence stays in temporary storage outside the checkout. The mockup
can select actions, edit bounded settings or JSON, validate, simulate a
fictional PR, reset changes, and export its process file. It does not execute
agents, contact GitHub, persist a deployment, or implement graph dragging.

## Continue in another session

1. Read this file, the decisions, and the specification before changing scope.
2. Resolve the next decision with a small experiment or a recorded rationale.
   Preserve the distinction between proposed commands and available tools.
3. Update the process example, contracts, diagrams, and presentation together.
   Rebuild the HTML, run document and browser checks, and inspect laptop and
   narrow layouts. Use fictional data in everything committed.
4. Record changed decisions and experiment results in `decisions.md`. Keep raw
   real-PR evidence, provider credentials, and local account details outside Git.

This proposal does not change the running Repo Control application. Publishing
the HTML to an artifact host is a separate operation from committing it here.
