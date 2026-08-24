# Review plans

Repo Control should help a person decide what to inspect in a pull request. A
review plan splits one pull request into a few small sections, each with a
plain description, review cues, and anchors into the changed files. It gives
guidance, not a verdict.

## The pieces

- [The prototype](../prototype/index.html) tests the review UI. The quick read
  opens a full-screen story or file-first view. A file can stay in the app for
  diff, before, and after reading. Merge is the one future mutation here.
- [The schema](../prototype/pr-layer-preview.schema.json) defines the
  machine-readable review plan.
- [The example](../prototype/pr-layer-preview.example.json) is fictional
  sample data for the schema and prototype.

## Intended flow

The implementation skill creates a pull request, writes a review plan that
matches the schema, and posts that JSON with the pull request. Repo Control
reads the current pull-request data and the posted JSON together. It uses the
plan for grouping and guidance, and GitHub for the current diff and commit
SHA. If the SHA no longer matches, the UI warns that the plan is stale.

For now, actions other than merging stay on GitHub. The review UI should link
there rather than copy those workflows.

## How we will improve it

A separate session will inspect old pull requests with the person who reviewed
them. For each one, record what mattered, what did not, and how they would
have split the work into sections. Use that evidence to revise the
implementation guidance and this schema before treating the generated plans
as trustworthy.
