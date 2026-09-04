import { describe, expect, it, vi } from "vitest";

import type { Cache } from "../cache/index.js";
import type { ItemRefreshService } from "../refresh/index.js";
import {
  createReviewSubmissionService,
  GITHUB_WRITE_ACTIONS_CONFIGURATION_MESSAGE,
  readGitHubWriteActions,
} from "./index.js";

describe("review submission", () => {
  it("parses the operator allow-list and rejects unknown actions", () => {
    expect([...readGitHubWriteActions({})]).toEqual([]);
    expect([...readGitHubWriteActions({ REPO_CONTROL_GITHUB_WRITE_ACTIONS: " review, merge " })]).toEqual(["review", "merge"]);
    expect(() => readGitHubWriteActions({ REPO_CONTROL_GITHUB_WRITE_ACTIONS: "review,delete" })).toThrow(GITHUB_WRITE_ACTIONS_CONFIGURATION_MESSAGE);
  });

  it("rechecks the head, submits once, and focused-refreshes after success", async () => {
    const write = vi.fn().mockResolvedValue({ status: "submitted", reviewUrl: null });
    const refresh = vi.fn().mockResolvedValue({ status: "not_found" });
    const service = createReviewSubmissionService({
      cache: cache(),
      readClient: { readPullRequestHead: vi.fn().mockResolvedValue({ status: "read", headSha: "head-one", rateLimit: rateLimit() }) },
      writeClient: { addPullRequestReview: write },
      refreshService: { refreshItem: refresh } as ItemRefreshService,
      enabled: true,
    });
    const comments = [
      { path: "src/first.ts", line: 2, side: "RIGHT" as const, body: "Use the fictional helper." },
      { path: "src/second.ts", line: 4, side: "LEFT" as const, body: "Keep this check." },
    ];

    await expect(service.submit({ nodeId: "PR_1", expectedHeadSha: "head-one", event: "COMMENT", comments }))
      .resolves.toMatchObject({ status: "submitted", refresh: { status: "not_found" } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ pullRequestId: "PR_1", expectedHeadSha: "head-one", comments }));
    expect(refresh).toHaveBeenCalledWith({ nodeId: "PR_1" });
  });

  it("blocks a changed head and leaves GitHub untouched", async () => {
    const write = vi.fn();
    const service = createReviewSubmissionService({
      cache: cache(),
      readClient: { readPullRequestHead: vi.fn().mockResolvedValue({ status: "read", headSha: "head-two", rateLimit: rateLimit() }) },
      writeClient: { addPullRequestReview: write },
      refreshService: { refreshItem: vi.fn() } as unknown as ItemRefreshService,
      enabled: true,
    });

    await expect(service.submit({
      nodeId: "PR_1",
      expectedHeadSha: "head-one",
      event: "COMMENT",
      comments: [{ path: "src/first.ts", line: 2, side: "RIGHT", body: "Keep this draft." }],
    })).resolves.toEqual({ status: "head_changed", currentHeadSha: "head-two" });
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps confirmed submission authoritative when focused refresh rejects", async () => {
    const write = vi.fn().mockResolvedValue({ status: "submitted", reviewUrl: null });
    const service = createReviewSubmissionService({
      cache: cache(),
      readClient: { readPullRequestHead: vi.fn().mockResolvedValue({ status: "read", headSha: "head-one", rateLimit: rateLimit() }) },
      writeClient: { addPullRequestReview: write },
      refreshService: { refreshItem: vi.fn().mockRejectedValue(new Error("refresh failed")) } as ItemRefreshService,
      enabled: true,
    });

    await expect(service.submit({
      nodeId: "PR_1",
      expectedHeadSha: "head-one",
      event: "APPROVE",
      comments: [],
    })).resolves.toEqual({ status: "submitted", reviewUrl: null, refresh: null });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("requires content for comments and requests, while allowing an empty approval", async () => {
    const write = vi.fn().mockResolvedValue({ status: "submitted", reviewUrl: null });
    const service = createReviewSubmissionService({
      cache: cache(),
      readClient: { readPullRequestHead: vi.fn().mockResolvedValue({ status: "read", headSha: "head-one", rateLimit: rateLimit() }) },
      writeClient: { addPullRequestReview: write },
      refreshService: { refreshItem: vi.fn().mockResolvedValue({ status: "not_found" }) } as ItemRefreshService,
      enabled: true,
    });

    await expect(service.submit({ nodeId: "PR_1", expectedHeadSha: "head-one", event: "COMMENT", comments: [] })).resolves.toEqual({ status: "invalid" });
    await expect(service.submit({ nodeId: "PR_1", expectedHeadSha: "head-one", event: "REQUEST_CHANGES", summary: "   ", comments: [] })).resolves.toEqual({ status: "invalid" });
    await expect(service.submit({ nodeId: "PR_1", expectedHeadSha: "head-one", event: "APPROVE", comments: [] })).resolves.toMatchObject({ status: "submitted" });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

function cache(): Cache {
  return {
    getItem: () => ({ id: "PR_1", type: "pull_request", repositoryId: "R_1", number: 7 }),
    getActiveSnapshot: () => ({ repositories: [{ id: "R_1", nameWithOwner: "fictional-tools/garden" }] }),
  } as unknown as Cache;
}

function rateLimit() {
  return { cost: 1, remaining: 4999, resetAt: "2026-09-03T20:00:00.000Z" };
}
