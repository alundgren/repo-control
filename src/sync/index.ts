import type { Cache, CacheItem, PullRequestFacts, SuccessfulSnapshot } from "../cache/index.js";
import type {
  AccountSnapshot,
  GitHubRateLimit,
  GitHubReadClient,
  GitHubReadError,
  GitHubWorkItem,
  SnapshotPartialReason,
  UnavailableRead,
  RelationshipEnrichmentSubject,
} from "../github/read-client.js";
import { RECONCILIATION_PAGE_SIZE, RELATIONSHIP_SUBJECT_LIMIT, SEARCH_RESULT_LIMIT } from "../github/read-client.js";

export const FULL_RECONCILIATION_INTERVAL_HOURS = 24;

export type SyncClient = Pick<GitHubReadClient, "readAccountSnapshot" | "readRelationshipEnrichment">;

export type SyncOutcome = SyncSuccess | SyncFailure;

export type SyncSuccess = {
  status: "complete" | "partial";
  generationId: number;
  fetchedAt: string;
  scope: SuccessfulSnapshot["scope"];
  rateLimit: GitHubRateLimit;
};

export type SyncFailure = {
  status: "failed";
  error: GitHubReadError;
  rateLimit: GitHubRateLimit | null;
  activeSnapshot: PreviousSnapshotState | null;
};

export type PreviousSnapshotState = {
  generationId: number;
  fetchedAt: string;
};

export type SyncService = {
  sync(): Promise<SyncOutcome>;
};

export function createSyncService({
  cache,
  client,
  now = Date.now,
}: {
  cache: Cache;
  client: SyncClient;
  now?: () => number;
}): SyncService {
  let inFlight: Promise<SyncOutcome> | null = null;

  return {
    sync() {
      if (inFlight) {
        return inFlight;
      }
      const promise = runSync(cache, client, now).finally(() => {
        inFlight = null;
      });
      inFlight = promise;
      return promise;
    },
  };
}

async function runSync(cache: Cache, client: SyncClient, now: () => number): Promise<SyncOutcome> {
  const active = cache.getActiveSnapshot();
  const updatedSince = shouldRunFullReconciliation(active, now()) ? null : active?.scope.lastFullReconciliationAt ?? null;
  const read = await client.readAccountSnapshot({ updatedSince });
  if ("status" in read) return toFailure(cache, read);
  const enriched = await enrichRelationships(client, read);
  return toSuccess(cache, enriched.read, active, enriched.rateLimit);
}

function toFailure(cache: Cache, read: UnavailableRead): SyncFailure {
  const active = cache.getActiveSnapshot();
  return {
    status: "failed",
    error: read.error,
    rateLimit: read.rateLimit ?? null,
    activeSnapshot: active ? { generationId: active.generationId, fetchedAt: active.fetchedAt } : null,
  };
}

function toSuccess(
  cache: Cache,
  read: AccountSnapshot,
  active: ReturnType<Cache["getActiveSnapshot"]>,
  enrichmentRateLimit: GitHubRateLimit | null,
): SyncSuccess {
  const snapshot = toSuccessfulSnapshot(read, active);
  const generationId = cache.replaceActiveSnapshot(snapshot);

  return {
    status: snapshot.scope.truncatedReason === null ? "complete" : "partial",
    generationId,
    fetchedAt: snapshot.fetchedAt,
    scope: snapshot.scope,
    rateLimit: enrichmentRateLimit ? addRateLimit(read.rateLimit, enrichmentRateLimit) : read.rateLimit,
  };
}

function toSuccessfulSnapshot(read: AccountSnapshot, active: ReturnType<Cache["getActiveSnapshot"]>): SuccessfulSnapshot {
  const reconciliation = read.scope.reconciliation ?? "full";
  const inventoryComplete = read.scope.inventoryComplete ?? !read.scope.partialReasons.some((reason) => reason.kind === "repository_limit" || reason.kind === "item_limit" || reason.kind === "search_result_limit");
  const retainPriorItems = reconciliation === "incremental" || !inventoryComplete;
  const retained = retainPriorItems && active ? active.items : [];
  const mergedItems = new Map(retained.map((item) => [item.id, item]));
  for (const item of read.items) mergedItems.set(item.id, toCacheItem(item));
  const repositories = new Map((retainPriorItems && active ? active.repositories : []).map((repository) => [repository.id, repository]));
  for (const repository of read.repositories) repositories.set(repository.id, repository);
  const isFullInventory = reconciliation === "full" && inventoryComplete;
  return {
    account: read.account,
    fetchedAt: read.fetchedAt,
    repositories: [...repositories.values()],
    items: [...mergedItems.values()],
    scope: {
      reconciliation,
      lastFullReconciliationAt: isFullInventory ? read.fetchedAt : active?.scope.lastFullReconciliationAt ?? null,
      inventoryComplete,
      searchPageSize: read.scope.searchPageSize ?? RECONCILIATION_PAGE_SIZE,
      searchResultLimit: read.scope.searchResultLimit ?? SEARCH_RESULT_LIMIT,
      repositoryCount: repositories.size,
      itemCount: mergedItems.size,
      truncatedReason: toTruncatedReason(read.scope.partialReasons),
    },
  };
}

function toCacheItem(item: GitHubWorkItem): CacheItem {
  const base = {
    id: item.id,
    repositoryId: item.repositoryId,
    number: item.number,
    title: item.title,
    body: item.bodyExcerpt,
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    labels: item.labels,
    relationships: item.relationships,
    relationshipCoverage: item.relationshipCoverage,
    relatedItems: item.relatedItems,
  };
  if (item.type === "issue") {
    return { ...base, type: "issue" };
  }

  const pullRequest: PullRequestFacts = {
    additions: item.pullRequest.additions,
    deletions: item.pullRequest.deletions,
    isDraft: item.pullRequest.isDraft,
  };
  return { ...base, type: "pull_request", pullRequest };
}

function shouldRunFullReconciliation(active: ReturnType<Cache["getActiveSnapshot"]>, now: number): boolean {
  if (!active?.scope.lastFullReconciliationAt) return true;
  const lastFull = new Date(active.scope.lastFullReconciliationAt).getTime();
  return Number.isNaN(lastFull) || now - lastFull >= FULL_RECONCILIATION_INTERVAL_HOURS * 60 * 60 * 1_000;
}

async function enrichRelationships(
  client: SyncClient,
  read: AccountSnapshot,
): Promise<{ read: AccountSnapshot; rateLimit: GitHubRateLimit | null }> {
  const items = read.items.map((item) => ({
    ...item,
    relationships: [...item.relationships],
    relationshipCoverage: { ...item.relationshipCoverage },
    relatedItems: item.relatedItems ? [...item.relatedItems] : undefined,
  }));
  let failed = false;
  let rateLimit: GitHubRateLimit | null = null;
  for (let index = 0; index < items.length; index += RELATIONSHIP_SUBJECT_LIMIT) {
    const batch = items.slice(index, index + RELATIONSHIP_SUBJECT_LIMIT);
    const enrichment = await client.readRelationshipEnrichment({ nodeIds: batch.map((item) => item.id) });
    if (enrichment.status === "unavailable") {
      failed = true;
      rateLimit = enrichment.rateLimit ? addRateLimit(rateLimit, enrichment.rateLimit) : rateLimit;
      break;
    }
    rateLimit = enrichment.rateLimit ? addRateLimit(rateLimit, enrichment.rateLimit) : rateLimit;
    const bySubject = new Map(enrichment.subjects.map((subject) => [subject.nodeId, subject]));
    for (const item of batch) mergeEnrichment(item, bySubject.get(item.id));
    if (enrichment.status === "partial") failed = true;
  }
  return {
    read: failed
      ? { ...read, items, scope: { ...read.scope, status: "partial", partialReasons: [...read.scope.partialReasons, { kind: "relationship_enrichment_failed" }] } }
      : { ...read, items },
    rateLimit,
  };
}

function addRateLimit(previous: GitHubRateLimit | null, next: GitHubRateLimit): GitHubRateLimit {
  return previous
    ? { cost: previous.cost + next.cost, remaining: next.remaining, resetAt: next.resetAt }
    : next;
}

function mergeEnrichment(item: GitHubWorkItem, subject: RelationshipEnrichmentSubject | undefined) {
  if (!subject) return;
  const type = item.type === "issue" ? "blocker" : "closing_issue";
  item.relationshipCoverage[type] = subject.coverage[type];
  if (subject.coverage[type] === "complete") {
    item.relationships = [
      ...item.relationships.filter((relationship) => relationship.type !== type),
      ...subject.relationships,
    ];
    item.relatedItems = subject.relatedItems;
  }
}

function toTruncatedReason(reasons: SnapshotPartialReason[]): string | null {
  if (reasons.length === 0) {
    return null;
  }
  return [...new Set(reasons.map((reason) => reason.kind))].sort().join(",");
}
