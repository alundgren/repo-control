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

        expect(overview.queues).toEqual([
          { name: "agent", issues: [] },
          { name: "human", issues: [] },
          { name: "triage", issues: [] },
        ]);
        expect(overview.pullRequests).toEqual([
          {
            id: "PR_1",
            type: "pull_request",
            repositoryId: "R_repo_1",
            number: 17,
            title: "Fictional title",
            excerpt: "Fictional body",
            url: "https://github.test/fictional/pull/17",
            createdAt: null,
            updatedAt: "2026-08-23T10:00:00.000Z",
            observedAt: "2026-08-23T10:00:00.000Z",
            isDraft: false,
            additions: 4,
            deletions: 1,
            closingIssues: { status: "complete", items: [] },
          },
        ]);
      } finally {
        cache.close();
      }
    });

    it("exposes a linked closing issue from a durable relationship summary", async () => {
      const cache = await freshCache();
      try {
        cache.replaceActiveSnapshot(snapshot({ items: [pullRequest({ id: "PR_1" })] }));
        const item = cache.getItem("PR_1");
        if (!item) throw new Error("expected pull request");
        cache.replaceItem({
          ...item,
          relationships: [{ sourceId: "PR_1", targetId: "I_closing", type: "closing_issue" }],
          relatedItems: [{
            id: "I_closing",
            repositoryId: "R_related",
            repositoryNameWithOwner: "fictional-tools/river",
            number: 44,
            title: "Close the river loop",
            url: "https://github.test/fictional-tools/river/issues/44",
          }],
        }, "2026-08-24T10:00:00.000Z");

        const overview = buildOverview(cache);
        if (overview.status !== "ready") throw new Error("expected a ready overview");

        expect(overview.pullRequests[0]?.closingIssues).toEqual({
          status: "complete",
          items: [{
            id: "I_closing",
            repositoryId: "R_related",
            repositoryNameWithOwner: "fictional-tools/river",
            number: 44,
            title: "Close the river loop",
            url: "https://github.test/fictional-tools/river/issues/44",
          }],
        });
      } finally {
        cache.close();
      }
    });

    it("resolves a known blocker to its durable summary and marks a missing blocker id explicitly", async () => {
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
                relatedItems: [{
                  id: "I_known_blocker",
                  repositoryId: "R_related",
                  repositoryNameWithOwner: "fictional-tools/river",
                  number: 31,
                  title: "Known durable blocker",
                  url: "https://github.test/fictional-tools/river/issues/31",
                }],
              }),
            ],
          }),
        );

        const overview = buildOverview(cache);
        if (overview.status !== "ready") {
          throw new Error("expected a ready overview");
        }
        const blocked = overview.issues.find((item) => item.id === "I_blocked");

        expect(overview.queues.find((queue) => queue.name === "agent")?.issues).toEqual([]);

        expect(blocked?.readiness).toEqual({
          kind: "blocked",
          blockers: [
            {
              status: "known",
              id: "I_known_blocker",
              repositoryId: "R_related",
              repositoryNameWithOwner: "fictional-tools/river",
              number: 31,
              title: "Known durable blocker",
              url: "https://github.test/fictional-tools/river/issues/31",
            },
            { status: "unknown", id: "I_missing_blocker" },
          ],
        });
      } finally {
        cache.close();
      }
    });

    it("filters ignored work and removes ignored identities from visible relationships", async () => {
      const cache = await freshCache();
      try {
        const visibleIssue = issue({
          id: "I_visible",
          relationships: [
            { sourceId: "I_visible", targetId: "I_hidden_blocker", type: "blocker" },
            { sourceId: "I_visible", targetId: "I_hidden_epic", type: "parent" },
          ],
        });
        const visiblePullRequest = pullRequest({ id: "PR_visible" });
        visiblePullRequest.relationships = [{ sourceId: "PR_visible", targetId: "I_hidden_closing", type: "closing_issue" }];
        visiblePullRequest.relatedItems = [{ id: "I_hidden_closing", repositoryId: "R_hidden", repositoryNameWithOwner: "octo-user/hidden", number: 9, title: "Hidden closing issue", url: "https://github.test/hidden/issues/9" }];
        const hiddenBlocker = issue({ id: "I_hidden_blocker", repositoryId: "R_hidden", title: "Hidden blocker" });
        const hiddenEpic = issue({ id: "I_hidden_epic", repositoryId: "R_hidden", title: "Hidden epic", labels: ["epic"] });
        const data = snapshot({ items: [visibleIssue, visiblePullRequest, hiddenBlocker, hiddenEpic] });
        data.repositories.push({ id: "R_hidden", nameWithOwner: "octo-user/hidden" });
        data.scope = { ...data.scope, itemCount: 4, repositoryCount: 2 };
        cache.replaceActiveSnapshot(data);
        cache.replaceIgnoredRepositories(["R_hidden"], 0);

        const overview = buildOverview(cache);
        if (overview.status !== "ready") throw new Error("expected a ready overview");
        expect(overview.repositories).toEqual([{ id: "R_repo_1", nameWithOwner: "octo-user/fictional" }]);
        expect(overview.scope).toMatchObject({ itemCount: 4, repositoryCount: 2, visibleItemCount: 2, visibleRepositoryCount: 1, ignoredRepositoryCount: 1 });
        const issueRead = overview.issues.find((entry) => entry.id === "I_visible");
        expect(issueRead?.readiness).toEqual({ kind: "blocked", blockers: [{ status: "unavailable" }] });
        expect(issueRead?.epic).toBeNull();
        expect(overview.pullRequests[0]?.closingIssues).toEqual({ status: "complete", items: [] });
        expect(JSON.stringify(overview)).not.toContain("Hidden");
        expect(JSON.stringify(overview)).not.toContain("R_hidden");
      } finally {
        cache.close();
      }
    });

    it("keeps every issue in the read model while the Ready projection omits claimed and confirmed-blocked work", async () => {
      const cache = await freshCache();
      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });
        cache.replaceActiveSnapshot(snapshot({
          items: [
            issue({ id: "I_unblocked", labels: ["ready-for-agent"] }),
            issue({
              id: "I_unavailable",
              labels: ["ready-for-agent"],
              relationshipCoverage: { blocker: "unavailable", closing_issue: "complete", parent: "complete" },
            }),
            issue({ id: "I_claimed", labels: ["ready-for-agent", "claimed"] }),
            issue({
              id: "I_blocked",
              labels: ["ready-for-agent"],
              relationships: [{ sourceId: "I_blocked", targetId: "I_blocker", type: "blocker" }],
            }),
            issue({
              id: "I_both",
              labels: ["ready-for-agent", "claimed"],
              relationships: [{ sourceId: "I_both", targetId: "I_blocker", type: "blocker" }],
            }),
          ],
          scope: { itemCount: 5, itemLimit: 200, repositoryCount: 1, repositoryLimit: 50, truncatedReason: null },
        }));

        const overview = buildOverview(cache);
        if (overview.status !== "ready") throw new Error("expected a ready overview");

        expect(overview.scope.itemCount).toBe(5);
        expect(overview.issues.map(({ id, readyExclusion }) => ({ id, readyExclusion }))).toEqual([
          { id: "I_claimed", readyExclusion: "claimed" },
          { id: "I_unblocked", readyExclusion: null },
          { id: "I_unavailable", readyExclusion: null },
          { id: "I_blocked", readyExclusion: "blocked" },
          { id: "I_both", readyExclusion: "claimed_and_blocked" },
        ]);
        expect(overview.queues.find((queue) => queue.name === "agent")?.issues.map((item) => item.id)).toEqual([
          "I_unblocked",
          "I_unavailable",
        ]);
      } finally {
        cache.close();
      }
    });

    it("does not report a Ready exclusion for claimed or blocked issues assigned elsewhere", async () => {
      const cache = await freshCache();
      try {
        cache.replaceQueueMapping({
          defaultQueue: "triage",
          labels: [
            { label: "ready-for-agent", queue: "agent" },
            { label: "ready-for-human", queue: "human" },
          ],
        });
        cache.replaceActiveSnapshot(snapshot({ items: [
          issue({ id: "I_human", labels: ["ready-for-human", "claimed"] }),
          issue({
            id: "I_triage",
            relationships: [{ sourceId: "I_triage", targetId: "I_blocker", type: "blocker" }],
          }),
        ] }));

        const overview = buildOverview(cache);
        if (overview.status !== "ready") throw new Error("expected a ready overview");

        expect(overview.issues.map(({ id, queue, readyExclusion }) => ({ id, queue, readyExclusion }))).toEqual([
          { id: "I_human", queue: "human", readyExclusion: null },
          { id: "I_triage", queue: "triage", readyExclusion: null },
        ]);
      } finally {
        cache.close();
      }
    });

    it("lists epic-labelled issues outside every queue with their own sampled progress", async () => {
      const cache = await freshCache();
      try {
        cache.replaceActiveSnapshot(
          snapshot({
            items: [
              issue({
                id: "I_epic_new",
                number: 2,
                labels: ["epic"],
                updatedAt: "2026-08-25T10:00:00.000Z",
                subIssues: { completed: 5, total: 14 },
              }),
              issue({ id: "I_epic_unsampled", number: 3, labels: ["epic"], updatedAt: "2026-08-24T10:00:00.000Z" }),
              issue({
                id: "I_child",
                labels: ["ready-for-agent"],
                relationships: [{ sourceId: "I_child", targetId: "I_epic_new", type: "parent" }],
                relatedItems: [{
                  id: "I_epic_new",
                  repositoryId: "R_repo_1",
                  repositoryNameWithOwner: "octo-user/fictional",
                  number: 2,
                  title: "Epic: offline sync",
                  url: "https://github.test/fictional/issues/2",
                }],
              }),
            ],
          }),
        );

        const overview = buildOverview(cache);
        if (overview.status !== "ready") throw new Error("expected a ready overview");

        expect(overview.epics.map((epic) => epic.id)).toEqual(["I_epic_new", "I_epic_unsampled"]);
        expect(overview.epics[0]).toMatchObject({
          type: "issue",
          queue: null,
          subIssues: { completed: 5, total: 14 },
        });
        expect(overview.epics[1]?.subIssues).toBeNull();

        const queuedIds = overview.queues.flatMap((queue) => queue.issues.map((issueRead) => issueRead.id));
        expect(queuedIds).toEqual(["I_child"]);
        expect(overview.queues.find((queue) => queue.name === "triage")?.issues).toEqual([]);

        const child = overview.queues.flatMap((queue) => queue.issues)[0];
        expect(child?.epic).toEqual({
          id: "I_epic_new",
          repositoryId: "R_repo_1",
          repositoryNameWithOwner: "octo-user/fictional",
          number: 2,
          title: "Epic: offline sync",
          url: "https://github.test/fictional/issues/2",
          subIssues: { completed: 5, total: 14 },
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
          ["createdAt", "epic", "excerpt", "id", "number", "observedAt", "queue", "readiness", "readyExclusion", "repositoryId", "subIssues", "title", "type", "updatedAt", "url"].sort(),
        );
        expect(Object.keys(pullRequestRead!).sort()).toEqual(
          [
            "additions",
            "createdAt",
            "deletions",
            "closingIssues",
            "excerpt",
            "id",
            "isDraft",
            "number",
            "observedAt",
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
          relationshipStatus: "fresh",
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

    it("returns the Ready exclusion on a focused refresh", async () => {
      const cache = await freshCache();
      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });
        const outcome: RefreshOutcome = {
          status: "updated",
          item: itemRecord({ id: "I_issue", labels: ["ready-for-agent", "claimed"] }),
          fetchedAt: "2026-08-23T10:00:00.000Z",
          relationshipStatus: "fresh",
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-23T11:00:00.000Z" },
        };

        expect(toItemRefreshResponse(cache, outcome)).toMatchObject({
          status: "updated",
          item: { id: "I_issue", readyExclusion: "claimed" },
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
      expect(toItemRefreshResponse({} as Cache, { status: "ignored" })).toEqual({ status: "ignored" });
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
  relatedItems,
  relationshipCoverage = { blocker: "complete", closing_issue: "complete", parent: "complete" } as CacheItem["relationshipCoverage"],
  subIssues,
  updatedAt = "2026-08-23T10:00:00.000Z",
}: {
  id?: string;
  repositoryId?: string;
  number?: number;
  title?: string;
  labels?: string[];
  relationships?: CacheItem["relationships"];
  relatedItems?: CacheItem["relatedItems"];
  relationshipCoverage?: CacheItem["relationshipCoverage"];
  subIssues?: NonNullable<CacheItem["subIssues"]>;
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
    relatedItems,
    relationshipCoverage,
    ...(subIssues ? { subIssues } : {}),
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
