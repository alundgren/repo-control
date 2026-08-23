import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openCache, type Cache } from "../cache/index.js";
import type {
  FocusedItemRead,
  GitHubWorkItem,
  RelationshipEnrichmentRead,
  RelatedWorkItem,
} from "../github/read-client.js";
import { createItemRefreshService, type RefreshClient } from "./index.js";

describe("focused item refresh", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("updates only the selected item's facts and relationships without a sampled sync", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async () => openIssue({ title: "Refreshed title" }),
        readRelationshipEnrichment: async () => enrichment({ blocker: "complete" }, [
          { sourceId: "I_issue_1", targetId: "I_blocker", type: "blocker" },
        ]),
      });
      const service = createItemRefreshService({ cache, client });

      const outcome = await service.refreshItem({ nodeId: "I_issue_1" });

      expect(outcome).toMatchObject({
        status: "updated",
        item: {
          title: "Refreshed title",
          relationships: [{ sourceId: "I_issue_1", targetId: "I_blocker", type: "blocker" }],
          relationshipCoverage: { blocker: "complete" },
        },
      });
      expect(client.focusedCalls).toBe(1);
      expect(client.enrichmentCalls).toBe(1);
      expect(cache.getItem("I_issue_1")?.title).toBe("Refreshed title");
      expect(cache.getItem("I_other_item")?.title).toBe("Untouched sibling");
    } finally {
      cache.close();
    }
  });

  it("keeps an unsampled relationship type's cached facts instead of downgrading its coverage", async () => {
    const cache = await seededCache({
      relationships: [{ sourceId: "I_issue_1", targetId: "I_old_parent", type: "parent" }],
      relationshipCoverage: { blocker: "not_sampled", closing_issue: "not_sampled", parent: "complete" },
    });

    try {
      const client = countingClient({
        readFocusedItem: async () => openIssue(),
        readRelationshipEnrichment: async () => enrichment({ blocker: "complete" }, [
          { sourceId: "I_issue_1", targetId: "I_blocker", type: "blocker" },
        ]),
      });
      const service = createItemRefreshService({ cache, client });

      await service.refreshItem({ nodeId: "I_issue_1" });

      const item = cache.getItem("I_issue_1");
      expect(item?.relationshipCoverage).toEqual({ blocker: "complete", closing_issue: "not_sampled", parent: "complete" });
      expect(item?.relationships).toEqual([
        { sourceId: "I_issue_1", targetId: "I_blocker", type: "blocker" },
        { sourceId: "I_issue_1", targetId: "I_old_parent", type: "parent" },
      ]);
    } finally {
      cache.close();
    }
  });

  it("persists relationship targets that are not sampled work items", async () => {
    const cache = await seededCache();
    try {
      const relatedItem: RelatedWorkItem = {
        id: "I_closing",
        repositoryId: "R_other",
        repositoryNameWithOwner: "fictional-tools/river",
        number: 44,
        title: "Close the river loop",
        url: "https://github.test/fictional-tools/river/issues/44",
      };
      const client = countingClient({
        readFocusedItem: async () => {
          const focused = openIssue();
          return {
            ...focused,
            item: {
              ...focused.item,
              type: "pull_request" as const,
              pullRequest: { additions: 1, changedFiles: 1, deletions: 0, isDraft: false },
            },
          };
        },
        readRelationshipEnrichment: async () => enrichment(
          { closing_issue: "complete" },
          [{ sourceId: "I_issue_1", targetId: relatedItem.id, type: "closing_issue" }],
          [relatedItem],
        ),
      });
      const service = createItemRefreshService({ cache, client });

      await service.refreshItem({ nodeId: "I_issue_1" });

      expect(cache.getRelatedItem(relatedItem.id)).toEqual(relatedItem);
    } finally {
      cache.close();
    }
  });

  it("updates item facts but preserves cached relationships when enrichment is unavailable", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async () => openIssue({ title: "Facts still update" }),
        readRelationshipEnrichment: async () => ({
          status: "unavailable" as const,
          error: { code: "unavailable" as const, message: "GitHub work data is unavailable." },
        }),
      });
      const service = createItemRefreshService({ cache, client });

      const outcome = await service.refreshItem({ nodeId: "I_issue_1" });

      expect(outcome).toMatchObject({ status: "updated", item: { title: "Facts still update" } });
      expect(cache.getItem("I_issue_1")?.relationships).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it("keeps a cached blocker when the enrichment subject reports its coverage as unavailable", async () => {
    const cache = await seededCache({
      relationships: [{ sourceId: "I_issue_1", targetId: "I_old_blocker", type: "blocker" }],
      relationshipCoverage: { blocker: "complete", closing_issue: "not_sampled", parent: "not_sampled" },
    });

    try {
      const client = countingClient({
        readFocusedItem: async () => openIssue(),
        readRelationshipEnrichment: async () => enrichment({ blocker: "unavailable" }, []),
      });
      const service = createItemRefreshService({ cache, client });

      const outcome = await service.refreshItem({ nodeId: "I_issue_1" });

      const persisted = cache.getItem("I_issue_1");
      expect(persisted?.relationshipCoverage.blocker).toBe("complete");
      expect(persisted?.relationships).toEqual([
        { sourceId: "I_issue_1", targetId: "I_old_blocker", type: "blocker" },
      ]);
      expect(outcome).toMatchObject({ status: "updated", item: persisted });
    } finally {
      cache.close();
    }
  });

  it("removes an item from the cache once GitHub proves it left version-one scope", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async () => ({
          status: "out_of_scope" as const,
          reason: "closed" as const,
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-24T12:00:00Z" },
        }),
        readRelationshipEnrichment: async () => enrichment(),
      });
      const service = createItemRefreshService({ cache, client });

      const outcome = await service.refreshItem({ nodeId: "I_issue_1" });

      expect(outcome).toEqual({
        status: "removed",
        reason: "closed",
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-24T12:00:00Z" },
      });
      expect(cache.getItem("I_issue_1")).toBeNull();
      expect(client.enrichmentCalls).toBe(0);
    } finally {
      cache.close();
    }
  });

  it("reports not_found and skips GitHub entirely when the item isn't cached", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async () => openIssue(),
        readRelationshipEnrichment: async () => enrichment(),
      });
      const service = createItemRefreshService({ cache, client });

      const outcome = await service.refreshItem({ nodeId: "I_never_cached" });

      expect(outcome).toEqual({ status: "not_found" });
      expect(client.focusedCalls).toBe(0);
    } finally {
      cache.close();
    }
  });

  it("reports permission_denied and preserves the cached item when GitHub rejects the read", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async () => ({
          status: "unavailable" as const,
          error: { code: "authentication_failed" as const, message: "GitHub rejected the read request." },
        }),
        readRelationshipEnrichment: async () => enrichment(),
      });
      const service = createItemRefreshService({ cache, client });
      const before = cache.getItem("I_issue_1");

      const outcome = await service.refreshItem({ nodeId: "I_issue_1" });

      expect(outcome).toMatchObject({
        status: "permission_denied",
        error: { code: "authentication_failed" },
      });
      expect(cache.getItem("I_issue_1")).toEqual(before);
      expect(client.enrichmentCalls).toBe(0);
    } finally {
      cache.close();
    }
  });

  it("reports failed and preserves the cached item when GitHub is rate limited", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async () => ({
          status: "unavailable" as const,
          error: { code: "rate_limited" as const, message: "GitHub rate limit prevented this read.", retryAfterSeconds: 60 },
        }),
        readRelationshipEnrichment: async () => enrichment(),
      });
      const service = createItemRefreshService({ cache, client });
      const before = cache.getItem("I_issue_1");

      const outcome = await service.refreshItem({ nodeId: "I_issue_1" });

      expect(outcome).toMatchObject({ status: "failed", error: { code: "rate_limited", retryAfterSeconds: 60 } });
      expect(cache.getItem("I_issue_1")).toEqual(before);
    } finally {
      cache.close();
    }
  });

  it("reports failed and leaves the cache untouched when the refreshed item points at an unknown repository", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async () => openIssue({ repositoryId: "R_never_synced" }),
        readRelationshipEnrichment: async () => enrichment(),
      });
      const service = createItemRefreshService({ cache, client });
      const before = cache.getItem("I_issue_1");

      const outcome = await service.refreshItem({ nodeId: "I_issue_1" });

      expect(outcome).toMatchObject({ status: "failed", error: { code: "cache_write_failed" } });
      expect(cache.getItem("I_issue_1")).toEqual(before);
    } finally {
      cache.close();
    }
  });

  it("dedupes concurrent refreshes of the same item into a single GitHub read", async () => {
    const cache = await seededCache();

    try {
      let resolveRead!: (value: FocusedItemRead) => void;
      const client = countingClient({
        readFocusedItem: () => new Promise<FocusedItemRead>((resolve) => {
          resolveRead = resolve;
        }),
        readRelationshipEnrichment: async () => enrichment(),
      });
      const service = createItemRefreshService({ cache, client });

      const first = service.refreshItem({ nodeId: "I_issue_1" });
      const second = service.refreshItem({ nodeId: "I_issue_1" });
      resolveRead(openIssue({ title: "Resolved once" }));
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(client.focusedCalls).toBe(1);
      expect(firstResult).toEqual(secondResult);
    } finally {
      cache.close();
    }
  });

  it("refreshes two different items independently and concurrently", async () => {
    const cache = await seededCache();

    try {
      const client = countingClient({
        readFocusedItem: async ({ nodeId }) => openIssue({ id: nodeId, title: `Refreshed ${nodeId}` }),
        readRelationshipEnrichment: async () => enrichment(),
      });
      const service = createItemRefreshService({ cache, client });

      const [first, second] = await Promise.all([
        service.refreshItem({ nodeId: "I_issue_1" }),
        service.refreshItem({ nodeId: "I_other_item" }),
      ]);

      expect(first).toMatchObject({ item: { title: "Refreshed I_issue_1" } });
      expect(second).toMatchObject({ item: { title: "Refreshed I_other_item" } });
      expect(client.focusedCalls).toBe(2);
    } finally {
      cache.close();
    }
  });

  async function seededCache(overrides: {
    relationships?: GitHubWorkItem["relationships"];
    relationshipCoverage?: GitHubWorkItem["relationshipCoverage"];
  } = {}): Promise<Cache> {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-refresh-"));
    temporaryDirectories.push(directory);
    const cache = openCache({ path: join(directory, "cache.sqlite") });
    cache.replaceActiveSnapshot({
      account: { id: "U_fixture", login: "octofixture" },
      fetchedAt: "2026-08-23T09:00:00.000Z",
      repositories: [{ id: "R_fixture", nameWithOwner: "octofixture/example-widgets" }],
      items: [
        {
          id: "I_issue_1",
          repositoryId: "R_fixture",
          number: 17,
          title: "Original title",
          body: "A fictional issue body",
          url: "https://example.test/octofixture/example-widgets/issues/17",
          updatedAt: "2026-08-22T09:00:00.000Z",
          labels: [{ id: "L_ready", name: "ready-for-agent" }],
          relationships: overrides.relationships ?? [],
          relationshipCoverage: overrides.relationshipCoverage ?? {
            blocker: "not_sampled",
            closing_issue: "not_sampled",
            parent: "not_sampled",
          },
          type: "issue",
        },
        {
          id: "I_other_item",
          repositoryId: "R_fixture",
          number: 18,
          title: "Untouched sibling",
          body: null,
          url: "https://example.test/octofixture/example-widgets/issues/18",
          updatedAt: "2026-08-22T09:00:00.000Z",
          labels: [],
          relationships: [],
          relationshipCoverage: { blocker: "not_sampled", closing_issue: "not_sampled", parent: "not_sampled" },
          type: "issue",
        },
      ],
      scope: { repositoryLimit: 50, repositoryCount: 1, itemLimit: 200, itemCount: 2, truncatedReason: null },
    });
    return cache;
  }
});

function countingClient(implementation: {
  readFocusedItem: (input: { nodeId: string }) => Promise<FocusedItemRead>;
  readRelationshipEnrichment: (input: { nodeIds: string[] }) => Promise<RelationshipEnrichmentRead>;
}): RefreshClient & { focusedCalls: number; enrichmentCalls: number } {
  const client = {
    focusedCalls: 0,
    enrichmentCalls: 0,
    async readFocusedItem(input: { nodeId: string }) {
      client.focusedCalls += 1;
      return implementation.readFocusedItem(input);
    },
    async readRelationshipEnrichment(input: { nodeIds: string[] }) {
      client.enrichmentCalls += 1;
      return implementation.readRelationshipEnrichment(input);
    },
  };
  return client;
}

function openIssue(overrides: { id?: string; title?: string; repositoryId?: string } = {}): Extract<FocusedItemRead, { status: "open" }> {
  return {
    status: "open",
    item: {
      id: overrides.id ?? "I_issue_1",
      repositoryId: overrides.repositoryId ?? "R_fixture",
      number: 17,
      title: overrides.title ?? "Original title",
      bodyExcerpt: "A fictional issue body",
      url: `https://example.test/octofixture/example-widgets/issues/17`,
      updatedAt: "2026-08-23T09:30:00.000Z",
      labels: [{ id: "L_ready", name: "ready-for-agent" }],
      relationships: [],
      relationshipCoverage: { blocker: "not_sampled", closing_issue: "not_sampled", parent: "not_sampled" },
      type: "issue",
    },
    fetchedAt: "2026-08-23T09:30:00.000Z",
    rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-24T12:00:00Z" },
    scope: { status: "complete", partialReasons: [] },
  };
}

function enrichment(
  coverage: Partial<{ blocker: "complete" | "unavailable" | "not_sampled"; closing_issue: "complete" | "unavailable" | "not_sampled" }> = {},
  relationships: GitHubWorkItem["relationships"] = [],
  relatedItems: RelatedWorkItem[] = [],
): RelationshipEnrichmentRead {
  return {
    requestedCount: 1,
    readCount: 1,
    subjectLimit: 10,
    status: "complete",
    rateLimit: { cost: 1, remaining: 4998, resetAt: "2026-08-24T12:00:00Z" },
    subjects: [
      {
        nodeId: relationships[0]?.sourceId ?? "I_issue_1",
        coverage: { blocker: "not_sampled", closing_issue: "not_sampled", ...coverage },
        relationships,
        relatedItems,
        status: "read",
      },
    ],
  };
}
