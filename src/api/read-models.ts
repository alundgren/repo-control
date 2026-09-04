import type { Cache, CacheItem, SuccessfulSnapshot } from "../cache/index.js";
import type { RefreshError, RefreshOutcome } from "../refresh/index.js";
import type { SyncOutcome } from "../sync/index.js";
import { classifyIssues, type ClassifiedIssue, type IssueReadiness, type QueueMapping, type ReadyExclusion } from "../domain/workflow.js";
import type { GitHubReadError } from "../github/read-client.js";

export type ApiScope = SuccessfulSnapshot["scope"];
export type ApiRepository = SuccessfulSnapshot["repositories"][number];

export type ApiBlocker =
  | { status: "known"; id: string; repositoryId: string; repositoryNameWithOwner?: string; number: number; title: string; url: string }
  | { status: "unknown"; id: string };

export type ApiReadiness =
  | { kind: "unblocked" }
  | { kind: "unavailable" }
  | { kind: "blocked"; blockers: ApiBlocker[] };

export type ApiRelatedItem = {
  id: string;
  repositoryId: string;
  repositoryNameWithOwner: string;
  number: number;
  title: string;
  url: string;
};

export type ApiRelatedItems =
  | { status: "complete"; items: ApiRelatedItem[] }
  | { status: "unavailable" }
  | { status: "not_sampled" };

export type ApiSubIssues = { completed: number; total: number };

export type ApiEpicMembership = {
  id: string;
  repositoryId: string;
  repositoryNameWithOwner: string | null;
  number: number;
  title: string;
  url: string;
  subIssues: ApiSubIssues | null;
};

export type ApiIssue = {
  id: string;
  type: "issue";
  repositoryId: string;
  number: number;
  title: string;
  excerpt: string | null;
  url: string;
  createdAt?: string | null;
  updatedAt: string;
  observedAt?: string;
  queue: string | null;
  readiness: ApiReadiness;
  readyExclusion: ReadyExclusion;
  epic: ApiEpicMembership | null;
  subIssues: ApiSubIssues | null;
};

export type ApiPullRequest = {
  id: string;
  type: "pull_request";
  repositoryId: string;
  number: number;
  title: string;
  excerpt: string | null;
  url: string;
  createdAt?: string | null;
  updatedAt: string;
  observedAt?: string;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
  closingIssues: ApiRelatedItems;
};

export type ApiItem = ApiIssue | ApiPullRequest;

export type ApiQueue = { name: string; issues: ApiIssue[] };

export type OverviewResponse =
  | {
      status: "ready";
      fetchedAt: string;
      repositories: ApiRepository[];
      scope: ApiScope;
      queues: ApiQueue[];
      issues: ApiIssue[];
      pullRequests: ApiPullRequest[];
      epics: ApiIssue[];
    }
  | { status: "empty" };

export type ApiError = { code: string; retryAfterSeconds?: number; retryAt?: string };

export type SyncResponse =
  | { status: "complete" | "partial"; fetchedAt: string; scope: ApiScope }
  | {
      status: "failed";
      error: ApiError;
      lastSuccessfulSync: { fetchedAt: string } | null;
    };

export type ItemRefreshResponse =
  | { status: "updated"; item: ApiItem; fetchedAt: string; relationshipStatus: "fresh" | "stale"; repositories?: ApiRepository[]; scope?: ApiScope }
  | { status: "removed"; reason: "closed" | "merged" | "repository_not_owned"; scope?: ApiScope }
  | { status: "not_found" }
  | { status: "permission_denied"; error: ApiError; item: ApiItem }
  | { status: "failed"; error: ApiError; item: ApiItem };

export function buildOverview(cache: Cache): OverviewResponse {
  const snapshot = cache.getActiveSnapshot();
  if (!snapshot) {
    return { status: "empty" };
  }

  const mapping = cache.getQueueMapping();
  const epicLabel = cache.getEpicLabel();
  const issues = snapshot.items.filter(
    (item): item is CacheItem & { type: "issue" } => item.type === "issue",
  );
  const pullRequests = snapshot.items.filter(
    (item): item is CacheItem & { type: "pull_request" } => item.type === "pull_request",
  );

  const blockerCache = new Map<string, ApiBlocker>();
  const apiIssues = classifyIssues(mapping, issues, { epicLabel, claimedLabel: cache.getClaimedLabel() }).map((classified) =>
    toApiIssue(cache, classified, blockerCache),
  );

  return {
    status: "ready",
    fetchedAt: snapshot.fetchedAt,
    repositories: snapshot.repositories,
    scope: snapshot.scope,
    issues: apiIssues,
    queues: groupIntoQueues(mapping, apiIssues.filter((issue): issue is ApiIssue & { queue: string } => issue.queue !== null)),
    pullRequests: pullRequests.map((item) => toApiPullRequest(cache, item)).sort(comparePullRequests),
    epics: apiIssues
      .filter((issue) => issue.queue === null)
      .sort(compareEpics),
  };
}

export function toSyncResponse(outcome: SyncOutcome): SyncResponse {
  if (outcome.status === "failed") {
    return {
      status: "failed",
      error: toApiError(outcome.error),
      lastSuccessfulSync: outcome.activeSnapshot ? { fetchedAt: outcome.activeSnapshot.fetchedAt } : null,
    };
  }
  return { status: outcome.status, fetchedAt: outcome.fetchedAt, scope: outcome.scope };
}

export function toItemRefreshResponse(cache: Cache, outcome: RefreshOutcome): ItemRefreshResponse {
  const active = typeof cache.getActiveSnapshot === "function" ? cache.getActiveSnapshot() : null;
  switch (outcome.status) {
    case "not_found":
      return { status: "not_found" };
    case "removed":
      return { status: "removed", reason: outcome.reason, ...(active ? { scope: active.scope } : {}) };
    case "updated":
      {
      const active = cache.getActiveSnapshot();
      return {
        status: "updated",
        item: toApiItem(cache, outcome.item),
        fetchedAt: outcome.fetchedAt,
        relationshipStatus: outcome.relationshipStatus,
        ...(active ? { repositories: active.repositories, scope: active.scope } : {}),
      };
      }
    case "permission_denied":
      return {
        status: "permission_denied",
        error: toApiError(outcome.error),
        item: toApiItem(cache, outcome.cachedItem),
      };
    case "failed":
      return {
        status: "failed",
        error: toApiError(outcome.error),
        item: toApiItem(cache, outcome.cachedItem),
      };
  }
}

export function toApiItem(cache: Cache, item: CacheItem): ApiItem {
  if (item.type === "pull_request") {
    return toApiPullRequest(cache, item);
  }
  const mapping = cache.getQueueMapping();
  const [classified] = classifyIssues(mapping, [item], { epicLabel: cache.getEpicLabel(), claimedLabel: cache.getClaimedLabel() });
  return toApiIssue(cache, classified!);
}

function toApiIssue(
  cache: Cache,
  classified: ClassifiedIssue<CacheItem>,
  blockerCache: Map<string, ApiBlocker> = new Map(),
): ApiIssue {
  return {
    id: classified.id,
    type: "issue",
    repositoryId: classified.repositoryId,
    number: classified.number,
    title: classified.title,
    excerpt: classified.body,
    observedAt: classified.observedAt,
    url: classified.url,
    createdAt: classified.createdAt,
    updatedAt: classified.updatedAt,
    queue: classified.queue,
    readiness: toApiReadiness(cache, classified.readiness, blockerCache),
    readyExclusion: classified.readyExclusion,
    epic: toApiEpicMembership(cache, classified),
    subIssues: classified.subIssues ?? null,
  };
}

function toApiEpicMembership(
  cache: Cache,
  classified: ClassifiedIssue<CacheItem>,
): ApiEpicMembership | null {
  if (classified.relationshipCoverage.parent !== "complete") {
    return null;
  }
  const parentId = classified.relationships.find((relationship) => relationship.type === "parent")?.targetId;
  if (!parentId) {
    return null;
  }
  const summary = cache.getRelatedItem(parentId);
  const cached = cache.getItem(parentId);
  if (!summary && !cached) {
    return null;
  }
  return {
    id: parentId,
    repositoryId: summary?.repositoryId ?? cached!.repositoryId,
    repositoryNameWithOwner: summary?.repositoryNameWithOwner ?? null,
    number: summary?.number ?? cached!.number,
    title: summary?.title ?? cached!.title,
    url: summary?.url ?? cached!.url,
    subIssues: cached && cached.type === "issue" && cached.subIssues
      ? { ...cached.subIssues }
      : null,
  };
}

function toApiReadiness(
  cache: Cache,
  readiness: IssueReadiness,
  blockerCache: Map<string, ApiBlocker>,
): ApiReadiness {
  if (readiness.kind !== "blocked") {
    return { kind: readiness.kind };
  }
  return {
    kind: "blocked",
    blockers: readiness.blockerIds.map((id) => resolveBlocker(cache, id, blockerCache)),
  };
}

function resolveBlocker(cache: Cache, id: string, blockerCache: Map<string, ApiBlocker>): ApiBlocker {
  const cached = blockerCache.get(id);
  if (cached) {
    return cached;
  }
  const item = cache.getItem(id);
  const related = cache.getRelatedItem(id);
  const resolved: ApiBlocker = item
    ? { status: "known", id: item.id, repositoryId: item.repositoryId, number: item.number, title: item.title, url: item.url }
    : related
      ? {
          status: "known",
          id: related.id,
          repositoryId: related.repositoryId,
          repositoryNameWithOwner: related.repositoryNameWithOwner,
          number: related.number,
          title: related.title,
          url: related.url,
        }
      : { status: "unknown", id };
  blockerCache.set(id, resolved);
  return resolved;
}

function toApiPullRequest(cache: Cache, item: CacheItem & { type: "pull_request" }): ApiPullRequest {
  return {
    id: item.id,
    type: "pull_request",
    repositoryId: item.repositoryId,
    number: item.number,
    title: item.title,
    excerpt: item.body,
    observedAt: item.observedAt,
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    isDraft: item.pullRequest.isDraft,
    additions: item.pullRequest.additions,
    deletions: item.pullRequest.deletions,
    closingIssues: toApiRelatedItems(cache, item, "closing_issue"),
  };
}

function toApiRelatedItems(cache: Cache, item: CacheItem, type: "closing_issue"): ApiRelatedItems {
  const coverage = item.relationshipCoverage[type];
  if (coverage !== "complete") {
    return { status: coverage };
  }
  const targets = item.relationships.filter((relationship) => relationship.type === type);
  const related = targets.map((relationship) => cache.getRelatedItem(relationship.targetId));
  if (related.some((entry) => !entry)) {
    return { status: "unavailable" };
  }
  return { status: "complete", items: related as ApiRelatedItem[] };
}

function compareEpics(left: ApiIssue, right: ApiIssue): number {
  return (
    compareStrings(right.updatedAt, left.updatedAt) ||
    compareStrings(left.repositoryId, right.repositoryId) ||
    left.number - right.number ||
    compareStrings(left.id, right.id)
  );
}

function groupIntoQueues(mapping: QueueMapping, issues: Array<ApiIssue & { queue: string }>): ApiQueue[] {
  const byQueue = new Map<string, ApiIssue[]>();
  for (const name of queueOrder(mapping)) {
    byQueue.set(name, []);
  }
  for (const issue of issues) {
    if (issue.queue === "agent" && issue.readyExclusion !== null) {
      continue;
    }
    const existing = byQueue.get(issue.queue);
    if (existing) {
      existing.push(issue);
    } else {
      byQueue.set(issue.queue, [issue]);
    }
  }
  return [...byQueue.entries()].map(([name, queueIssues]) => ({ name, issues: queueIssues }));
}

function queueOrder(mapping: QueueMapping): string[] {
  const order: string[] = [];
  for (const { queue } of mapping.labels) {
    if (!order.includes(queue)) {
      order.push(queue);
    }
  }
  if (!order.includes(mapping.defaultQueue)) {
    order.push(mapping.defaultQueue);
  }
  return order;
}

function comparePullRequests(left: ApiPullRequest, right: ApiPullRequest): number {
  return (
    compareStrings(left.updatedAt, right.updatedAt) ||
    compareStrings(left.repositoryId, right.repositoryId) ||
    left.number - right.number
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function toApiError(error: GitHubReadError | RefreshError): ApiError {
  const apiError: ApiError = { code: error.code };
  if ("retryAfterSeconds" in error && error.retryAfterSeconds !== undefined) {
    apiError.retryAfterSeconds = error.retryAfterSeconds;
  }
  if ("retryAt" in error && error.retryAt !== undefined) {
    apiError.retryAt = error.retryAt;
  }
  return apiError;
}
