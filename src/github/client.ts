import {
  ConnectionValidationError,
  type GitHubReadClient,
  type GitHubViewer,
  type RepositoryCapability,
} from "./connection.js";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function createGitHubReadClient(token: string, fetch: Fetch = globalThis.fetch): GitHubReadClient {
  return {
    async getViewer() {
      const data = await readGraphQL(fetch, token, "AuthenticatedViewer", VIEWER_QUERY, {});
      return parseViewer(data.viewer);
    },
    async readOwnedRepositoryCapabilities() {
      const repositories: RepositoryCapability[] = [];
      let after: string | null = null;

      do {
        const data = await readGraphQL(
          fetch,
          token,
          "OwnedRepositoryCapabilities",
          REPOSITORIES_QUERY,
          { after },
        );
        const page = parseRepositoryPage(data.viewer);
        repositories.push(...page.repositories);
        after = page.hasNextPage ? page.endCursor : null;
      } while (after !== null);

      return repositories;
    },
  };
}

const VIEWER_QUERY = `query AuthenticatedViewer {
  viewer { __typename id login }
}`;

const REPOSITORIES_QUERY = `query OwnedRepositoryCapabilities($after: String) {
  viewer {
    repositories(first: 100, after: $after, affiliations: OWNER) {
      nodes {
        id
        nameWithOwner
        owner { id login }
        issues(first: 1) { totalCount }
        pullRequests(first: 1) { totalCount }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function readGraphQL(
  fetch: Fetch,
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, string | null>,
) {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operationName, query, variables }),
    });
  } catch {
    throw new ConnectionValidationError("authentication_failed");
  }
  if (!response.ok) {
    throw new ConnectionValidationError("authentication_failed");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  if (!isObject(payload) || payload.errors !== undefined || !isObject(payload.data)) {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  return payload.data as Record<string, unknown>;
}

function parseViewer(value: unknown): GitHubViewer {
  if (!isObject(value) || !isString(value.id) || !isString(value.login)) {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  if (value.__typename !== "User" && value.__typename !== "Organization") {
    throw new ConnectionValidationError("not_personal_account");
  }
  return { id: value.id, login: value.login, type: value.__typename };
}

function parseRepositoryPage(value: unknown) {
  if (!isObject(value) || !isObject(value.repositories)) {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  const repositories = value.repositories;
  if (!Array.isArray(repositories.nodes) || !isObject(repositories.pageInfo)) {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  if (typeof repositories.pageInfo.hasNextPage !== "boolean") {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  const endCursor = repositories.pageInfo.endCursor;
  if (repositories.pageInfo.hasNextPage && !isString(endCursor)) {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  return {
    repositories: repositories.nodes.map(parseRepository),
    hasNextPage: repositories.pageInfo.hasNextPage,
    endCursor: isString(endCursor) ? endCursor : null,
  };
}

function parseRepository(value: unknown): RepositoryCapability {
  if (
    !isObject(value) ||
    !isString(value.id) ||
    !isString(value.nameWithOwner) ||
    !isObject(value.owner) ||
    !isString(value.owner.id) ||
    !isString(value.owner.login) ||
    !isObject(value.issues) ||
    !Number.isInteger(value.issues.totalCount) ||
    !isObject(value.pullRequests) ||
    !Number.isInteger(value.pullRequests.totalCount)
  ) {
    throw new ConnectionValidationError("insufficient_read_access");
  }
  const issueCount = value.issues.totalCount as number;
  const pullRequestCount = value.pullRequests.totalCount as number;
  return {
    id: value.id,
    nameWithOwner: value.nameWithOwner,
    owner: { id: value.owner.id, login: value.owner.login },
    issues: { totalCount: issueCount },
    pullRequests: { totalCount: pullRequestCount },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
