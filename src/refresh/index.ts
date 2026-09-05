import type { Cache, CacheItem, RelatedItemSummary } from "../cache/index.js";
import type { ReconciliationCoordinator } from "../coordination/index.js";
import type {
  GitHubRateLimit,
  GitHubReadClient,
  GitHubReadError,
  GitHubWorkItem,
  RelatedWorkItem,
  RelationshipEnrichmentSubject,
} from "../github/read-client.js";
import { emitLogEvent, type LogEventSink } from "../observability/index.js";

export type RefreshClient = Pick<GitHubReadClient, "readFocusedItem" | "readRelationshipEnrichment">;

export type RefreshOutcome =
  | RefreshUpdated
  | RefreshRemoved
  | { status: "ignored" }
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
  reason: "closed" | "merged" | "repository_not_owned";
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

export type UpsertOutcome =
  | Extract<RefreshOutcome, { status: "updated" }>
  | Extract<RefreshOutcome, { status: "removed" }>
  | { status: "not_found" }
  | { status: "failed"; error: RefreshError; rateLimit: GitHubRateLimit | null };

export type RefreshChange =
  | { status: "updated"; item: CacheItem }
  | { status: "removed"; nodeId: string; repositoryId: string; itemType: CacheItem["type"]; number: number; reason: "issue_closed" | "pull_request_closed" | "pull_request_merged" | "repository_out_of_scope" }
  | { status: "projection_changed" };

export type ItemRefreshService = {
  refreshItem(input: { nodeId: string }): Promise<RefreshOutcome>;
  refreshFromWebhook?(input: { nodeId: string }): Promise<RefreshOutcome>;
  upsertItem?(input: { nodeId: string }): Promise<UpsertOutcome>;
};

export function createItemRefreshService({
  cache,
  client,
  onChange,
  coordinator,
  logEvent,
  now = Date.now,
}: {
  cache: Cache;
  client: RefreshClient;
  onChange?: (change: RefreshChange) => void;
  coordinator?: ReconciliationCoordinator;
  logEvent?: LogEventSink;
  now?: () => number;
}): ItemRefreshService {
  const inFlight = new Map<string, Promise<RefreshOutcome>>();
  const inFlightUpserts = new Map<string, Promise<UpsertOutcome>>();
  const runItem = <T>(operation: () => Promise<T>) => coordinator ? coordinator.runItem(operation) : operation();

  function startRefresh(nodeId: string) {
    const existing = inFlight.get(nodeId);
    if (existing) return existing;
    const startedAt = now();
    const promise = runItem(() => runRefresh(cache, client, nodeId, onChange)).then((outcome) => {
      logRefreshOutcome("refresh", outcome, Math.max(0, now() - startedAt), logEvent);
      return outcome;
    }).catch((error: unknown) => {
      emitLogEvent(logEvent, {
        event: "refresh.finished",
        level: "error",
        status: "failed",
        mode: "refresh",
        durationMs: Math.max(0, now() - startedAt),
        errorCode: "unexpected_failure",
      });
      throw error;
    }).finally(() => {
      inFlight.delete(nodeId);
    });
    inFlight.set(nodeId, promise);
    return promise;
  }

  return {
    refreshItem({ nodeId }) {
      const previous = cache.getItem(nodeId);
      if (previous && cache.isRepositoryIgnored(previous.repositoryId)) {
        const outcome = { status: "ignored" } as const;
        logRefreshOutcome("refresh", outcome, 0, logEvent);
        return Promise.resolve(outcome);
      }
      return startRefresh(nodeId);
    },
    refreshFromWebhook({ nodeId }) {
      return startRefresh(nodeId);
    },
    upsertItem({ nodeId }) {
      const existing = inFlightUpserts.get(nodeId);
      if (existing) return existing;
      const startedAt = now();
      const promise = runItem(() => runUpsert(cache, client, nodeId, onChange)).then((outcome) => {
        logRefreshOutcome("upsert", outcome, Math.max(0, now() - startedAt), logEvent);
        return outcome;
      }).catch((error: unknown) => {
        emitLogEvent(logEvent, {
          event: "refresh.finished",
          level: "error",
          status: "failed",
          mode: "upsert",
          durationMs: Math.max(0, now() - startedAt),
          errorCode: "unexpected_failure",
        });
        throw error;
      }).finally(() => {
        inFlightUpserts.delete(nodeId);
      });
      inFlightUpserts.set(nodeId, promise);
      return promise;
    },
  };
}

function logRefreshOutcome(
  mode: "refresh" | "upsert",
  outcome: RefreshOutcome | UpsertOutcome,
  durationMs: number,
  logEvent?: LogEventSink,
) {
  const errorCode = "error" in outcome ? outcome.error.code : undefined;
  const item = "item" in outcome ? outcome.item : "cachedItem" in outcome ? outcome.cachedItem : null;
  const level = outcome.status === "failed" || outcome.status === "permission_denied" ? "warn" : "info";
  emitLogEvent(logEvent, {
    event: "refresh.finished",
    level,
    status: outcome.status,
    mode,
    durationMs,
    ...(item ? { itemType: item.type } : {}),
    ...("reason" in outcome ? { removalReason: outcome.reason } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...("rateLimit" in outcome ? rateLimitFields(outcome.rateLimit) : {}),
  });
}

function rateLimitFields(rateLimit: GitHubRateLimit | null) {
  return rateLimit
    ? { rateLimitCost: rateLimit.cost, rateLimitRemaining: rateLimit.remaining, rateLimitResetAt: rateLimit.resetAt }
    : {};
}

async function runRefresh(
  cache: Cache,
  client: RefreshClient,
  nodeId: string,
  onChange?: (change: RefreshChange) => void,
): Promise<RefreshOutcome> {
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
    onChange?.({ status: "removed", nodeId, repositoryId: previous.repositoryId, itemType: previous.type, number: previous.number, reason: removalReason(previous.type, read.reason) });
    return { status: "removed", reason: read.reason, rateLimit: read.rateLimit };
  }

  const enrichedType: "blocker" | "closing_issue" = read.item.type === "issue" ? "blocker" : "closing_issue";
  const enrichmentRead = await client.readRelationshipEnrichment({ nodeIds: [nodeId] });
  const subject = enrichmentRead.status === "unavailable" ? undefined : enrichmentRead.subjects[0];

  const relationshipStatus = subject && subject.coverage[enrichedType] === "complete" ? "fresh" : "stale";
  const merged = { ...mergeItem(previous, read.item, enrichedType, subject), observedAt: read.fetchedAt };

  try {
    const repositoryChanged = previous.repositoryId !== merged.repositoryId;
    if (repositoryChanged) {
      if (!read.item.repositoryNameWithOwner || !read.item.repositoryOwnerId) throw new Error("Focused read omitted repository ownership");
      cache.upsertItem(
        merged,
        { id: read.item.repositoryId, nameWithOwner: read.item.repositoryNameWithOwner },
        read.item.repositoryOwnerId,
        read.fetchedAt,
      );
    } else {
      cache.replaceItem(merged, read.fetchedAt);
    }
  } catch {
    return {
      status: "failed",
      error: { code: "cache_write_failed" },
      rateLimit: read.rateLimit,
      cachedItem: previous,
    };
  }

  if (cache.isRepositoryIgnored(merged.repositoryId)) {
    onChange?.({ status: "projection_changed" });
    return { status: "ignored" };
  }
  onChange?.({ status: "updated", item: merged });
  return { status: "updated", item: merged, fetchedAt: read.fetchedAt, relationshipStatus, rateLimit: read.rateLimit };
}

async function runUpsert(
  cache: Cache,
  client: RefreshClient,
  nodeId: string,
  onChange?: (change: RefreshChange) => void,
): Promise<UpsertOutcome> {
  const read = await client.readFocusedItem({ nodeId });
  if (read.status === "unavailable") {
    return { status: "failed", error: read.error, rateLimit: read.rateLimit ?? null };
  }
  if (read.status === "out_of_scope") {
    return { status: "not_found" };
  }
  const enrichedType: "blocker" | "closing_issue" = read.item.type === "issue" ? "blocker" : "closing_issue";
  const enrichmentRead = await client.readRelationshipEnrichment({ nodeIds: [nodeId] });
  const subject = enrichmentRead.status === "unavailable" ? undefined : enrichmentRead.subjects[0];
  const relationshipStatus = subject && subject.coverage[enrichedType] === "complete" ? "fresh" : "stale";
  const item = mergeItem(null, read.item, enrichedType, subject);
  const repositoryNameWithOwner = read.item.repositoryNameWithOwner;
  if (!repositoryNameWithOwner) {
    return { status: "failed", error: { code: "cache_write_failed" }, rateLimit: read.rateLimit };
  }
  try {
    if (!read.item.repositoryOwnerId) return { status: "failed", error: { code: "cache_write_failed" }, rateLimit: read.rateLimit };
    cache.upsertItem(item, { id: read.item.repositoryId, nameWithOwner: repositoryNameWithOwner }, read.item.repositoryOwnerId, read.fetchedAt);
  } catch {
    return { status: "failed", error: { code: "cache_write_failed" }, rateLimit: read.rateLimit };
  }
  onChange?.({ status: "updated", item });
  return { status: "updated", item, fetchedAt: read.fetchedAt, relationshipStatus, rateLimit: read.rateLimit };
}

function removalReason(
  itemType: CacheItem["type"],
  reason: "closed" | "merged" | "repository_not_owned",
): "issue_closed" | "pull_request_closed" | "pull_request_merged" | "repository_out_of_scope" {
  if (reason === "repository_not_owned") return "repository_out_of_scope";
  if (itemType === "pull_request" && reason === "merged") return "pull_request_merged";
  return itemType === "pull_request" ? "pull_request_closed" : "issue_closed";
}

function mergeItem(
  previous: CacheItem | null,
  fresh: GitHubWorkItem,
  enrichedType: "blocker" | "closing_issue",
  subject: RelationshipEnrichmentSubject | undefined,
): CacheItem {
  const relationshipCoverage = { ...(previous?.relationshipCoverage ?? { blocker: "not_sampled", closing_issue: "not_sampled", parent: "not_sampled" }) };
  let relationships = previous?.relationships ?? [];
  if (subject && subject.coverage[enrichedType] === "complete") {
    relationshipCoverage[enrichedType] = subject.coverage[enrichedType];
    relationships = [
      ...relationships.filter((relationship) => relationship.type !== enrichedType),
      ...subject.relationships,
    ];
  }

  const relatedItems: RelatedItemSummary[] | undefined = subject && subject.coverage[enrichedType] === "complete"
    ? mergeRelatedItems(previous?.relatedItems ?? [], subject.relatedItems)
    : previous?.relatedItems;
  const base = {
    id: fresh.id,
    repositoryId: fresh.repositoryId,
    number: fresh.number,
    title: fresh.title,
    body: fresh.bodyExcerpt,
    url: fresh.url,
    createdAt: fresh.createdAt ?? previous?.createdAt ?? null,
    updatedAt: fresh.updatedAt,
    labels: fresh.labels,
    relationships,
    relationshipCoverage,
    ...(relatedItems && relatedItems.length > 0 ? { relatedItems } : {}),
  };

  if (fresh.type === "issue") {
    const subIssues = fresh.subIssues ?? (previous?.type === "issue" ? previous.subIssues : undefined);
    return { ...base, type: "issue", ...(subIssues ? { subIssues } : {}) };
  }
  return { ...base, type: "pull_request", pullRequest: { ...fresh.pullRequest } };
}

function mergeRelatedItems(
  existing: RelatedItemSummary[],
  incoming: RelatedWorkItem[],
): RelatedItemSummary[] {
  const summaries = new Map(existing.map((related) => [related.id, related]));
  for (const related of incoming) {
    summaries.set(related.id, related);
  }
  return [...summaries.values()];
}
