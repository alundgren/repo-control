import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  openCache,
  type Cache,
  type CacheItem,
  type PullRequestFacts,
  type RelationshipCoverageByType,
  type SuccessfulSnapshot,
} from "./index.js";

describe("local cache", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("migrates a new database and can reopen it", async () => {
    const path = await createCachePath();
    const first = openCache({ path });

    try {
      expect(first.getStatus()).toEqual({
        activeGenerationId: null,
        retainedGenerationCount: 0,
        schemaVersion: 5,
        storedAccountCount: 0,
        storedItemCount: 0,
      });
    } finally {
      first.close();
    }

    const reopened = openCache({ path });

    try {
      expect(reopened.getStatus().schemaVersion).toBe(5);
    } finally {
      reopened.close();
    }
  });

  it("upgrades a version-one cache without losing its active generation", async () => {
    const path = await createCachePath();
    const current = openCache({ path });
    current.replaceActiveSnapshot(snapshot({ title: "Retained generation" }));
    const activeBefore = current.getActiveSnapshot();
    current.close();

    const versionOne = new Database(path);
    versionOne.exec(`
      DELETE FROM cache_migrations WHERE version IN (2, 3, 4, 5);
      DROP TABLE related_item_summaries;
      ALTER TABLE items DROP COLUMN github_created_at;
      ALTER TABLE items DROP COLUMN sub_issues_total;
      ALTER TABLE items DROP COLUMN sub_issues_completed;
      ALTER TABLE snapshot_generations DROP COLUMN reconciliation_kind;
      ALTER TABLE snapshot_generations DROP COLUMN last_full_reconciled_at;
      ALTER TABLE snapshot_generations DROP COLUMN inventory_complete;
      ALTER TABLE snapshot_generations DROP COLUMN search_page_size;
      ALTER TABLE snapshot_generations DROP COLUMN search_result_limit;
    `);
    versionOne.close();

    const migrated = openCache({ path });
    try {
      expect(migrated.getStatus().schemaVersion).toBe(5);
      expect(migrated.getActiveSnapshot()).toMatchObject({
        generationId: activeBefore?.generationId,
        items: [{ id: "I_issue_1", title: "Retained generation" }],
      });
    } finally {
      migrated.close();
    }
  });

  it("upgrades a reconciliation version-two cache while adding related-item storage", async () => {
    const path = await createCachePath();
    const current = openCache({ path });
    current.replaceActiveSnapshot(snapshot({ title: "Retained reconciliation generation" }));
    const activeBefore = current.getActiveSnapshot();
    current.close();

    const versionTwo = new Database(path);
    versionTwo.exec(`
      DELETE FROM cache_migrations WHERE version IN (3, 4, 5);
      DROP TABLE related_item_summaries;
    `);
    versionTwo.close();

    const migrated = openCache({ path });
    try {
      expect(migrated.getStatus().schemaVersion).toBe(5);
      expect(migrated.getActiveSnapshot()).toMatchObject({
        generationId: activeBefore?.generationId,
        items: [{ id: "I_issue_1", title: "Retained reconciliation generation" }],
      });
    } finally {
      migrated.close();
    }
  });

  it("replaces the active snapshot atomically", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({ title: "First" }));
      const first = cache.getActiveSnapshot();

      cache.replaceActiveSnapshot(snapshot({
        fetchedAt: "2026-08-24T10:00:00.000Z",
        title: "Second",
      }));

      expect(first?.items[0]?.title).toBe("First");
      expect(cache.getActiveSnapshot()?.items[0]?.title).toBe("Second");
      expect(cache.getStatus().retainedGenerationCount).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("rolls back a replacement that violates a cache constraint", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({ title: "Known good" }));

      expect(() =>
        cache.replaceActiveSnapshot(snapshot({
          fetchedAt: "2026-08-24T10:00:00.000Z",
          labels: [{ id: "L_invalid", name: "" }],
          title: "Rejected",
        })),
      ).toThrow();

      expect(cache.getActiveSnapshot()?.items[0]?.title).toBe("Known good");
      expect(cache.getStatus().retainedGenerationCount).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("keeps the previous snapshot when a sampled sync fails before replacement", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({ title: "Last success" }));

      expect(() => sync(cache, () => {
        throw new Error("GitHub timed out");
      })).toThrow("GitHub timed out");

      expect(cache.getActiveSnapshot()?.items[0]?.title).toBe("Last success");
    } finally {
      cache.close();
    }
  });

  it("records partial sampled scope, freshness, and unavailable relationships", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({
        scope: {
          itemCount: 20,
          repositoryCount: 3,
          truncatedReason: "item_limit",
        },
        relationshipCoverage: coverage({ blocker: "unavailable" }),
      }));

      expect(cache.getActiveSnapshot()).toMatchObject({
        fetchedAt: "2026-08-23T10:00:00.000Z",
        scope: {
          itemCount: 20,
          repositoryCount: 3,
          truncatedReason: "item_limit",
        },
        items: [
          {
            relationshipCoverage: coverage({ blocker: "unavailable" }),
            relationships: [],
            updatedAt: "2026-08-22T09:00:00.000Z",
          },
        ],
      });
    } finally {
      cache.close();
    }
  });

  it("stores complete relationship facts for sampled items", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({
        relationships: [
          {
            sourceId: "I_issue_1",
            targetId: "I_issue_2",
            type: "blocker",
          },
        ],
      }));

      expect(cache.getActiveSnapshot()?.items[0]?.relationships).toEqual([
        {
          sourceId: "I_issue_1",
          targetId: "I_issue_2",
          type: "blocker",
        },
      ]);
    } finally {
      cache.close();
    }
  });

  it.each(["not_sampled", "unavailable"] as const)(
    "keeps complete relationships when a later sample marks them %s",
    async (nextCoverage) => {
      const cache = openCache({ path: await createCachePath() });

      try {
        const relationships = [{
          sourceId: "I_issue_1",
          targetId: "I_issue_2",
          type: "blocker" as const,
        }];
        cache.replaceActiveSnapshot(snapshot({ relationships }));
        cache.replaceActiveSnapshot(snapshot({
          fetchedAt: "2026-08-24T10:00:00.000Z",
          relationshipCoverage: coverage({ blocker: nextCoverage }),
        }));

        expect(cache.getActiveSnapshot()?.items[0]).toMatchObject({
          relationshipCoverage: coverage({ blocker: nextCoverage }),
          relationships,
        });
      } finally {
        cache.close();
      }
    },
  );

  it("round-trips pull-request facts and rejects invalid pull-request input", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({
        itemType: "pull_request",
        pullRequest: { additions: 12, deletions: 4, isDraft: true },
      }));

      expect(cache.getActiveSnapshot()?.items[0]).toMatchObject({
        pullRequest: { additions: 12, deletions: 4, isDraft: true },
        type: "pull_request",
      });
      expect(() =>
        cache.replaceActiveSnapshot({
          ...snapshot(),
          items: [{ ...snapshot().items[0], type: "pull_request" }],
        } as SuccessfulSnapshot),
      ).toThrow("Pull requests require pull-request facts");
    } finally {
      cache.close();
    }
  });

  it("stores the GitHub creation time alongside the update time", async () => {
    const cache = openCache({ path: await createCachePath() });
    try {
      cache.replaceActiveSnapshot(snapshot({ createdAt: "2026-08-01T10:00:00.000Z" }));
      expect(cache.getActiveSnapshot()?.items[0]).toMatchObject({
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-22T09:00:00.000Z",
      });
    } finally {
      cache.close();
    }
  });

  it("keeps three generations and removes stale facts that no retained generation uses", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      for (const [fetchedAt, repositoryId, title] of [
        ["2026-08-01T10:00:00.000Z", "R_repo_1", "Snapshot 1"],
        ["2026-09-01T10:00:00.000Z", "R_repo_2", "Snapshot 2"],
        ["2026-09-02T10:00:00.000Z", "R_repo_3", "Snapshot 3"],
        ["2026-09-03T10:00:00.000Z", "R_repo_4", "Snapshot 4"],
      ]) {
        cache.replaceActiveSnapshot(snapshot({
          fetchedAt,
          itemId: `I_issue_${repositoryId}`,
          repositoryId,
          title,
        }));
      }

      expect(cache.getStatus()).toMatchObject({
        retainedGenerationCount: 3,
        storedItemCount: 3,
      });
      expect(cache.getActiveSnapshot()?.items[0]?.title).toBe("Snapshot 4");
    } finally {
      cache.close();
    }
  });

  it("removes an old account after its stale facts expire", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({
        account: { id: "U_old", login: "former-user" },
        fetchedAt: "2026-08-01T10:00:00.000Z",
        itemId: "I_old",
        repositoryId: "R_old",
      }));
      for (const [fetchedAt, itemId, repositoryId] of [
        ["2026-09-01T10:00:00.000Z", "I_new_1", "R_new_1"],
        ["2026-09-02T10:00:00.000Z", "I_new_2", "R_new_2"],
        ["2026-09-03T10:00:00.000Z", "I_new_3", "R_new_3"],
      ]) {
        cache.replaceActiveSnapshot(snapshot({ fetchedAt, itemId, repositoryId }));
      }

      expect(cache.getStatus().storedAccountCount).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("replaces one item's facts without creating a new snapshot generation", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({ title: "Original" }));
      const activeBefore = cache.getActiveSnapshot();

      const item = cache.getItem("I_issue_1");
      if (!item) throw new Error("expected seeded item");
      cache.replaceItem({ ...item, title: "Refreshed" }, "2026-08-25T00:00:00.000Z");

      expect(cache.getItem("I_issue_1")?.title).toBe("Refreshed");
      expect(cache.getActiveSnapshot()?.items[0]?.title).toBe("Refreshed");
      expect(cache.getActiveSnapshot()?.generationId).toBe(activeBefore?.generationId);
      expect(cache.getStatus().retainedGenerationCount).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("returns null from getItem for an item that isn't cached", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      expect(cache.getItem("I_missing")).toBeNull();
    } finally {
      cache.close();
    }
  });

  it("rejects a replaceItem for a repository the cache has never seen and leaves the cached item intact", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot());
      const item = cache.getItem("I_issue_1");
      if (!item) throw new Error("expected seeded item");

      expect(() =>
        cache.replaceItem({ ...item, repositoryId: "R_unknown" }, "2026-08-25T00:00:00.000Z"),
      ).toThrow();
      expect(cache.getItem("I_issue_1")?.repositoryId).toBe("R_repo_1");
    } finally {
      cache.close();
    }
  });

  it("removes an item, its labels, and its relationships from the cache and the active snapshot", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({
        relationships: [{ sourceId: "I_issue_1", targetId: "I_issue_2", type: "blocker" }],
        relatedItems: [{
          id: "I_issue_2",
          repositoryId: "R_repo_2",
          repositoryNameWithOwner: "octo-user/related-repository",
          number: 18,
          title: "Related issue",
          url: "https://example.test/octo/related-repository/issues/18",
        }],
      }));

      expect(cache.getRelatedItem("I_issue_2")).not.toBeNull();

      cache.removeItem("I_issue_1");

      expect(cache.getItem("I_issue_1")).toBeNull();
      expect(cache.getActiveSnapshot()?.items).toEqual([]);
      expect(cache.getStatus().storedItemCount).toBe(0);
      expect(cache.getRelatedItem("I_issue_2")).toBeNull();
    } finally {
      cache.close();
    }
  });

  it("clears the complete reconciliation cursor on the active generation", async () => {
    const path = await createCachePath();
    let cache = openCache({ path });

    try {
      cache.replaceActiveSnapshot(snapshot({
        scope: {
          ...snapshot().scope,
          lastFullReconciliationAt: "2026-08-23T10:00:00.000Z",
        },
      }));

      cache.clearActiveGenerationLastFullReconciledAt();
      expect(cache.getActiveSnapshot()?.scope.lastFullReconciliationAt).toBeNull();

      cache.close();
      cache = openCache({ path });
      expect(cache.getActiveSnapshot()?.scope.lastFullReconciliationAt).toBeNull();
    } finally {
      cache.close();
    }
  });

  it("starts a new installation on the documented default queue mapping", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      expect(cache.getQueueMapping()).toEqual({
        defaultQueue: "triage",
        labels: [
          { label: "ready-for-agent", queue: "agent" },
          { label: "ready-for-human", queue: "human" },
        ],
      });
    } finally {
      cache.close();
    }
  });

  it("starts a new installation on the documented default epic label", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      expect(cache.getEpicLabel()).toBe("epic");
    } finally {
      cache.close();
    }
  });

  it("persists sub-issue counts with issue items and clears them when a later read omits them", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceActiveSnapshot(snapshot({ subIssues: { completed: 5, total: 14 } }));

      expect(cache.getItem("I_issue_1")?.subIssues).toEqual({ completed: 5, total: 14 });
      expect(cache.getActiveSnapshot()?.items[0]?.subIssues).toEqual({ completed: 5, total: 14 });

      cache.replaceActiveSnapshot(snapshot({ title: "Second generation" }));

      expect(cache.getActiveSnapshot()?.items[0]?.subIssues).toBeUndefined();
    } finally {
      cache.close();
    }
  });

  it("stores instance queue mappings separately from GitHub facts", async () => {
    const cache = openCache({ path: await createCachePath() });

    try {
      cache.replaceQueueMapping({
        defaultQueue: "triage",
        labels: [
          { label: "ready-for-agent", queue: "agent" },
          { label: "needs-review", queue: "human" },
        ],
      });

      expect(cache.getQueueMapping()).toEqual({
        defaultQueue: "triage",
        labels: [
          { label: "needs-review", queue: "human" },
          { label: "ready-for-agent", queue: "agent" },
        ],
      });
    } finally {
      cache.close();
    }
  });

  async function createCachePath() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-cache-"));
    temporaryDirectories.push(directory);
    return join(directory, "cache.sqlite");
  }
});

function snapshot({
  account = { id: "U_account", login: "octo-user" },
  createdAt,
  fetchedAt = "2026-08-23T10:00:00.000Z",
  itemId = "I_issue_1",
  labels = [{ id: "L_ready", name: "ready-for-agent" }],
  itemType = "issue",
  pullRequest,
  relatedItems,
  relationships = [],
  relationshipCoverage = coverage(),
  repositoryId = "R_repo_1",
  scope = {
    itemCount: 1,
    itemLimit: 20,
    repositoryCount: 1,
    repositoryLimit: 5,
    truncatedReason: null,
  },
  subIssues,
  title = "First",
}: {
  account?: SuccessfulSnapshot["account"];
  createdAt?: string;
  fetchedAt?: string;
  itemId?: string;
  itemType?: CacheItem["type"];
  labels?: SuccessfulSnapshot["items"][number]["labels"];
  pullRequest?: PullRequestFacts;
  relatedItems?: SuccessfulSnapshot["items"][number]["relatedItems"];
  relationships?: SuccessfulSnapshot["items"][number]["relationships"];
  relationshipCoverage?: RelationshipCoverageByType;
  repositoryId?: string;
  scope?: SuccessfulSnapshot["scope"];
  subIssues?: NonNullable<SuccessfulSnapshot["items"][number]["subIssues"]>;
  title?: string;
} = {}): SuccessfulSnapshot {
  return {
    account,
    fetchedAt,
    items: [itemType === "pull_request"
      ? {
        body: "Fictional issue body",
        createdAt,
        id: itemId,
        labels,
        number: 17,
        relationshipCoverage,
        relationships,
        relatedItems,
        repositoryId,
        title,
        type: "pull_request",
        updatedAt: "2026-08-22T09:00:00.000Z",
        url: "https://example.test/octo/repo/issues/17",
        pullRequest: pullRequest ?? { additions: null, deletions: null, isDraft: false },
      }
      : {
        body: "Fictional issue body",
        createdAt,
        id: itemId,
        labels,
        number: 17,
        relationshipCoverage,
        relationships,
        relatedItems,
        repositoryId,
        subIssues,
        title,
        type: "issue",
        updatedAt: "2026-08-22T09:00:00.000Z",
        url: "https://example.test/octo/repo/issues/17",
      }],
    repositories: [
      {
        id: repositoryId,
        nameWithOwner: "octo-user/example-repository",
      },
    ],
    scope,
  };
}

function coverage(
  overrides: Partial<RelationshipCoverageByType> = {},
): RelationshipCoverageByType {
  return {
    blocker: "complete",
    closing_issue: "complete",
    parent: "complete",
    ...overrides,
  };
}

function sync(cache: Cache, readSnapshot: () => SuccessfulSnapshot) {
  cache.replaceActiveSnapshot(readSnapshot());
}
