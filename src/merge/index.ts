import type { Cache } from "../cache/index.js";
import type { GitHubReadClient, PullRequestMergeFacts } from "../github/read-client.js";
import type { GitHubWriteClient } from "../github/write-client.js";
import { emitLogEvent, type LogEventSink } from "../observability/index.js";
import type { ItemRefreshService, RefreshOutcome } from "../refresh/index.js";

export type MergeBlockedReason =
  | "draft"
  | "conflicts"
  | "failed_checks"
  | "missing_reviews"
  | "repository_rules"
  | "base_update_required"
  | "merge_queue"
  | "squash_disabled";

export type MergeReadiness =
  | { status: "checking" }
  | { status: "ready"; headSha: string; sourceBranch: string }
  | { status: "checks_pending" }
  | { status: "blocked"; reason: MergeBlockedReason }
  | { status: "not_permitted" }
  | { status: "merged" }
  | { status: "unavailable" };

export type MergeOutcome =
  | { status: "merged"; refresh: RefreshOutcome | null; alreadyMerged: boolean }
  | { status: "failed"; reason: "permission" | "policy" | "validation" | "ambiguous"; currentHeadSha?: string }
  | Exclude<MergeReadiness, { status: "ready" } | { status: "merged" }>;

export type PullRequestMergeService = {
  enabled: boolean;
  read(nodeId: string): Promise<MergeReadiness>;
  merge(input: { nodeId: string; expectedHeadSha: string }): Promise<MergeOutcome>;
};

export function createPullRequestMergeService({
  cache,
  readClient,
  writeClient,
  refreshService,
  enabled,
  logEvent,
  now = Date.now,
}: {
  cache: Cache;
  readClient: Pick<GitHubReadClient, "readPullRequestMergeFacts">;
  writeClient: Pick<GitHubWriteClient, "mergePullRequest">;
  refreshService: ItemRefreshService;
  enabled: boolean;
  logEvent?: LogEventSink;
  now?: () => number;
}): PullRequestMergeService {
  async function read(nodeId: string): Promise<MergeReadiness> {
    if (!enabled) return { status: "not_permitted" };
    const target = findTarget(cache, nodeId);
    if (!target) return { status: "unavailable" };
    const result = await readClient.readPullRequestMergeFacts({ pullRequestId: nodeId });
    return result.status === "read" ? classifyMergeReadiness(result.facts) : { status: "unavailable" };
  }

  return {
    enabled,
    read,
    async merge(input) {
      const startedAt = now();
      const finish = <Outcome extends MergeOutcome>(outcome: Outcome): Outcome => {
        emitLogEvent(logEvent, {
          event: "pull_request.merge.finished",
          level: outcome.status === "merged" ? "info" : outcome.status === "failed" && outcome.reason === "ambiguous" ? "error" : "warn",
          status: outcome.status,
          reason: "reason" in outcome ? outcome.reason : undefined,
          durationMs: Math.max(0, now() - startedAt),
          refreshStatus: outcome.status === "merged" ? outcome.refresh?.status ?? "failed" : undefined,
        });
        return outcome;
      };
      if (!enabled || !isExpectedHead(input.expectedHeadSha)) return finish({ status: "failed", reason: "validation" });
      const target = findTarget(cache, input.nodeId);
      if (!target) return finish({ status: "failed", reason: "validation" });

      const current = await readClient.readPullRequestMergeFacts({ pullRequestId: input.nodeId });
      if (current.status !== "read") return finish({ status: "unavailable" });
      const readiness = classifyMergeReadiness(current.facts);
      if (readiness.status === "merged") {
        const refresh = await refreshService.refreshItem({ nodeId: input.nodeId }).catch(() => null);
        return finish({ status: "merged", refresh, alreadyMerged: true });
      }
      if (readiness.status !== "ready") return finish(readiness);
      if (readiness.headSha !== input.expectedHeadSha) {
        return finish({ status: "failed", reason: "validation", currentHeadSha: readiness.headSha });
      }

      const result = await writeClient.mergePullRequest({
        repositoryNameWithOwner: target.repositoryNameWithOwner,
        number: target.number,
        expectedHeadSha: input.expectedHeadSha,
      });
      if (result.status !== "merged") {
        const reason = result.status === "not_permitted" ? "permission"
          : result.status === "head_changed" ? "validation"
            : result.status === "rejected" ? "policy"
              : "ambiguous";
        return finish({ status: "failed", reason });
      }
      const refresh = await refreshService.refreshItem({ nodeId: input.nodeId }).catch(() => null);
      return finish({ status: "merged", refresh, alreadyMerged: false });
    },
  };
}

export function classifyMergeReadiness(facts: PullRequestMergeFacts): MergeReadiness {
  if (facts.merged) return { status: "merged" };
  if (!canMerge(facts.viewerPermission)) return { status: "not_permitted" };
  if (facts.isDraft || facts.mergeStateStatus === "DRAFT") return { status: "blocked", reason: "draft" };
  if (facts.isMergeQueueEnabled) return { status: "blocked", reason: "merge_queue" };
  if (!facts.squashMergeAllowed) return { status: "blocked", reason: "squash_disabled" };
  if (facts.mergeable === "CONFLICTING" || facts.mergeStateStatus === "DIRTY") return { status: "blocked", reason: "conflicts" };
  if (facts.mergeable === "UNKNOWN" || facts.mergeStateStatus === "UNKNOWN") return { status: "checking" };
  if (facts.checksState === "PENDING" || facts.checksState === "EXPECTED" || (facts.protection?.requiresStatusChecks && facts.checksState === null)) {
    return { status: "checks_pending" };
  }
  if (facts.checksState === "ERROR" || facts.checksState === "FAILURE") return { status: "blocked", reason: "failed_checks" };
  if (facts.protection?.requiresApprovingReviews && facts.reviewDecision !== "APPROVED") {
    return { status: "blocked", reason: "missing_reviews" };
  }
  if (facts.mergeStateStatus === "BEHIND" && facts.protection?.requiresStrictStatusChecks) {
    return { status: "blocked", reason: "base_update_required" };
  }
  if (facts.mergeStateStatus === "BLOCKED" || facts.mergeStateStatus === "HAS_HOOKS" || facts.mergeStateStatus === "UNSTABLE") {
    return { status: "blocked", reason: "repository_rules" };
  }
  if (facts.mergeable !== "MERGEABLE") return { status: "checking" };
  return { status: "ready", headSha: facts.headSha, sourceBranch: facts.headRefName };
}

function findTarget(cache: Cache, nodeId: string) {
  const item = cache.getItem(nodeId);
  if (!item || item.type !== "pull_request") return null;
  const repository = cache.getActiveSnapshot()?.repositories.find((entry) => entry.id === item.repositoryId);
  return repository ? { number: item.number, repositoryNameWithOwner: repository.nameWithOwner } : null;
}

function canMerge(permission: PullRequestMergeFacts["viewerPermission"]): boolean {
  return permission === "WRITE" || permission === "MAINTAIN" || permission === "ADMIN";
}

function isExpectedHead(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}
