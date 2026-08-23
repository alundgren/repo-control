import type { Cache, CacheItem, PullRequestFacts, SuccessfulSnapshot } from "../cache/index.js";
import type {
  AccountSnapshot,
  GitHubRateLimit,
  GitHubReadClient,
  GitHubReadError,
  GitHubWorkItem,
  SnapshotPartialReason,
  UnavailableRead,
} from "../github/read-client.js";

export type SyncClient = Pick<GitHubReadClient, "readAccountSnapshot">;

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

export function createSyncService({ cache, client }: { cache: Cache; client: SyncClient }): SyncService {
  let inFlight: Promise<SyncOutcome> | null = null;

  return {
    sync() {
      if (inFlight) {
        return inFlight;
      }
      const promise = runSync(cache, client).finally(() => {
        inFlight = null;
      });
      inFlight = promise;
      return promise;
    },
  };
}

async function runSync(cache: Cache, client: SyncClient): Promise<SyncOutcome> {
  const read = await client.readAccountSnapshot();
  return "status" in read ? toFailure(cache, read) : toSuccess(cache, read);
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

function toSuccess(cache: Cache, read: AccountSnapshot): SyncSuccess {
  const snapshot = toSuccessfulSnapshot(read);
  const generationId = cache.replaceActiveSnapshot(snapshot);

  return {
    status: snapshot.scope.truncatedReason === null ? "complete" : "partial",
    generationId,
    fetchedAt: snapshot.fetchedAt,
    scope: snapshot.scope,
    rateLimit: read.rateLimit,
  };
}

function toSuccessfulSnapshot(read: AccountSnapshot): SuccessfulSnapshot {
  return {
    account: read.account,
    fetchedAt: read.fetchedAt,
    repositories: read.repositories,
    items: read.items.map(toCacheItem),
    scope: {
      repositoryLimit: read.scope.repositoryLimit,
      repositoryCount: read.scope.repositoryCount,
      itemLimit: read.scope.itemLimit,
      itemCount: read.scope.itemCount,
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
    updatedAt: item.updatedAt,
    labels: item.labels,
    relationships: item.relationships,
    relationshipCoverage: item.relationshipCoverage,
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

function toTruncatedReason(reasons: SnapshotPartialReason[]): string | null {
  if (reasons.length === 0) {
    return null;
  }
  return [...new Set(reasons.map((reason) => reason.kind))].sort().join(",");
}
