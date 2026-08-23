import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openCache, type Cache, type CacheItem, type SuccessfulSnapshot } from "../cache/index.js";
import type { RefreshOutcome } from "../refresh/index.js";
import type { SyncOutcome } from "../sync/index.js";
import { buildOverview, toItemRefreshResponse, toSyncResponse } from "./read-models.js";

describe("api read models", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  describe("buildOverview", () => {
    it("reports no data yet when the cache has never synced", async () => {
      const cache = await freshCache();
      try {
        expect(buildOverview(cache)).toEqual({ status: "empty" });
      } finally {
        cache.close();
      }
    });

    it("groups issues into queues ordered by readiness band then oldest-updated first, with queues sorted by name", async () => {
      const cache = await freshCache();
      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });
        cache.replaceActiveSnapshot(
          snapshot({
            items: [
              issue({ id: "I_agent_new", labels: ["ready-for-agent"], updatedAt: "2026-08-24T10:00:00.000Z" }),
              issue({ id: "I_agent_old", labels: ["ready-for-agent"], updatedAt: "2026-08-20T10:00:00.000Z" }),
              issue({ id: "I_triage", labels: [] }),
            ],
          }),
        );

        const overview = buildOverview(cache);
        if (overview.status !== "ready") {
          throw new Error("expected a ready overview");
        }

        expect(overview.queues.map((queue) => queue.name)).toEqual(["agent", "triage"]);
        expect(overview.queues[0]?.issues.map((issueRead) => issueRead.id)).toEqual([
          "I_agent_old",
          "I_agent_new",
        ]);
      } finally {
        cache.close();
      }
    });

    it("keeps a configured queue in the response even when nothing is currently in it", async () => {
      const cache = await freshCache();
      try {
        cache.replaceQueueMapping({
          defaultQueue: "triage",
          labels: [
            { label: "ready-for-agent", queue: "agent" },
            { label: "needs-review", queue: "human" },
          ],
        });
        cache.replaceActiveSnapshot(snapshot({ items: [issue({ id: "I_agent", labels: ["ready-for-agent"] })] }));

        const overview = buildOverview(cache);
        if (overview.status !== "ready") {
          throw new Error("expected a ready overview");
        }

        // cache.getQueueMapping() returns labels ordered by label name (see src/cache/index.ts),
        // so queue order follows that, with the default queue appended last.
        expect(overview.queues).toEqual([
          { name: "human", issues: [] },
          { name: "agent", issues: [expect.objectContaining({ id: "I_agent" })] },
          { name: "triage", issues: [] },
        ]);
      } finally {
        cache.close();
      }
    });

    it("lists pull requests separately from queues, without a queue or readiness field", async () => {
      const cache = await freshCache();
      try {
        cache.replaceActiveSnapshot(snapshot({ items: [pullRequest({ id: "PR_1" })] }));

        const overview = buildOverview(cache);
        if (overview.status !== "ready") {
          throw new Error("expected a ready overview");
        }

        expect(overview.queues).toEqual([{ name: "triage", issues: [] }]);
        expect(overview.pullRequests).toEqual([
          {
            id: "PR_1",
            type: "pull_request",
            repositoryId: "R_repo_1",
            number: 17,
            title: "Fictional title",
            excerpt: "Fictional body",
            url: "https://github.test/fictional/pull/17",
            updatedAt: "2026-08-23T10:00:00.000Z",
            isDraft: false,
            additions: 4,
            deletions: 1,
          },
        ]);
      } finally {
        cache.close();
      }
    });

    it("resolves a known blocker to its cached summary and marks a missing blocker id explicitly", async () => {
      const cache = await freshCache();
      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });
        cache.replaceActiveSnapshot(
          snapshot({
            items: [
              issue({
                id: "I_blocked",
                labels: ["ready-for-agent"],
                relationships: [
                  { sourceId: "I_blocked", targetId: "I_known_blocker", type: "blocker" },
                  { sourceId: "I_blocked", targetId: "I_missing_blocker", type: "blocker" },
                ],
              }),
              issue({ id: "I_known_blocker", labels: [] }),
            ],
          }),
        );

        const overview = buildOverview(cache);
        if (overview.status !== "ready") {
          throw new Error("expected a ready overview");
        }
        const blocked = overview.queues.flatMap((queue) => queue.issues).find((item) => item.id === "I_blocked");

        expect(blocked?.readiness).toEqual({
          kind: "blocked",
          blockers: [
            {
              status: "known",
              id: "I_known_blocker",
              repositoryId: "R_repo_1",
              number: 17,
              title: "Fictional title",
              url: "https://github.test/fictional/issues/17",
            },
            { status: "unknown", id: "I_missing_blocker" },
          ],
        });
      } finally {
        cache.close();
      }
    });

    it("exposes only the purpose-built issue and pull-request fields, nothing else from the cache row", async () => {
      const cache = await freshCache();
      try {
        cache.replaceActiveSnapshot(
          snapshot({ items: [issue({ id: "I_issue", labels: [] }), pullRequest({ id: "PR_1" })] }),
        );

        const overview = buildOverview(cache);
        if (overview.status !== "ready") {
          throw new Error("expected a ready overview");
        }
        const [issueRead] = overview.queues.flatMap((queue) => queue.issues);
        const [pullRequestRead] = overview.pullRequests;

        expect(Object.keys(issueRead!).sort()).toEqual(
          ["excerpt", "id", "number", "queue", "readiness", "repositoryId", "title", "type", "updatedAt", "url"].sort(),
        );
        expect(Object.keys(pullRequestRead!).sort()).toEqual(
          [
            "additions",
            "deletions",
            "excerpt",
            "id",
            "isDraft",
            "number",
            "repositoryId",
            "title",
            "type",
            "updatedAt",
            "url",
          ].sort(),
        );
      } finally {
        cache.close();
      }
    });
  });

  describe("toSyncResponse", () => {
    it("reports a successful sync without exposing rate-limit internals", () => {
      const outcome: SyncOutcome = {
        status: "complete",
        generationId: 4,
        fetchedAt: "2026-08-23T10:00:00.000Z",
        scope: { repositoryLimit: 50, repositoryCount: 1, itemLimit: 200, itemCount: 1, truncatedReason: null },
        rateLimit: { cost: 3, remaining: 4997, resetAt: "2026-08-23T11:00:00.000Z" },
      };

      const response = toSyncResponse(outcome);

      expect(response).toEqual({
        status: "complete",
        fetchedAt: "2026-08-23T10:00:00.000Z",
        scope: { repositoryLimit: 50, repositoryCount: 1, itemLimit: 200, itemCount: 1, truncatedReason: null },
      });
    });

    it("maps a failed sync to a safe error code plus the last successful sync, dropping the raw message", () => {
      const outcome: SyncOutcome = {
        status: "failed",
        error: { code: "rate_limited", message: "GitHub said no, verbatim internal detail", retryAfterSeconds: 60 },
        rateLimit: null,
        activeSnapshot: { generationId: 3, fetchedAt: "2026-08-22T10:00:00.000Z" },
      };

      const response = toSyncResponse(outcome);

      expect(response).toEqual({
        status: "failed",
        error: { code: "rate_limited", retryAfterSeconds: 60 },
        lastSuccessfulSync: { fetchedAt: "2026-08-22T10:00:00.000Z" },
      });
    });
  });

  describe("toItemRefreshResponse", () => {
    it("classifies an updated issue into its queue and readiness", async () => {
      const cache = await freshCache();
      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });
        const updatedItem = itemRecord({ id: "I_issue", labels: ["ready-for-agent"] });
        const outcome: RefreshOutcome = {
          status: "updated",
          item: updatedItem,
          fetchedAt: "2026-08-23T10:00:00.000Z",
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-23T11:00:00.000Z" },
        };

        const response = toItemRefreshResponse(cache, outcome);

        expect(response).toMatchObject({
          status: "updated",
          item: { id: "I_issue", type: "issue", queue: "agent", readiness: { kind: "unblocked" } },
        });
      } finally {
        cache.close();
      }
    });

    it("passes removed and not_found through without extra fields", () => {
      expect(
        toItemRefreshResponse({} as Cache, { status: "removed", reason: "closed", rateLimit: { cost: 1, remaining: 1, resetAt: "x" } }),
      ).toEqual({ status: "removed", reason: "closed" });
      expect(toItemRefreshResponse({} as Cache, { status: "not_found" })).toEqual({ status: "not_found" });
    });

    it("maps a failed refresh to a safe error plus the last-known item, dropping the raw message", async () => {
      const cache = await freshCache();
      try {
        const cachedItem = itemRecord({ id: "I_issue", labels: [] });
        const outcome: RefreshOutcome = {
          status: "failed",
          error: { code: "cache_write_failed" },
          rateLimit: null,
          cachedItem,
        };

        const response = toItemRefreshResponse(cache, outcome);

        expect(response).toMatchObject({
          status: "failed",
          error: { code: "cache_write_failed" },
          item: { id: "I_issue" },
        });
      } finally {
        cache.close();
      }
    });
  });

  async function freshCache(): Promise<Cache> {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-api-"));
    temporaryDirectories.push(directory);
    return openCache({ path: join(directory, "repo-control.sqlite") });
  }
});

function snapshot({
  account = { id: "U_account", login: "octo-user" },
  fetchedAt = "2026-08-23T10:00:00.000Z",
  items = [],
  scope = { itemCount: items.length, itemLimit: 200, repositoryCount: 1, repositoryLimit: 50, truncatedReason: null },
}: {
  account?: SuccessfulSnapshot["account"];
  fetchedAt?: string;
  items?: CacheItem[];
  scope?: SuccessfulSnapshot["scope"];
} = {}): SuccessfulSnapshot {
  return {
    account,
    fetchedAt,
    repositories: [{ id: "R_repo_1", nameWithOwner: "octo-user/fictional" }],
    items,
    scope,
  };
}

function itemRecord({
  id = "I_issue",
  repositoryId = "R_repo_1",
  number = 17,
  title = "Fictional title",
  labels = [] as string[],
  relationships = [] as CacheItem["relationships"],
  relationshipCoverage = { blocker: "complete", closing_issue: "complete", parent: "complete" } as CacheItem["relationshipCoverage"],
  updatedAt = "2026-08-23T10:00:00.000Z",
}: {
  id?: string;
  repositoryId?: string;
  number?: number;
  title?: string;
  labels?: string[];
  relationships?: CacheItem["relationships"];
  relationshipCoverage?: CacheItem["relationshipCoverage"];
  updatedAt?: string;
} = {}): CacheItem & { type: "issue" } {
  return {
    id,
    repositoryId,
    number,
    title,
    body: "Fictional body",
    url: `https://github.test/fictional/issues/${number}`,
    updatedAt,
    labels: labels.map((name, index) => ({ id: `L_${index}_${name}`, name })),
    relationships,
    relationshipCoverage,
    type: "issue",
  };
}

function issue(overrides: Parameters<typeof itemRecord>[0] = {}): CacheItem {
  return itemRecord(overrides);
}

function pullRequest({
  id = "PR_1",
  repositoryId = "R_repo_1",
  number = 17,
  title = "Fictional title",
  updatedAt = "2026-08-23T10:00:00.000Z",
}: {
  id?: string;
  repositoryId?: string;
  number?: number;
  title?: string;
  updatedAt?: string;
} = {}): CacheItem {
  return {
    id,
    repositoryId,
    number,
    title,
    body: "Fictional body",
    url: `https://github.test/fictional/pull/${number}`,
    updatedAt,
    labels: [],
    relationships: [],
    relationshipCoverage: { blocker: "not_sampled", closing_issue: "complete", parent: "not_sampled" },
    type: "pull_request",
    pullRequest: { additions: 4, deletions: 1, isDraft: false },
  };
}
