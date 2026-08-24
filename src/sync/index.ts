import type { Cache, CacheItem, PullRequestFacts, SuccessfulSnapshot } from "../cache/index.js";
import type { ReconciliationCoordinator } from "../coordination/index.js";
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
import { emitLogEvent, type LogEventSink } from "../observability/index.js";
import type { WebhookProvisioner } from "../webhook/provisioning.js";

export const FULL_RECONCILIATION_INTERVAL_HOURS = 24;

export type SyncClient = Pick<GitHubReadClient, "readAccountSnapshot" | "readRelationshipEnrichment" | "readOwnedRepositoryInventory">;

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
  coordinator,
  onComplete,
  webhookProvisioner,
  logEvent,
}: {
  cache: Cache;
  client: SyncClient;
  now?: () => number;
  coordinator?: ReconciliationCoordinator;
  onComplete?: () => void;
  webhookProvisioner?: WebhookProvisioner;
  logEvent?: LogEventSink;
}): SyncService {
  let inFlight: Promise<SyncOutcome> | null = null;

  return {
    sync() {
      if (inFlight) {
        return inFlight;
      }
      const startedAt = now();
      const operation = () => runSync(cache, client, now);
      const promise = (coordinator ? coordinator.runSync(operation) : operation()).then(async (outcome) => {
        if (outcome.status !== "failed") {
          await reconcileWebhookProvisioning(cache, client, webhookProvisioner, logEvent);
        }
        logSyncOutcome(outcome, Math.max(0, now() - startedAt), logEvent);
        if (outcome.status === "complete" && outcome.scope.reconciliation === "full" && outcome.scope.inventoryComplete === true) {
          try {
            onComplete?.();
          } catch {
            // Ledger cleanup must not turn a successful cache sync into a failed sync.
          }
        }
        return outcome;
      }).catch((error: unknown) => {
        emitLogEvent(logEvent, {
          event: "sync.finished",
          level: "error",
          status: "failed",
          durationMs: Math.max(0, now() - startedAt),
          errorCode: "unexpected_failure",
        });
        throw error;
      }).finally(() => {
        inFlight = null;
      });
      inFlight = promise;
      return promise;
    },
  };
}

async function reconcileWebhookProvisioning(cache: Cache, client: SyncClient, provisioner: WebhookProvisioner | undefined, logEvent: LogEventSink | undefined) {
  if (!provisioner || !client.readOwnedRepositoryInventory) return;
  try {
    const inventory = await client.readOwnedRepositoryInventory();
    if ("status" in inventory) {
      emitLogEvent(logEvent, { event: "webhook.provisioning.finished", level: "warn", status: "skipped", errorCode: "inventory_unavailable" });
      return;
    }
    const summary = await provisioner.reconcile(inventory);
    if (summary.created > 0) cache.clearActiveGenerationLastFullReconciledAt();
    emitLogEvent(logEvent, {
      event: "webhook.provisioning.finished",
      level: summary.failed > 0 ? "warn" : "info",
      status: "complete",
      eligibleCount: summary.eligible,
      createdCount: summary.created,
      alreadyPresentCount: summary.alreadyPresent,
      failedCount: summary.failed,
      errorCode: summary.failed > 0 ? "repository_provisioning_failed" : undefined,
    });
  } catch {
    emitLogEvent(logEvent, { event: "webhook.provisioning.finished", level: "warn", status: "skipped", errorCode: "provisioning_failed" });
  }
}

function logSyncOutcome(outcome: SyncOutcome, durationMs: number, logEvent?: LogEventSink) {
  if (outcome.status === "failed") {
    emitLogEvent(logEvent, {
      event: "sync.finished",
      level: "warn",
      status: "failed",
      durationMs,
      errorCode: outcome.error.code,
      hasActiveSnapshot: outcome.activeSnapshot !== null,
      ...rateLimitFields(outcome.rateLimit),
    });
    return;
  }
  emitLogEvent(logEvent, {
    event: "sync.finished",
    level: outcome.status === "partial" ? "warn" : "info",
    status: outcome.status,
    durationMs,
    reconciliation: outcome.scope.reconciliation,
    inventoryComplete: outcome.scope.inventoryComplete,
    repositoryCount: outcome.scope.repositoryCount,
    itemCount: outcome.scope.itemCount,
    truncatedReason: outcome.scope.truncatedReason,
    generationId: outcome.generationId,
    ...rateLimitFields(outcome.rateLimit),
  });
}

function rateLimitFields(rateLimit: GitHubRateLimit | null) {
  return rateLimit
    ? { rateLimitCost: rateLimit.cost, rateLimitRemaining: rateLimit.remaining, rateLimitResetAt: rateLimit.resetAt }
    : {};
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
