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
