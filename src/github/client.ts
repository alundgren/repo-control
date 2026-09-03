import {
  ConnectionValidationError,
} from "./connection.js";
import { groupPullRequestFiles } from "../domain/pull-request-file-groups.js";
import {
  BODY_EXCERPT_LIMIT,
  INCREMENTAL_RECONCILIATION_OVERLAP_MINUTES,
  LABEL_LIMIT,
  PULL_REQUEST_FILE_LIMIT,
  PULL_REQUEST_PATCH_BYTE_LIMIT,
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
  type OwnedRepository,
  type OwnedRepositoryInventoryRead,
  type PullRequestDiffFile,
  type PullRequestDiffRead,
  type RelationshipCoverageByType,
  type RelationshipType,
  type RepositoryCapability,
  type RelationshipEnrichmentRead,
  type RelationshipEnrichmentSubject,
  type SnapshotPartialReason,
} from "./read-client.js";
import { parseUnifiedPatch } from "./unified-patch.js";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

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
    async readOwnedRepositoryInventory(): Promise<OwnedRepositoryInventoryRead> {
      try {
        return await readOwnedRepositoryInventory(fetch, token);
      } catch (error) {
        return unavailableRead(error);
      }
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
    async readEpicProgress({ nodeIds }) {
      try {
        const data = await readWorkGraphQL(fetch, token, "EpicProgress", EPIC_PROGRESS_QUERY, { ids: nodeIds });
        return parseEpicProgress(data, nodeIds);
      } catch (error) {
        return unavailableRead(error);
      }
    },
    async readPullRequestDiff(input): Promise<PullRequestDiffRead> {
      try {
        return await readPullRequestDiff(fetch, token, input);
      } catch (error) {
        return unavailableRead(error);
      }
    },
  };
}

const PULL_REQUEST_FILE_PAGE_SIZE = 100;

async function readPullRequestDiff(
  fetch: Fetch,
  token: string,
  { repositoryNameWithOwner, number }: { repositoryNameWithOwner: string; number: number },
): Promise<Exclude<PullRequestDiffRead, { status: "unavailable" }>> {
  const [owner, repository, ...extra] = repositoryNameWithOwner.split("/");
  if (!owner || !repository || extra.length > 0 || !Number.isInteger(number) || number < 1) {
    throw new WorkReadFailure("invalid_response");
  }
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}`;
  const pullRequest = await readRestJson(fetch, token, base);
  if (!isObject(pullRequest.payload) || !isObject(pullRequest.payload.head) || !isString(pullRequest.payload.head.sha)) {
    throw new WorkReadFailure("invalid_response");
  }

  const files: PullRequestDiffFile[] = [];
  let patchBytes = 0;
  let budgetExhausted = false;
  let latestRateLimit = pullRequest.rateLimit;
  const maximumPages = PULL_REQUEST_FILE_LIMIT / PULL_REQUEST_FILE_PAGE_SIZE;
  for (let page = 1; page <= maximumPages; page += 1) {
    const result = await readRestJson(fetch, token, `${base}/files?per_page=${PULL_REQUEST_FILE_PAGE_SIZE}&page=${page}`);
    latestRateLimit = result.rateLimit;
    if (!Array.isArray(result.payload)) throw new WorkReadFailure("invalid_response");
    for (const value of result.payload) {
      const parsed = parsePullRequestFile(value, patchBytes, budgetExhausted);
      files.push(parsed.file);
      patchBytes = parsed.patchBytes;
      budgetExhausted = parsed.budgetExhausted;
    }
    if (result.payload.length < PULL_REQUEST_FILE_PAGE_SIZE) {
      return {
        status: "complete",
        headSha: pullRequest.payload.head.sha,
        fileCount: files.length,
        files,
        groups: groupPullRequestFiles(files),
        rateLimit: { cost: page + 1, remaining: latestRateLimit.remaining, resetAt: latestRateLimit.resetAt },
      };
    }
  }
  return {
    status: "partial",
    headSha: pullRequest.payload.head.sha,
    fileCount: files.length,
    files,
    groups: groupPullRequestFiles(files),
    partialReason: "file_limit",
    rateLimit: { cost: maximumPages + 1, remaining: latestRateLimit.remaining, resetAt: latestRateLimit.resetAt },
  };
}

async function readRestJson(fetch: Fetch, token: string, url: string): Promise<{ payload: unknown; rateLimit: GitHubRateLimit }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetch, url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    throw new WorkReadFailure("unavailable");
  }
  if (!response.ok) {
    if (response.status === 429 || isRateLimited(response.headers)) throw rateLimitFailure(response.headers);
    throw new WorkReadFailure(response.status === 401 || response.status === 403 ? "authentication_failed" : "unavailable");
  }
  const rateLimit = parseRestRateLimit(response.headers);
  try {
    return { payload: await response.json(), rateLimit };
  } catch {
    throw new WorkReadFailure("invalid_response");
  }
}

function parseRestRateLimit(headers: Headers): GitHubRateLimit {
  const remaining = nonNegativeInteger(headers.get("x-ratelimit-remaining"));
  const reset = positiveInteger(headers.get("x-ratelimit-reset"));
  if (remaining === undefined || reset === undefined) throw new WorkReadFailure("invalid_response");
  return { cost: 1, remaining, resetAt: new Date(reset * 1_000).toISOString() };
}

function parsePullRequestFile(value: unknown, patchBytes: number, budgetExhausted: boolean) {
  if (!isObject(value) || !isString(value.filename) || !isString(value.status) || !Number.isInteger(value.additions) || !Number.isInteger(value.deletions) || (value.previous_filename !== undefined && !isString(value.previous_filename)) || (value.patch !== undefined && !isString(value.patch))) {
    throw new WorkReadFailure("invalid_response");
  }
  const additions = value.additions as number;
  const deletions = value.deletions as number;
  let patch: PullRequestDiffFile["patch"];
  if (budgetExhausted) {
    patch = { status: "unavailable", reason: "patch_budget" };
  } else if (value.patch === undefined) {
    patch = { status: "unavailable", reason: "github_omitted" };
  } else {
    const bytes = Buffer.byteLength(value.patch, "utf8");
    if (patchBytes + bytes > PULL_REQUEST_PATCH_BYTE_LIMIT) {
      budgetExhausted = true;
      patch = { status: "unavailable", reason: "patch_budget" };
    } else {
      patchBytes += bytes;
      const counts = countPatchChanges(value.patch);
      patch = counts.additions === additions && counts.deletions === deletions
        ? { status: "available", text: value.patch }
        : { status: "incomplete", reason: "count_mismatch", text: value.patch };
    }
  }
  return {
    file: {
      path: value.filename,
      previousPath: isString(value.previous_filename) ? value.previous_filename : null,
      changeType: value.status,
      additions,
      deletions,
      patch,
    },
    patchBytes,
    budgetExhausted,
  };
}

function countPatchChanges(patch: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of parseUnifiedPatch(patch)) {
    if (line.kind === "added") additions += 1;
    if (line.kind === "removed") deletions += 1;
  }
  return { additions, deletions };
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

const OWNED_REPOSITORY_INVENTORY_QUERY = `query OwnedRepositoryInventory($after: String) {
  viewer {
    id
    login
    repositories(first: ${RECONCILIATION_PAGE_SIZE}, affiliations: OWNER, after: $after) {
      nodes { id nameWithOwner isFork isArchived }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const RELATED_ISSUE_FIELDS = `id number title url repository { id nameWithOwner }`;

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

const ISSUE_FACT_FIELDS = `
  parent { ${RELATED_ISSUE_FIELDS} }
  subIssuesSummary { total completed }
`;
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

const EPIC_PROGRESS_QUERY = `query EpicProgress($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue { id subIssuesSummary { total completed } }
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
      ... on Issue { ${WORK_ITEM_FIELDS} ${ISSUE_FACT_FIELDS} }
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
    ... on Issue { state ${WORK_ITEM_FIELDS} ${ISSUE_FACT_FIELDS} }
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
    response = await fetchWithTimeout(fetch, "https://api.github.com/graphql", {
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
    response = await fetchWithTimeout(fetch, "https://api.github.com/graphql", {
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

async function fetchWithTimeout(fetch: Fetch, input: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

function parseEpicProgress(data: Record<string, unknown>, requestedNodeIds: string[]): import("./read-client.js").EpicProgressRead {
  const rateLimit = parseRateLimit(data.rateLimit);
  if (!Array.isArray(data.nodes)) throw new WorkReadFailure("invalid_response");
  const summaries: Array<{ nodeId: string; subIssues: import("./read-client.js").SubIssuesSummary }> = [];
  for (const node of data.nodes) {
    if (!isObject(node) || node.__typename !== "Issue" || !isString(node.id)) continue;
    const subIssues = parseSubIssuesSummary(node.subIssuesSummary);
    if (subIssues) summaries.push({ nodeId: node.id, subIssues });
  }
  return {
    status: summaries.length === requestedNodeIds.length ? "complete" : "partial",
    summaries,
    rateLimit,
  };
}

function hasCompleteExpectedRelationshipCoverage(subject: RelationshipEnrichmentSubject): boolean {
  return subject.coverage.blocker === "complete" || subject.coverage.closing_issue === "complete";
}

async function readOwnedRepositoryInventory(fetch: Fetch, token: string) {
  let after: string | null = null;
  let account: { id: string; login: string } | null = null;
  const repositories: OwnedRepository[] = [];
  do {
    const data = await readWorkGraphQL(fetch, token, "OwnedRepositoryInventory", OWNED_REPOSITORY_INVENTORY_QUERY, { after });
    if (!isObject(data.viewer) || !isString(data.viewer.id) || !isString(data.viewer.login)) {
      throw new WorkReadFailure("invalid_response");
    }
    const nextAccount = { id: data.viewer.id, login: data.viewer.login };
    if (account && (account.id !== nextAccount.id || account.login !== nextAccount.login)) {
      throw new WorkReadFailure("invalid_response");
    }
    account = nextAccount;
    const connection = parseConnection(data.viewer.repositories);
    repositories.push(...connection.nodes.map(parseOwnedRepository));
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after !== null);
  if (!account) throw new WorkReadFailure("invalid_response");
  return { account, fetchedAt: new Date().toISOString(), repositories };
}

function parseOwnedRepository(value: unknown): OwnedRepository {
  if (!isObject(value) || !isString(value.id) || !isString(value.nameWithOwner) || typeof value.isFork !== "boolean" || typeof value.isArchived !== "boolean") {
    throw new WorkReadFailure("invalid_response");
  }
  return { id: value.id, nameWithOwner: value.nameWithOwner, isFork: value.isFork, isArchived: value.isArchived };
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
      const issueCount = data.search.issueCount as number;
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
  const cleanItems = [...items.values()].map((item) => {
    const cleanItem = { ...item } as GitHubWorkItem;
    delete cleanItem.repositoryNameWithOwner;
    return cleanItem;
  });
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
    return {
      status: "out_of_scope",
      reason: data.node.__typename === "PullRequest" && data.node.state === "MERGED" ? "merged" : "closed",
      rateLimit,
    };
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
    repositoryNameWithOwner: isString(value.repository.nameWithOwner) ? value.repository.nameWithOwner : undefined,
    repositoryOwnerId: isObject(value.repository.owner) && isString(value.repository.owner.id) ? value.repository.owner.id : undefined,
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
    return { ...base, type, ...relationships, subIssues: parseSubIssuesSummary(value.subIssuesSummary) };
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
  const relatedItems: import("./read-client.js").RelatedWorkItem[] = [];
  if (value.parent === undefined) {
    // Field was not requested by this read; leave parent facts unsampled.
  } else if (value.parent === null) {
    coverage.parent = "complete";
  } else if (isObject(value.parent) && isString(value.parent.id)) {
    coverage.parent = "complete";
    const related = toRelatedWorkItem(value.parent);
    if (!related) throw new WorkReadFailure("invalid_response");
    relationships.push({ sourceId: value.id as string, targetId: related.id, type: "parent" });
    relatedItems.push(related);
  }
  readRelationshipConnection(value.blockedBy, value.id as string, "blocker", coverage, relationships, partialReasons);
  return { relationships, relationshipCoverage: coverage, ...(relatedItems.length > 0 ? { relatedItems } : {}) };
}

function toRelatedWorkItem(value: unknown): import("./read-client.js").RelatedWorkItem | null {
  if (!isObject(value) || !isString(value.id) || !Number.isInteger(value.number) || !isString(value.title) || !isString(value.url) || !isObject(value.repository) || !isString(value.repository.nameWithOwner)) {
    return null;
  }
  return {
    id: value.id,
    repositoryId: value.repository.id as string,
    repositoryNameWithOwner: value.repository.nameWithOwner,
    number: value.number as number,
    title: value.title,
    url: value.url,
  };
}

function parseSubIssuesSummary(value: unknown): import("./read-client.js").SubIssuesSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value) || !Number.isInteger(value.total) || !Number.isInteger(value.completed) || (value.completed as number) < 0 || (value.total as number) < 0) {
    throw new WorkReadFailure("invalid_response");
  }
  return { total: value.total as number, completed: value.completed as number };
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

function nonNegativeInteger(value: string | null) {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
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
