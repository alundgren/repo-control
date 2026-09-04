import { describe, expect, it, vi } from "vitest";

import type { Cache } from "../cache/index.js";
import type { PullRequestMergeFacts } from "../github/read-client.js";
import type { ItemRefreshService } from "../refresh/index.js";
import { classifyMergeReadiness, createPullRequestMergeService } from "./index.js";

describe("pull request merge", () => {
  it.each([
    ["draft", { isDraft: true }, { status: "blocked", reason: "draft" }],
    ["conflicts", { mergeable: "CONFLICTING" }, { status: "blocked", reason: "conflicts" }],
    ["failed checks", { checksState: "FAILURE" }, { status: "blocked", reason: "failed_checks" }],
    ["missing reviews", { protection: { ...protection(), requiresApprovingReviews: true }, reviewDecision: "REVIEW_REQUIRED" }, { status: "blocked", reason: "missing_reviews" }],
    ["repository rules", { mergeStateStatus: "BLOCKED" }, { status: "blocked", reason: "repository_rules" }],
    ["required base update", { mergeStateStatus: "BEHIND", protection: { ...protection(), requiresStrictStatusChecks: true } }, { status: "blocked", reason: "base_update_required" }],
    ["merge queue", { isMergeQueueEnabled: true }, { status: "blocked", reason: "merge_queue" }],
    ["disabled squash merging", { squashMergeAllowed: false }, { status: "blocked", reason: "squash_disabled" }],
  ] as const)("names the %s block", (_name, changes, expected) => {
    expect(classifyMergeReadiness({ ...facts(), ...changes } as PullRequestMergeFacts)).toEqual(expected);
  });

  it("maps pending checks, unknown mergeability, permission, merged, and ready states", () => {
    expect(classifyMergeReadiness({ ...facts(), checksState: "PENDING" })).toEqual({ status: "checks_pending" });
    expect(classifyMergeReadiness({ ...facts(), mergeable: "UNKNOWN" })).toEqual({ status: "checking" });
    expect(classifyMergeReadiness({ ...facts(), viewerPermission: "READ" })).toEqual({ status: "not_permitted" });
    expect(classifyMergeReadiness({ ...facts(), merged: true })).toEqual({ status: "merged" });
    expect(classifyMergeReadiness(facts())).toEqual({ status: "ready", headSha: "head-one", sourceBranch: "fictional-branch" });
  });

  it("rereads current facts and passes the reviewed SHA to one squash merge before refreshing", async () => {
    const read = vi.fn().mockResolvedValue(readFacts());
    const write = vi.fn().mockResolvedValue({ status: "merged" });
    const refresh = vi.fn().mockResolvedValue({ status: "not_found" });
    const events: Array<Record<string, unknown>> = [];
    const service = createPullRequestMergeService({
      cache: cache(),
      readClient: { readPullRequestMergeFacts: read },
      writeClient: { mergePullRequest: write },
      refreshService: { refreshItem: refresh } as ItemRefreshService,
      enabled: true,
      logEvent: (event) => events.push(event),
    });

    await expect(service.merge({ nodeId: "PR_1", expectedHeadSha: "head-one" })).resolves.toEqual({ status: "merged", refresh: { status: "not_found" }, alreadyMerged: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ pullRequestId: "PR_1" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ repositoryNameWithOwner: "fictional-tools/garden", number: 7, expectedHeadSha: "head-one" });
    expect(refresh).toHaveBeenCalledWith({ nodeId: "PR_1" });
    expect(events).toEqual([expect.objectContaining({ event: "pull_request.merge.finished", status: "merged", refreshStatus: "not_found" })]);
    expect(events[0]).not.toHaveProperty("sourceBranch");
    expect(events[0]).not.toHaveProperty("error");
  });

  it("does not merge when the immediate reread finds a moved head", async () => {
    const write = vi.fn();
    const service = createPullRequestMergeService({
      cache: cache(),
      readClient: { readPullRequestMergeFacts: vi.fn().mockResolvedValue(readFacts({ headSha: "head-two" })) },
      writeClient: { mergePullRequest: write },
      refreshService: { refreshItem: vi.fn() } as unknown as ItemRefreshService,
      enabled: true,
    });

    await expect(service.merge({ nodeId: "PR_1", expectedHeadSha: "head-one" })).resolves.toEqual({ status: "failed", reason: "validation", currentHeadSha: "head-two" });
    expect(write).not.toHaveBeenCalled();
  });

  it("focused-refreshes an already merged pull request without making a write", async () => {
    const write = vi.fn();
    const refresh = vi.fn().mockResolvedValue({ status: "not_found" });
    const service = createPullRequestMergeService({
      cache: cache(),
      readClient: { readPullRequestMergeFacts: vi.fn().mockResolvedValue(readFacts({ merged: true })) },
      writeClient: { mergePullRequest: write },
      refreshService: { refreshItem: refresh } as ItemRefreshService,
      enabled: true,
    });

    await expect(service.merge({ nodeId: "PR_1", expectedHeadSha: "head-one" })).resolves.toEqual({
      status: "merged",
      refresh: { status: "not_found" },
      alreadyMerged: true,
    });
    expect(write).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps an unavailable read out of ready and does not retry an ambiguous write", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: "unavailable", error: { code: "unavailable", message: "Unavailable." } })
      .mockResolvedValueOnce(readFacts());
    const write = vi.fn().mockResolvedValue({ status: "unknown" });
    const service = createPullRequestMergeService({
      cache: cache(),
      readClient: { readPullRequestMergeFacts: read },
      writeClient: { mergePullRequest: write },
      refreshService: { refreshItem: vi.fn() } as unknown as ItemRefreshService,
      enabled: true,
    });

    await expect(service.read("PR_1")).resolves.toEqual({ status: "unavailable" });
    await expect(service.merge({ nodeId: "PR_1", expectedHeadSha: "head-one" })).resolves.toEqual({ status: "failed", reason: "ambiguous" });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

function facts(): PullRequestMergeFacts {
  return {
    headSha: "head-one",
    headRefName: "fictional-branch",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    isMergeQueueEnabled: false,
    squashMergeAllowed: true,
    viewerPermission: "WRITE",
    checksState: "SUCCESS",
    protection: protection(),
  };
}

function protection() {
  return {
    requiresApprovingReviews: false,
    requiredApprovingReviewCount: 0,
    requiresStatusChecks: false,
    requiresStrictStatusChecks: false,
    requiresConversationResolution: false,
  };
}

function readFacts(changes: Partial<PullRequestMergeFacts> = {}) {
  return { status: "read" as const, facts: { ...facts(), ...changes }, rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-04T20:00:00.000Z" } };
}

function cache(): Cache {
  return {
    getItem: () => ({ id: "PR_1", type: "pull_request", repositoryId: "R_1", number: 7 }),
    getActiveSnapshot: () => ({ repositories: [{ id: "R_1", nameWithOwner: "fictional-tools/garden" }] }),
  } as unknown as Cache;
}
