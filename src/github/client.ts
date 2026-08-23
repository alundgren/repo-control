import {
  ConnectionValidationError,
} from "./connection.js";
import {
  BODY_EXCERPT_LIMIT,
  LABEL_LIMIT,
  RELATIONSHIP_LIMIT,
  SNAPSHOT_ITEMS_PER_TYPE_PER_REPOSITORY,
  SNAPSHOT_ITEM_LIMIT,
  SNAPSHOT_REPOSITORY_LIMIT,
  type AccountSnapshot,
  type AccountSnapshotRead,
  type FocusedItemRead,
  type GitHubRateLimit,
  type GitHubReadClient,
  type GitHubReadError,
  type GitHubRepository,
  type GitHubViewer,
  type GitHubWorkItem,
  type RelationshipCoverageByType,
  type RelationshipType,
  type RepositoryCapability,
  type SnapshotPartialReason,
} from "./read-client.js";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function createGitHubReadClient(token: string, fetch: Fetch = globalThis.fetch): GitHubReadClient {
  return {
    async getViewer() {
      const data = await readGraphQL(fetch, token, "AuthenticatedViewer", VIEWER_QUERY, {});
      return parseViewer(data.viewer);
    },
    async readOwnedRepositoryCapabilities() {
      const data = await readGraphQL(fetch, token, "OwnedRepositoryCapabilities", REPOSITORIES_QUERY, {});
      return parseRepositoryPage(data.viewer).repositories;
    },
    async readAccountSnapshot(): Promise<AccountSnapshotRead> {
      try {
        const data = await readWorkGraphQL(fetch, token, "BoundedAccountSnapshot", SNAPSHOT_QUERY, {});
        return parseAccountSnapshot(data);
      } catch (error) {
        return unavailableRead(error);
      }
    },
    async readFocusedItem({ nodeId }): Promise<FocusedItemRead> {
      try {
        const data = await readWorkGraphQL(fetch, token, "FocusedWorkItem", FOCUSED_ITEM_QUERY, { id: nodeId });
        return parseFocusedItem(data);
      } catch (error) {
        return unavailableRead(error);
      }
    },
  };
}

const VIEWER_QUERY = `query AuthenticatedViewer {
  viewer { __typename id login }
}`;

const REPOSITORIES_QUERY = `query OwnedRepositoryCapabilities {
  viewer {
    repositories(first: ${SNAPSHOT_REPOSITORY_LIMIT}, affiliations: OWNER) {
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

const WORK_ITEM_FIELDS = `
  id
  number
  title
  body
  url
  updatedAt
  repository { id nameWithOwner owner { id } }
  labels(first: ${LABEL_LIMIT}) { nodes { id name } pageInfo { hasNextPage endCursor } }
`;

const ISSUE_FIELDS = `
  ${WORK_ITEM_FIELDS}
  blockedBy(first: ${RELATIONSHIP_LIMIT}) { nodes { id state } pageInfo { hasNextPage endCursor } }
  parent { id }
`;

const PULL_REQUEST_FIELDS = `
  ${WORK_ITEM_FIELDS}
  isDraft
  changedFiles
  additions
  deletions
  closingIssuesReferences(first: ${RELATIONSHIP_LIMIT}) { nodes { id } pageInfo { hasNextPage endCursor } }
`;

const SNAPSHOT_QUERY = `query BoundedAccountSnapshot {
  viewer {
    id
    login
    repositories(first: ${SNAPSHOT_REPOSITORY_LIMIT}, affiliations: OWNER) {
      nodes {
        id
        nameWithOwner
        issues(first: ${SNAPSHOT_ITEMS_PER_TYPE_PER_REPOSITORY}, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
        pullRequests(first: ${SNAPSHOT_ITEMS_PER_TYPE_PER_REPOSITORY}, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${PULL_REQUEST_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

const FOCUSED_ITEM_QUERY = `query FocusedWorkItem($id: ID!) {
  viewer { id }
  node(id: $id) {
    __typename
    ... on Issue { state ${ISSUE_FIELDS} }
    ... on PullRequest { state ${PULL_REQUEST_FIELDS} }
  }
  rateLimit { cost remaining resetAt }
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

async function readWorkGraphQL(
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
    throw new WorkReadFailure("unavailable");
  }
  if (!response.ok) {
    if (response.status === 429 || isRateLimited(response.headers)) {
      throw rateLimitFailure(response.headers);
    }
    throw new WorkReadFailure(response.status === 401 || response.status === 403 ? "authentication_failed" : "unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WorkReadFailure("invalid_response");
  }
  if (!isObject(payload) || payload.errors !== undefined || !isObject(payload.data)) {
    if (isRateLimited(response.headers)) throw rateLimitFailure(response.headers);
    throw new WorkReadFailure("invalid_response");
  }
  return payload.data as Record<string, unknown>;
}

function parseAccountSnapshot(data: Record<string, unknown>): AccountSnapshot {
  if (!isObject(data.viewer) || !isString(data.viewer.id) || !isString(data.viewer.login)) {
    throw new WorkReadFailure("invalid_response");
  }
  const repositoriesConnection = parseConnection(data.viewer.repositories);
  const partialReasons: SnapshotPartialReason[] = repositoriesConnection.pageInfo.hasNextPage
    ? [{ kind: "repository_limit" }]
    : [];
  const repositories: GitHubRepository[] = [];
  const items: GitHubWorkItem[] = [];

  for (const rawRepository of repositoriesConnection.nodes) {
    if (!isObject(rawRepository) || !isString(rawRepository.id) || !isString(rawRepository.nameWithOwner)) {
      throw new WorkReadFailure("invalid_response");
    }
    repositories.push({ id: rawRepository.id, nameWithOwner: rawRepository.nameWithOwner });
    for (const [type, rawItems] of [["issue", rawRepository.issues], ["pull_request", rawRepository.pullRequests]] as const) {
      const connection = parseConnection(rawItems);
      if (connection.pageInfo.hasNextPage) {
        partialReasons.push({ kind: "item_limit", repositoryId: rawRepository.id, itemType: type });
      }
      for (const rawItem of connection.nodes) {
        items.push(parseWorkItem(rawItem, type, partialReasons));
      }
    }
  }

  return {
    account: { id: data.viewer.id, login: data.viewer.login },
    fetchedAt: new Date().toISOString(),
    rateLimit: parseRateLimit(data.rateLimit),
    repositories,
    items,
    scope: {
      repositoryLimit: SNAPSHOT_REPOSITORY_LIMIT,
      repositoryCount: repositories.length,
      itemLimit: SNAPSHOT_ITEM_LIMIT,
      itemCount: items.length,
      status: partialReasons.length === 0 ? "complete" : "partial",
      partialReasons,
    },
  };
}

function parseFocusedItem(data: Record<string, unknown>): FocusedItemRead {
  const rateLimit = parseRateLimit(data.rateLimit);
  if (data.node === null) {
    return { status: "unavailable", error: readError("unavailable"), rateLimit };
  }
  if (!isObject(data.node) || (data.node.__typename !== "Issue" && data.node.__typename !== "PullRequest")) {
    throw new WorkReadFailure("invalid_response");
  }
  if (!isObject(data.viewer) || !isString(data.viewer.id) || !isObject(data.node.repository) || !isObject(data.node.repository.owner) || !isString(data.node.repository.owner.id)) {
    throw new WorkReadFailure("invalid_response");
  }
  const allowedStates = data.node.__typename === "Issue"
    ? ["OPEN", "CLOSED"]
    : ["OPEN", "CLOSED", "MERGED"];
  if (!isString(data.node.state)) throw new WorkReadFailure("invalid_response");
  if (!allowedStates.includes(data.node.state)) throw new WorkReadFailure("invalid_response");
  if (data.node.state !== "OPEN") {
    return { status: "out_of_scope", reason: "closed", rateLimit };
  }
  if (data.node.repository.owner.id !== data.viewer.id) {
    return { status: "out_of_scope", reason: "repository_not_owned", rateLimit };
  }
  const partialReasons: SnapshotPartialReason[] = [];
  return {
    status: "open",
    item: parseWorkItem(data.node, data.node.__typename === "Issue" ? "issue" : "pull_request", partialReasons),
    fetchedAt: new Date().toISOString(),
    rateLimit,
    scope: {
      status: partialReasons.length === 0 ? "complete" : "partial",
      partialReasons,
    },
  };
}

function parseWorkItem(
  value: unknown,
  type: "issue" | "pull_request",
  partialReasons: SnapshotPartialReason[],
): GitHubWorkItem {
  if (!isObject(value) || !isString(value.id) || !Number.isInteger(value.number) || !isString(value.title) || !isString(value.url) || !isString(value.updatedAt) || (value.body !== null && !isString(value.body)) || !isObject(value.repository) || !isString(value.repository.id)) {
    throw new WorkReadFailure("invalid_response");
  }
  const labels = parseLabelConnection(value.labels, value.id, partialReasons);
  const base = {
    id: value.id,
    repositoryId: value.repository.id,
    number: value.number as number,
    title: value.title,
    bodyExcerpt: value.body === null ? null : excerpt(value.body),
    url: value.url,
    updatedAt: value.updatedAt,
    labels,
    relationships: [] as GitHubWorkItem["relationships"],
    relationshipCoverage: unavailableCoverage(),
  };
  if (type === "issue") {
    const relationships = parseIssueRelationships(value, partialReasons);
    return { ...base, type, ...relationships };
  }
  if (typeof value.isDraft !== "boolean" || !nullableInteger(value.changedFiles) || !nullableInteger(value.additions) || !nullableInteger(value.deletions)) {
    throw new WorkReadFailure("invalid_response");
  }
  const relationships = parsePullRequestRelationships(value, partialReasons);
  return {
    ...base,
    type,
    ...relationships,
    pullRequest: {
      isDraft: value.isDraft,
      changedFiles: value.changedFiles as number | null,
      additions: value.additions as number | null,
      deletions: value.deletions as number | null,
    },
  };
}

function parseIssueRelationships(value: Record<string, unknown>, partialReasons: SnapshotPartialReason[]) {
  const coverage = unavailableCoverage();
  const relationships: GitHubWorkItem["relationships"] = [];
  if (value.parent === null) {
    coverage.parent = "complete";
  } else if (isObject(value.parent) && isString(value.parent.id)) {
    coverage.parent = "complete";
    relationships.push({ sourceId: value.id as string, targetId: value.parent.id, type: "parent" });
  }
  readRelationshipConnection(value.blockedBy, value.id as string, "blocker", coverage, relationships, partialReasons);
  return { relationships, relationshipCoverage: coverage };
}

function parsePullRequestRelationships(value: Record<string, unknown>, partialReasons: SnapshotPartialReason[]) {
  const coverage = unavailableCoverage();
  const relationships: GitHubWorkItem["relationships"] = [];
  readRelationshipConnection(value.closingIssuesReferences, value.id as string, "closing_issue", coverage, relationships, partialReasons);
  return { relationships, relationshipCoverage: coverage };
}

function readRelationshipConnection(
  value: unknown,
  sourceId: string,
  type: RelationshipType,
  coverage: RelationshipCoverageByType,
  relationships: GitHubWorkItem["relationships"],
  partialReasons: SnapshotPartialReason[],
) {
  if (value === undefined) return;
  const connection = parseConnection(value);
  if (connection.pageInfo.hasNextPage) {
    partialReasons.push({ kind: "relationship_limit", itemId: sourceId, relationshipType: type });
    return;
  }
  coverage[type] = "complete";
  for (const node of connection.nodes) {
    if (!isObject(node) || !isString(node.id) || (type === "blocker" && node.state !== "OPEN" && node.state !== "CLOSED")) {
      throw new WorkReadFailure("invalid_response");
    }
    if (type === "blocker" && node.state !== "OPEN") continue;
    relationships.push({ sourceId, targetId: node.id, type });
  }
}

function parseLabelConnection(value: unknown, itemId: string, partialReasons: SnapshotPartialReason[]) {
  const connection = parseConnection(value);
  if (connection.pageInfo.hasNextPage) partialReasons.push({ kind: "label_limit", itemId });
  return connection.nodes.map((node) => {
    if (!isObject(node) || !isString(node.id) || !isString(node.name)) throw new WorkReadFailure("invalid_response");
    return { id: node.id, name: node.name };
  });
}

function parseConnection(value: unknown) {
  if (!isObject(value) || !Array.isArray(value.nodes) || !isObject(value.pageInfo) || typeof value.pageInfo.hasNextPage !== "boolean" || (value.pageInfo.hasNextPage && !isString(value.pageInfo.endCursor))) {
    throw new WorkReadFailure("invalid_response");
  }
  return { nodes: value.nodes, pageInfo: { hasNextPage: value.pageInfo.hasNextPage } };
}

function parseRateLimit(value: unknown): GitHubRateLimit {
  if (!isObject(value) || !Number.isInteger(value.cost) || !Number.isInteger(value.remaining) || !isString(value.resetAt) || Number.isNaN(new Date(value.resetAt).valueOf())) {
    throw new WorkReadFailure("invalid_response");
  }
  return { cost: value.cost as number, remaining: value.remaining as number, resetAt: value.resetAt };
}

function unavailableCoverage(): RelationshipCoverageByType {
  return { blocker: "unavailable", parent: "unavailable", closing_issue: "unavailable" };
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || Number.isInteger(value);
}

function excerpt(body: string) {
  return Array.from(body).slice(0, BODY_EXCERPT_LIMIT).join("");
}

class WorkReadFailure extends Error {
  constructor(
    readonly code: GitHubReadError["code"],
    readonly retryAfterSeconds?: number,
    readonly retryAt?: string,
  ) {
    super(code);
  }
}

function unavailableRead(error: unknown) {
  return {
    status: "unavailable" as const,
    error: error instanceof WorkReadFailure
      ? readError(error.code, error.retryAfterSeconds, error.retryAt)
      : readError("unavailable"),
  };
}

function readError(
  code: GitHubReadError["code"],
  retryAfterSeconds?: number,
  retryAt?: string,
): GitHubReadError {
  const messages: Record<GitHubReadError["code"], string> = {
    authentication_failed: "GitHub rejected the read request.",
    rate_limited: "GitHub rate limit prevented this read.",
    unavailable: "GitHub work data is unavailable.",
    invalid_response: "GitHub did not return the required read data.",
  };
  return {
    code,
    message: messages[code],
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

function isRateLimited(headers: Headers) {
  return headers.get("retry-after") !== null || headers.get("x-ratelimit-remaining") === "0";
}

function rateLimitFailure(headers: Headers) {
  const retryAfterSeconds = positiveInteger(headers.get("retry-after"));
  const resetAt = positiveInteger(headers.get("x-ratelimit-reset"));
  return new WorkReadFailure(
    "rate_limited",
    retryAfterSeconds,
    resetAt === undefined ? undefined : new Date(resetAt * 1_000).toISOString(),
  );
}

function positiveInteger(value: string | null) {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
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
