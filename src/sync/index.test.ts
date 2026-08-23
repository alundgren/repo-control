import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openCache } from "../cache/index.js";
import type { AccountSnapshot, AccountSnapshotRead, GitHubWorkItem } from "../github/read-client.js";
import { createSyncService, type SyncClient } from "./index.js";

describe("bounded sampled sync", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("writes a complete snapshot as one generation and reports its scope and rate limit", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      const client = countingClient(async () => accountSnapshot());
      const service = createSyncService({ cache, client });

      await expect(service.sync()).resolves.toMatchObject({
        status: "complete",
        fetchedAt: "2026-08-23T09:00:00.000Z",
        rateLimit: { cost: 12, remaining: 4888, resetAt: "2026-08-23T10:00:00.000Z" },
        scope: { repositoryCount: 1, itemCount: 2, truncatedReason: null },
      });
      expect(client.callCount).toBe(1);
      expect(cache.getActiveSnapshot()).toMatchObject({
        account: { id: "U_fixture", login: "octofixture" },
        items: [{ type: "issue" }, { type: "pull_request", pullRequest: { additions: 21, deletions: 3 } }],
      });
    } finally {
      cache.close();
    }
  });

  it("does not issue one external request per displayed row", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      const client = countingClient(async () => accountSnapshot());
      const service = createSyncService({ cache, client });

      await service.sync();

      expect(client.callCount).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("writes partial data and reports the truncation reason when the sampled scope is bounded", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      const client = countingClient(async () =>
        accountSnapshot({
          scope: {
            repositoryLimit: 50,
            repositoryCount: 50,
            itemLimit: 200,
            itemCount: 200,
            status: "partial",
            partialReasons: [{ kind: "repository_limit" }],
          },
        }),
      );
      const service = createSyncService({ cache, client });

      await expect(service.sync()).resolves.toMatchObject({
        status: "partial",
        scope: { truncatedReason: "repository_limit" },
      });
      expect(cache.getActiveSnapshot()?.scope.truncatedReason).toBe("repository_limit");
    } finally {
      cache.close();
    }
  });

  it("retains the previous active generation and reports its freshness on failure", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      const goodClient = countingClient(async () => accountSnapshot());
      await createSyncService({ cache, client: goodClient }).sync();
      const previousActive = cache.getActiveSnapshot();

      const failingClient = countingClient(async () => ({
        status: "unavailable" as const,
        error: { code: "rate_limited" as const, message: "GitHub rate limit prevented this read.", retryAfterSeconds: 60 },
        rateLimit: { cost: 0, remaining: 0, resetAt: "2026-08-23T11:00:00.000Z" },
      }));
      const service = createSyncService({ cache, client: failingClient });

      await expect(service.sync()).resolves.toEqual({
        status: "failed",
        error: { code: "rate_limited", message: "GitHub rate limit prevented this read.", retryAfterSeconds: 60 },
        rateLimit: { cost: 0, remaining: 0, resetAt: "2026-08-23T11:00:00.000Z" },
        activeSnapshot: { generationId: previousActive?.generationId, fetchedAt: previousActive?.fetchedAt },
      });
      expect(cache.getActiveSnapshot()).toEqual(previousActive);
    } finally {
      cache.close();
    }
  });

  it("reports no previous generation and a null rate limit when the first sync ever fails", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      const client = countingClient(async () => ({
        status: "unavailable" as const,
        error: { code: "unavailable" as const, message: "GitHub work data is unavailable." },
      }));
      const service = createSyncService({ cache, client });

      await expect(service.sync()).resolves.toEqual({
        status: "failed",
        error: { code: "unavailable", message: "GitHub work data is unavailable." },
        rateLimit: null,
        activeSnapshot: null,
      });
      expect(cache.getActiveSnapshot()).toBeNull();
    } finally {
      cache.close();
    }
  });

  it("dedupes concurrent syncs into a single GitHub read", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      let resolveRead!: (value: AccountSnapshotRead) => void;
      const client = countingClient(
        () => new Promise<AccountSnapshotRead>((resolve) => {
          resolveRead = resolve;
        }),
      );
      const service = createSyncService({ cache, client });

      const first = service.sync();
      const second = service.sync();
      resolveRead(accountSnapshot());
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(client.callCount).toBe(1);
      expect(firstResult).toEqual(secondResult);
    } finally {
      cache.close();
    }
  });

  it("issues a fresh GitHub read for a sync started after the previous one settles", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      const client = countingClient(async () => accountSnapshot());
      const service = createSyncService({ cache, client });

      await service.sync();
      await service.sync();

      expect(client.callCount).toBe(2);
    } finally {
      cache.close();
    }
  });

  async function createCachePath() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-sync-"));
    temporaryDirectories.push(directory);
    return join(directory, "cache.sqlite");
  }
});

function countingClient(readAccountSnapshot: () => Promise<AccountSnapshotRead>): SyncClient & { callCount: number } {
  const client = {
    callCount: 0,
    async readAccountSnapshot() {
      client.callCount += 1;
      return readAccountSnapshot();
    },
  };
  return client;
}

function accountSnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    account: { id: "U_fixture", login: "octofixture" },
    fetchedAt: "2026-08-23T09:00:00.000Z",
    rateLimit: { cost: 12, remaining: 4888, resetAt: "2026-08-23T10:00:00.000Z" },
    repositories: [{ id: "R_fixture", nameWithOwner: "octofixture/example-widgets" }],
    items: [issueItem(), pullRequestItem()],
    scope: {
      repositoryLimit: 50,
      repositoryCount: 1,
      itemLimit: 200,
      itemCount: 2,
      status: "complete",
      partialReasons: [],
    },
    ...overrides,
  };
}

function issueItem(): GitHubWorkItem {
  return {
    id: "I_fixture_1",
    repositoryId: "R_fixture",
    number: 17,
    title: "Fix the fixture",
    bodyExcerpt: "A fictional issue body",
    url: "https://example.test/octofixture/example-widgets/issues/17",
    updatedAt: "2026-08-22T09:00:00.000Z",
    labels: [{ id: "L_ready", name: "ready-for-agent" }],
    relationships: [],
    relationshipCoverage: { blocker: "unavailable", parent: "unavailable", closing_issue: "unavailable" },
    type: "issue",
  };
}

function pullRequestItem(): GitHubWorkItem {
  return {
    id: "PR_fixture_1",
    repositoryId: "R_fixture",
    number: 18,
    title: "Ship the fixture",
    bodyExcerpt: "A fictional pull-request body",
    url: "https://example.test/octofixture/example-widgets/pull/18",
    updatedAt: "2026-08-22T09:30:00.000Z",
    labels: [],
    relationships: [],
    relationshipCoverage: { blocker: "unavailable", parent: "unavailable", closing_issue: "unavailable" },
    type: "pull_request",
    pullRequest: { isDraft: false, changedFiles: 4, additions: 21, deletions: 3 },
  };
}
