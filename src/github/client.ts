import {
  ConnectionValidationError,
} from "./connection.js";
import {
  BODY_EXCERPT_LIMIT,
  INCREMENTAL_RECONCILIATION_OVERLAP_MINUTES,
  LABEL_LIMIT,
  RECONCILIATION_PAGE_SIZE,
  RELATIONSHIP_LIMIT,
  RELATIONSHIP_SUBJECT_LIMIT,
  SEARCH_RESULT_LIMIT,
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
  type RelationshipEnrichmentRead,
  type RelationshipEnrichmentSubject,
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
    async readAccountSnapshot({ updatedSince } = { updatedSince: null }): Promise<AccountSnapshotRead> {
      try {
        return await readAccountSnapshot(fetch, token, updatedSince);
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
    async readRelationshipEnrichment({ nodeIds }): Promise<RelationshipEnrichmentRead> {
      const requested = [...new Set(nodeIds)];
      const readNodeIds = requested.slice(0, RELATIONSHIP_SUBJECT_LIMIT);
      if (readNodeIds.length === 0) {
        return { requestedCount: 0, readCount: 0, subjectLimit: RELATIONSHIP_SUBJECT_LIMIT, status: "complete", subjects: [] };
      }
      try {
        const data = await readWorkGraphQL(fetch, token, "EnrichWorkItemRelationships", RELATIONSHIP_QUERY, { ids: readNodeIds });
        const { rateLimit, subjects } = parseRelationshipEnrichment(data, readNodeIds);
        return {
          requestedCount: requested.length,
          readCount: readNodeIds.length,
          subjectLimit: RELATIONSHIP_SUBJECT_LIMIT,
          status: requested.length === readNodeIds.length && subjects.every(hasCompleteExpectedRelationshipCoverage)
            ? "complete"
            : "partial",
          rateLimit,
          subjects: [...subjects, ...requested.slice(readNodeIds.length).map((nodeId) => ({
            nodeId,
            coverage: { blocker: "not_sampled", closing_issue: "not_sampled" } as const,
            relationships: [], relatedItems: [], status: "not_sampled" as const,
          }))],
        };
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
    repositories(first: ${RECONCILIATION_PAGE_SIZE}, affiliations: OWNER) {
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
  createdAt
  updatedAt
  repository { id nameWithOwner owner { id } }
  labels(first: ${LABEL_LIMIT}) { nodes { id name } pageInfo { hasNextPage endCursor } }
`;

const RELATED_ISSUE_FIELDS = `id number title url repository { id nameWithOwner }`;
const RELATIONSHIP_QUERY = `query EnrichWorkItemRelationships($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      blockedBy(first: ${RELATIONSHIP_LIMIT}) { nodes { ${RELATED_ISSUE_FIELDS} state } pageInfo { hasNextPage endCursor } }
    }
    ... on PullRequest {
      id
      closingIssuesReferences(first: ${RELATIONSHIP_LIMIT}) { nodes { ${RELATED_ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

const ACCOUNT_QUERY = `query AccountSearchViewer {
  viewer { id login }
  rateLimit { cost remaining resetAt }
}`;

const ACCOUNT_SEARCH_QUERY = `query AccountSearchPage($query: String!, $after: String) {
  viewer {
    id
    login
  }
  search(query: $query, type: ISSUE, first: ${RECONCILIATION_PAGE_SIZE}, after: $after) {
    issueCount
    nodes {
      __typename
      ... on Issue { ${WORK_ITEM_FIELDS} }
      ... on PullRequest { ${WORK_ITEM_FIELDS} isDraft changedFiles additions deletions }
    }
    pageInfo { hasNextPage endCursor }
  }
  rateLimit { cost remaining resetAt }
}`;

const FOCUSED_ITEM_QUERY = `query FocusedWorkItem($id: ID!) {
  viewer { id }
  node(id: $id) {
    __typename
    ... on Issue { state ${WORK_ITEM_FIELDS} }
    ... on PullRequest { state ${WORK_ITEM_FIELDS} isDraft changedFiles additions deletions }
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
  variables: Record<string, string | string[] | null>,
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

function parseRelationshipEnrichment(
  data: Record<string, unknown>,
  requestedNodeIds: string[],
): { rateLimit: GitHubRateLimit; subjects: RelationshipEnrichmentSubject[] } {
  const rateLimit = parseRateLimit(data.rateLimit);
  if (!Array.isArray(data.nodes)) throw new WorkReadFailure("invalid_response");
  const byId = new Map<string, Record<string, unknown>>();
  for (const node of data.nodes) {
    if (isObject(node) && isString(node.id)) byId.set(node.id, node);
  }
  return { rateLimit, subjects: requestedNodeIds.map((nodeId) => {
    const node = byId.get(nodeId);
    if (!node || (node.__typename !== "Issue" && node.__typename !== "PullRequest")) {
      return unavailableRelationshipSubject(nodeId);
    }
    try {
      const relationships: GitHubWorkItem["relationships"] = [];
      const relatedItems = [] as import("./read-client.js").RelatedWorkItem[];
      const type = node.__typename === "Issue" ? "blocker" : "closing_issue";
      const connection = node.__typename === "Issue" ? node.blockedBy : node.closingIssuesReferences;
      if (connection === undefined) return unavailableRelationshipSubject(nodeId, node.__typename);
      const parsed = parseConnection(connection);
      if (parsed.pageInfo.hasNextPage) return unavailableRelationshipSubject(nodeId, node.__typename);
      for (const related of parsed.nodes) {
        if (!isObject(related) || !isString(related.id) || !Number.isInteger(related.number) || !isString(related.title) || !isString(related.url) || !isObject(related.repository) || !isString(related.repository.id) || !isString(related.repository.nameWithOwner) || (type === "blocker" && related.state !== "OPEN" && related.state !== "CLOSED")) {
          return unavailableRelationshipSubject(nodeId, node.__typename);
        }
        if (type === "blocker" && related.state !== "OPEN") continue;
        relationships.push({ sourceId: nodeId, targetId: related.id, type });
        relatedItems.push({ id: related.id, repositoryId: related.repository.id, repositoryNameWithOwner: related.repository.nameWithOwner, number: related.number as number, title: related.title, url: related.url });
      }
      return {
        nodeId,
        coverage: type === "blocker" ? { blocker: "complete", closing_issue: "not_sampled" } : { blocker: "not_sampled", closing_issue: "complete" },
        relationships,
        relatedItems,
        status: "read",
      };
    } catch {
      return unavailableRelationshipSubject(nodeId, node.__typename);
    }
  }) };
}

function unavailableRelationshipSubject(nodeId: string, type?: unknown): RelationshipEnrichmentSubject {
  return {
    nodeId,
    coverage: type === "Issue" ? { blocker: "unavailable", closing_issue: "not_sampled" } : type === "PullRequest" ? { blocker: "not_sampled", closing_issue: "unavailable" } : { blocker: "unavailable", closing_issue: "unavailable" },
    relationships: [],
    relatedItems: [],
    status: "read",
  };
}

function hasCompleteExpectedRelationshipCoverage(subject: RelationshipEnrichmentSubject): boolean {
  return subject.coverage.blocker === "complete" || subject.coverage.closing_issue === "complete";
}

async function readAccountSnapshot(
  fetch: Fetch,
  token: string,
  updatedSince: string | null,
): Promise<AccountSnapshot> {
  const identityData = await readWorkGraphQL(fetch, token, "AccountSearchViewer", ACCOUNT_QUERY, {});
  if (!isObject(identityData.viewer) || !isString(identityData.viewer.id) || !isString(identityData.viewer.login)) {
    throw new WorkReadFailure("invalid_response");
  }
  const account = { id: identityData.viewer.id, login: identityData.viewer.login };
  const reconciliation = updatedSince === null ? "full" as const : "incremental" as const;
  const queries = [
    { itemType: "issue" as const, query: accountSearchQuery(account.login, "issue", updatedSince) },
    { itemType: "pull_request" as const, query: accountSearchQuery(account.login, "pull_request", updatedSince) },
  ];
  const items = new Map<string, SearchWorkItem>();
  const partialReasons: SnapshotPartialReason[] = [];
  let rateLimit = parseRateLimit(identityData.rateLimit);

  for (const search of queries) {
    let after: string | null = null;
    let resultCount = 0;
    let issueCount: number | null = null;
    do {
      const data = await readWorkGraphQL(fetch, token, "AccountSearchPage", ACCOUNT_SEARCH_QUERY, {
        after,
        query: search.query,
      });
      rateLimit = addRateLimit(rateLimit, parseRateLimit(data.rateLimit));
      if (!isObject(data.search) || !Number.isInteger(data.search.issueCount)) {
        throw new WorkReadFailure("invalid_response");
      }
      const connection = parseConnection(data.search);
      issueCount = data.search.issueCount as number;
      resultCount += connection.nodes.length;
      for (const node of connection.nodes) {
        const item = parseOwnedSearchItem(node, search.itemType, account.id, partialReasons);
        if (item) {
          items.set(item.id, item);
        }
      }
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      if (after === null && issueCount > resultCount) {
        partialReasons.push({ kind: "search_result_limit", itemType: search.itemType });
      }
    } while (after !== null);
  }

  const repositories = new Map<string, GitHubRepository>();
  for (const item of items.values()) {
    const repository = item.repositoryId;
    repositories.set(repository, { id: repository, nameWithOwner: item.repositoryNameWithOwner });
  }
  const cleanItems = [...items.values()].map(({ repositoryNameWithOwner: _repositoryNameWithOwner, ...item }) => item);
  return {
    account,
    fetchedAt: new Date().toISOString(),
    rateLimit,
    repositories: [...repositories.values()].sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner)),
    items: cleanItems,
    scope: {
      reconciliation,
      lastFullReconciliationAt: reconciliation === "full" && !partialReasons.some((reason) => reason.kind === "search_result_limit")
        ? new Date().toISOString()
        : updatedSince,
      inventoryComplete: !partialReasons.some((reason) => reason.kind === "search_result_limit"),
      searchPageSize: RECONCILIATION_PAGE_SIZE,
      searchResultLimit: SEARCH_RESULT_LIMIT,
      repositoryCount: repositories.size,
      itemCount: cleanItems.length,
      status: partialReasons.length === 0 ? "complete" : "partial",
      partialReasons,
    },
  };
}

function accountSearchQuery(login: string, type: "issue" | "pull_request", updatedSince: string | null): string {
  const typeQualifier = type === "issue" ? "is:issue" : "is:pr";
  const overlap = updatedSince === null
    ? null
    : new Date(new Date(updatedSince).getTime() - INCREMENTAL_RECONCILIATION_OVERLAP_MINUTES * 60_000).toISOString();
  return [
    `user:${login}`,
    "is:open",
    typeQualifier,
    "sort:updated-asc",
    overlap ? `updated:>=${overlap}` : null,
  ].filter(Boolean).join(" ");
}

function parseOwnedSearchItem(
  value: unknown,
  type: "issue" | "pull_request",
  accountId: string,
  partialReasons: SnapshotPartialReason[],
): SearchWorkItem | null {
  if (!isObject(value) || !isObject(value.repository) || !isObject(value.repository.owner) || value.repository.owner.id !== accountId) {
    return null;
  }
  const item = parseWorkItem(value, type, partialReasons);
  if (!isString(value.repository.nameWithOwner)) throw new WorkReadFailure("invalid_response");
  return { ...item, repositoryNameWithOwner: value.repository.nameWithOwner };
}

type SearchWorkItem = GitHubWorkItem & { repositoryNameWithOwner: string };

function addRateLimit(previous: GitHubRateLimit, next: GitHubRateLimit): GitHubRateLimit {
  return { cost: previous.cost + next.cost, remaining: next.remaining, resetAt: next.resetAt };
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
  if (!isObject(value) || !isString(value.id) || !Number.isInteger(value.number) || !isString(value.title) || !isString(value.url) || !isString(value.createdAt) || !isString(value.updatedAt) || (value.body !== null && !isString(value.body)) || !isObject(value.repository) || !isString(value.repository.id)) {
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
    createdAt: value.createdAt,
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
  return { nodes: value.nodes, pageInfo: { hasNextPage: value.pageInfo.hasNextPage, endCursor: value.pageInfo.endCursor as string | null } };
}

function parseRateLimit(value: unknown): GitHubRateLimit {
  if (!isObject(value) || !Number.isInteger(value.cost) || !Number.isInteger(value.remaining) || !isString(value.resetAt) || Number.isNaN(new Date(value.resetAt).valueOf())) {
    throw new WorkReadFailure("invalid_response");
  }
  return { cost: value.cost as number, remaining: value.remaining as number, resetAt: value.resetAt };
}

function unavailableCoverage(): RelationshipCoverageByType {
  return { blocker: "not_sampled", parent: "not_sampled", closing_issue: "not_sampled" };
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
