import Database from "better-sqlite3";

import type { Cache, CacheItem, RelatedItemSummary } from "../cache/index.js";
import type {
  GitHubRateLimit,
  GitHubReadClient,
  GitHubReadError,
  GitHubWorkItem,
  RelationshipEnrichmentSubject,
} from "../github/read-client.js";

export type RefreshClient = Pick<GitHubReadClient, "readFocusedItem" | "readRelationshipEnrichment">;

export type RefreshOutcome =
  | RefreshUpdated
  | RefreshRemoved
  | RefreshNotFound
  | RefreshPermissionDenied
  | RefreshFailed;

export type RefreshUpdated = {
  status: "updated";
  item: CacheItem;
  fetchedAt: string;
  relationshipStatus: "fresh" | "stale";
  rateLimit: GitHubRateLimit;
};

export type RefreshRemoved = {
  status: "removed";
  reason: "closed" | "repository_not_owned";
  rateLimit: GitHubRateLimit;
};

export type RefreshNotFound = {
  status: "not_found";
};

export type RefreshPermissionDenied = {
  status: "permission_denied";
  error: GitHubReadError;
  rateLimit: GitHubRateLimit | null;
  cachedItem: CacheItem;
};

export type RefreshError = GitHubReadError | { code: "cache_write_failed" };

export type RefreshFailed = {
  status: "failed";
  error: RefreshError;
  rateLimit: GitHubRateLimit | null;
  cachedItem: CacheItem;
};

export type ItemRefreshService = {
  refreshItem(input: { nodeId: string }): Promise<RefreshOutcome>;
};

export function createItemRefreshService({ cache, client }: { cache: Cache; client: RefreshClient }): ItemRefreshService {
  const inFlight = new Map<string, Promise<RefreshOutcome>>();

  return {
    refreshItem({ nodeId }) {
      const existing = inFlight.get(nodeId);
      if (existing) {
        return existing;
      }
      const promise = runRefresh(cache, client, nodeId).finally(() => {
        inFlight.delete(nodeId);
      });
      inFlight.set(nodeId, promise);
      return promise;
    },
  };
}

async function runRefresh(cache: Cache, client: RefreshClient, nodeId: string): Promise<RefreshOutcome> {
  const previous = cache.getItem(nodeId);
  if (!previous) {
    return { status: "not_found" };
  }

  const read = await client.readFocusedItem({ nodeId });

  if (read.status === "unavailable") {
    return read.error.code === "authentication_failed"
      ? { status: "permission_denied", error: read.error, rateLimit: read.rateLimit ?? null, cachedItem: previous }
      : { status: "failed", error: read.error, rateLimit: read.rateLimit ?? null, cachedItem: previous };
  }

  if (read.status === "out_of_scope") {
    cache.removeItem(nodeId);
    return { status: "removed", reason: read.reason, rateLimit: read.rateLimit };
  }

  const enrichedType: "blocker" | "closing_issue" = read.item.type === "issue" ? "blocker" : "closing_issue";
  const enrichmentRead = await client.readRelationshipEnrichment({ nodeIds: [nodeId] });
  const subject = enrichmentRead.status === "unavailable" ? undefined : enrichmentRead.subjects[0];

  const relationshipStatus = subject && subject.coverage[enrichedType] === "complete" ? "fresh" : "stale";
  const merged = { ...mergeItem(previous, read.item, enrichedType, subject), observedAt: read.fetchedAt };

  try {
    cache.replaceItem(merged, read.fetchedAt);
  } catch (error) {
    if (!(error instanceof Database.SqliteError && error.code.startsWith("SQLITE_CONSTRAINT"))) {
      throw error;
    }
    return {
      status: "failed",
      error: { code: "cache_write_failed" },
      rateLimit: read.rateLimit,
      cachedItem: previous,
    };
  }

  return { status: "updated", item: merged, fetchedAt: read.fetchedAt, relationshipStatus, rateLimit: read.rateLimit };
}

function mergeItem(
  previous: CacheItem,
  fresh: GitHubWorkItem,
  enrichedType: "blocker" | "closing_issue",
  subject: RelationshipEnrichmentSubject | undefined,
): CacheItem {
  const relationshipCoverage = { ...previous.relationshipCoverage };
  let relationships = previous.relationships;
  if (subject && subject.coverage[enrichedType] === "complete") {
    relationshipCoverage[enrichedType] = subject.coverage[enrichedType];
    relationships = [
      ...previous.relationships.filter((relationship) => relationship.type !== enrichedType),
      ...subject.relationships,
    ];
  }

  const relatedItems: RelatedItemSummary[] | undefined = subject && subject.coverage[enrichedType] === "complete"
    ? subject.relatedItems
    : undefined;
  const base = {
    id: fresh.id,
    repositoryId: fresh.repositoryId,
    number: fresh.number,
    title: fresh.title,
    body: fresh.bodyExcerpt,
    url: fresh.url,
    createdAt: fresh.createdAt ?? previous.createdAt ?? null,
    updatedAt: fresh.updatedAt,
    labels: fresh.labels,
    relationships,
    relationshipCoverage,
    ...(relatedItems ? { relatedItems } : {}),
  };

  if (fresh.type === "issue") {
    return { ...base, type: "issue" };
  }
  return { ...base, type: "pull_request", pullRequest: { ...fresh.pullRequest } };
}
