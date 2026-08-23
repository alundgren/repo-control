import type { GitHubReadClient, GitHubViewer, RepositoryCapability } from "./read-client.js";

export type ConnectionConfiguration = {
  authentication: "pat" | "oauth";
  token: string;
  expectedOwner: string;
  expiresAt: Date | null;
};

export type { GitHubReadClient, GitHubViewer, RepositoryCapability } from "./read-client.js";

export type GitHubConnectionClient = Pick<
  GitHubReadClient,
  "getViewer" | "readOwnedRepositoryCapabilities"
>;

export type ConnectionValidationCode =
  | "missing_token"
  | "invalid_authentication_mode"
  | "oauth_not_local"
  | "invalid_token"
  | "missing_owner"
  | "invalid_expiry"
  | "expired_token"
  | "authentication_failed"
  | "not_personal_account"
  | "unexpected_owner"
  | "unexpected_repository_owner"
  | "insufficient_read_access";

export class ConnectionValidationError extends Error {
  constructor(readonly code: ConnectionValidationCode) {
    super(messageFor(code));
    this.name = "ConnectionValidationError";
  }
}

export function readConnectionConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  now = new Date(),
): ConnectionConfiguration {
  const token = environment.REPO_CONTROL_GITHUB_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new ConnectionValidationError("missing_token");
  }

  const authentication = readAuthenticationMode(environment);
  if (authentication === "oauth" && environment.NODE_ENV !== "development") {
    throw new ConnectionValidationError("oauth_not_local");
  }
  const tokenPattern = authentication === "pat"
    ? /^github_pat_[A-Za-z0-9_]{8,}$/
    : /^gho_[A-Za-z0-9]{8,}$/;
  if (!tokenPattern.test(token)) {
    throw new ConnectionValidationError("invalid_token");
  }

  const expectedOwner = environment.REPO_CONTROL_GITHUB_OWNER?.trim();
  if (expectedOwner === undefined || expectedOwner === "") {
    throw new ConnectionValidationError("missing_owner");
  }

  const expiresAt = readExpiry(environment, authentication, now);

  return { authentication, token, expectedOwner, expiresAt };
}

function readAuthenticationMode(
  environment: Readonly<Record<string, string | undefined>>,
): ConnectionConfiguration["authentication"] {
  const configuredMode = environment.REPO_CONTROL_GITHUB_AUTH_MODE ?? "pat";
  if (configuredMode === "pat" || configuredMode === "oauth") return configuredMode;
  throw new ConnectionValidationError("invalid_authentication_mode");
}

function readExpiry(
  environment: Readonly<Record<string, string | undefined>>,
  authentication: ConnectionConfiguration["authentication"],
  now: Date,
): Date | null {
  const expiry = environment.REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT;
  if (authentication === "oauth" && (expiry === undefined || expiry.trim() === "")) {
    return null;
  }
  if (
    expiry === undefined ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)
  ) {
    throw new ConnectionValidationError("invalid_expiry");
  }
  const expiresAt = new Date(expiry);
  if (Number.isNaN(expiresAt.valueOf())) {
    throw new ConnectionValidationError("invalid_expiry");
  }
  const canonicalExpiry = expiresAt.toISOString();
  if (
    (expiry !== canonicalExpiry && expiry !== canonicalExpiry.replace(".000Z", "Z"))
  ) {
    throw new ConnectionValidationError("invalid_expiry");
  }
  if (expiresAt <= now) {
    throw new ConnectionValidationError("expired_token");
  }
  return expiresAt;
}

export async function validateConnection(
  configuration: ConnectionConfiguration,
  github: GitHubConnectionClient,
) {
  let viewer: GitHubViewer;
  let repositories: RepositoryCapability[];

  try {
    viewer = await github.getViewer();
    repositories = await github.readOwnedRepositoryCapabilities();
  } catch (error) {
    if (error instanceof ConnectionValidationError) {
      throw error;
    }
    throw new ConnectionValidationError("authentication_failed");
  }

  if (viewer.type !== "User") {
    throw new ConnectionValidationError("not_personal_account");
  }
  if (viewer.login !== configuration.expectedOwner) {
    throw new ConnectionValidationError("unexpected_owner");
  }
  if (repositories.length === 0) {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  for (const repository of repositories) {
    if (repository.owner.id !== viewer.id || repository.owner.login !== viewer.login) {
      throw new ConnectionValidationError("unexpected_repository_owner");
    }
    if (!Number.isInteger(repository.issues.totalCount) || !Number.isInteger(repository.pullRequests.totalCount)) {
      throw new ConnectionValidationError("insufficient_read_access");
    }
  }

  return { id: viewer.id, login: viewer.login };
}

function messageFor(code: ConnectionValidationCode) {
  const messages: Record<ConnectionValidationCode, string> = {
    missing_token: "GitHub connection configuration is missing REPO_CONTROL_GITHUB_TOKEN.",
    invalid_authentication_mode: "GitHub connection configuration requires REPO_CONTROL_GITHUB_AUTH_MODE to be pat or oauth.",
    oauth_not_local: "GitHub OAuth authentication is available only when NODE_ENV is development.",
    invalid_token: "GitHub connection configuration does not match the selected GitHub authentication mode.",
    missing_owner: "GitHub connection configuration is missing REPO_CONTROL_GITHUB_OWNER.",
    invalid_expiry: "GitHub connection configuration requires a valid REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT timestamp.",
    expired_token: "GitHub connection configuration has an expired GitHub token.",
    authentication_failed: "GitHub rejected the connection or did not return the required read data.",
    not_personal_account: "GitHub connection must authenticate a personal account.",
    unexpected_owner: "GitHub connection does not match REPO_CONTROL_GITHUB_OWNER.",
    unexpected_repository_owner: "GitHub returned a repository outside the authenticated personal account.",
    insufficient_read_access: "GitHub connection lacks the required read fields.",
  };
  return messages[code];
}
