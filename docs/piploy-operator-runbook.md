# Piploy operator runbook

## Production registration is blocked

Do not register or poll Repo Control yet. Piploy's public registration guide
says every `EnvironmentVariables` value is literal. Its current README
documents one exception: a whole value in the form `${hostEnv:NAME}`. This
runbook needs that exception for `REPO_CONTROL_GITHUB_TOKEN`.

Treat the public registration guide as authoritative. Continue only after that
guide accepts the host reference, or after the operator records an explicit
operational override. Until then, review the payload below only. Do not submit
it.

The application reads `REPO_CONTROL_GITHUB_TOKEN`, not `GITHUB_TOKEN`. Do not
use `GITHUB_TOKEN=${hostEnv:REPO_CONTROL_GITHUB_TOKEN}` as the container
variable. The required container entry is
`REPO_CONTROL_GITHUB_TOKEN=${hostEnv:REPO_CONTROL_GITHUB_TOKEN}`.

## Dry-review payload

This example contains no production topology or secret value. A host reference
must be the whole value. Keep every non-secret key visible during review.

```json
{
  "Name": "repo-control",
  "GitRepositoryUrl": "https://github.com/example/repo-control.git",
  "DockerfilePath": "Dockerfile",
  "PortMappings": ["8080:3000"],
  "Volumes": ["repo-control-data:/var/lib/repo-control"],
  "EnvironmentVariables": {
    "NODE_ENV": "production",
    "HOST": "0.0.0.0",
    "PORT": "3000",
    "DATA_DIRECTORY": "/var/lib/repo-control",
    "REPO_CONTROL_GITHUB_TOKEN": "${hostEnv:REPO_CONTROL_GITHUB_TOKEN}",
    "REPO_CONTROL_GITHUB_OWNER": "account-login",
    "REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT": "2030-01-01T00:00:00.000Z"
  }
}
```

The one named volume is the SQLite cache. The application creates
`repo-control.sqlite` under `DATA_DIRECTORY`. Do not add a Dockerfile `VOLUME`
instruction, since it can hide an accidental anonymous volume during local
replacement checks.

Reviewing this payload does not approve `register` or `poll`.

## Prepare the host

Create a fine-grained personal access token for the personal account. Select
all repositories under that account and grant read-only Metadata, Issues, and
Pull requests access. Put its value in the Piploy daemon environment as
`REPO_CONTROL_GITHUB_TOKEN`. Set the owner and the token's actual GitHub
expiry as a future UTC ISO 8601 value in the other two variables shown above.

Do not put the token in JSON, CLI arguments, shell history, build arguments,
image layers, source, documentation, or diagnostics. The container gets the
value only when the daemon creates it. Repo Control does not return the token,
write it to SQLite, or log it. It writes only structured, allow-listed
operational events to stdout and omits raw GitHub payloads and request bodies.
Piploy returns application output without further redaction, so treat the logs
as sensitive anyway.

## Before registration

Complete all of these checks before asking for production approval.

- Choose a host port that is absent from Piploy `status` and from the host's
  listeners. A free Piploy mapping alone does not prove the port is free.
- Confirm the host firewall denies the selected port from non-Tailnet sources.
- Confirm Tailnet ACLs allow only the intended identities to reach it.
- When the host's operating procedure allows it, bind a short-lived harmless
  listener to the same host address, interface, and port planned for the
  mapping. It must accept no sensitive input. Confirm one allowed Tailnet
  client can connect and an unauthorized source cannot, then remove the
  listener before registration.

The temporary listener tests the pre-registration policy path only. It does
not test Docker or Piploy forwarding. If a listener is not allowed, record the
firewall and ACL inspection as pre-registration evidence, not as proof of
reachability. In either case, after a later approved deployment, test the real
Repo Control mapping from one allowed Tailnet client and one unauthorized
source. Stop or disable the deployment if either result is wrong.

Record the pass results without publishing hostnames, addresses, ACL contents,
or token values.

## After the contract is reconciled

Registration and polling remain outside this issue. After the gate above is
cleared, use the public workflow:

```text
status -> approval -> register -> approval -> poll -> status
```

Ask for separate explicit approval before `register` and before `poll`. A
payload review is not either approval.

## Rotate, revoke, or replace an expired token

Use the same recovery procedure for rotation, revocation, and expiry:

1. Create a replacement token with the required scope.
2. Replace `REPO_CONTROL_GITHUB_TOKEN` in the Piploy daemon environment.
3. Restart the daemon.
4. Recreate the Repo Control container.
5. Confirm the application reports current and running status.

A daemon restart alone does not update an existing container. Revoke the old
token in GitHub after the replacement is working.

## Diagnose failures

| Symptom | Next action |
| --- | --- |
| Image build fails | Check that the Dockerfile still uses the approved digest-pinned Docker Official image and that its root build context contains every copied file. |
| Container exits at startup | Distinguish a missing or invalid token, owner mismatch, expired token, and insufficient read access from the fixed startup message. Then inspect only the necessary recent log lines, since logs can contain private operational identifiers. |
| SQLite state disappears | Confirm the container mounts `repo-control-data` at `/var/lib/repo-control` and that `DATA_DIRECTORY` has the same path. |
| New token has no effect | Confirm the daemon restarted and the container was recreated after its environment changed. |
| Host reference stays literal | Stop. Reconcile the public guide or record the explicit operational override before registration. |

Repo Control writes logs only to stdout. Piploy and Docker own the retention
and storage of that output, so verify the host's container log rotation and
disk alerting before release. The application does not rotate or persist its
own logs.

## Verify the local artifact

Run this from the repository root:

```sh
corepack pnpm verify:container
```

It builds the image, verifies that the final image excludes source, docs, local
environment files, and the test token sentinel, then creates a temporary named
volume. It writes a harmless SQLite row, removes that temporary container, and
reads the row from a replacement container using the same volume. The check
deletes its test image and volume. It does not start the application, contact
GitHub, validate host references, or prove production readiness.
