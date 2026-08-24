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

  it("emits one terminal event for the underlying sync, including its safe scope summary", async () => {
    const cache = openCache({ path: await createCachePath() });
    const events: Array<Record<string, unknown>> = [];

    try {
      const service = createSyncService({
        cache,
        client: countingClient(async () => accountSnapshot()),
        logEvent: (event) => events.push(event),
      });

      await service.sync();

      expect(events).toEqual([
        expect.objectContaining({
          event: "sync.finished",
          level: "info",
          status: "complete",
          reconciliation: "full",
          repositoryCount: 1,
          itemCount: 2,
          truncatedReason: null,
        }),
      ]);
    } finally {
      cache.close();
    }
  });

  it("emits one event when concurrent callers join the same sync", async () => {
    const cache = openCache({ path: await createCachePath() });
    const events: Array<Record<string, unknown>> = [];
    let resolveRead!: (value: AccountSnapshotRead) => void;

    try {
      const service = createSyncService({
        cache,
        client: {
          readAccountSnapshot: () => new Promise<AccountSnapshotRead>((resolve) => { resolveRead = resolve; }),
          readRelationshipEnrichment: async ({ nodeIds }) => completeEnrichment(nodeIds),
        },
        logEvent: (event) => events.push(event),
      });

      const first = service.sync();
      const second = service.sync();
      resolveRead(accountSnapshot());
      await Promise.all([first, second]);

      expect(events).toHaveLength(1);
    } finally {
      cache.close();
    }
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

  it("uses the last complete reconciliation for an overlapping incremental read and retains unchanged cached items", async () => {
    const cache = openCache({ path: await createCachePath() });
    const reads: Array<{ updatedSince: string | null } | undefined> = [];
    const fullAt = new Date().toISOString();
    const secondItem = issueItem();
    const client: SyncClient = {
      async readAccountSnapshot(input) {
        reads.push(input);
        return reads.length === 1
          ? accountSnapshot({ fetchedAt: fullAt, items: [issueItem(), { ...pullRequestItem(), id: "PR_unchanged" }] })
          : accountSnapshot({
            fetchedAt: new Date().toISOString(),
            items: [{ ...secondItem, title: "Updated after the full pass" }],
            scope: { ...accountSnapshot().scope, reconciliation: "incremental", lastFullReconciliationAt: fullAt },
          });
      },
      async readRelationshipEnrichment({ nodeIds }) {
        return completeEnrichment(nodeIds);
      },
    };

    try {
      const service = createSyncService({ cache, client });
      await service.sync();
      await service.sync();

      expect(reads).toEqual([{ updatedSince: null }, { updatedSince: fullAt }]);
      expect(cache.getActiveSnapshot()?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "I_fixture_1", title: "Updated after the full pass" }),
        expect.objectContaining({ id: "PR_unchanged", title: "Ship the fixture" }),
      ]));
      expect(cache.getActiveSnapshot()?.scope).toMatchObject({ reconciliation: "incremental", lastFullReconciliationAt: fullAt });
    } finally {
      cache.close();
    }
  });

  it("forces another full reconciliation after provisioning a webhook, including after a partial catch-up", async () => {
    const cache = openCache({ path: await createCachePath() });
    const reads: Array<{ updatedSince: string | null } | undefined> = [];
    let provisioningRuns = 0;
    const fullAt = "2026-08-23T09:00:00.000Z";
    const client: SyncClient & {
      readOwnedRepositoryInventory(): Promise<{ account: { id: string; login: string }; fetchedAt: string; repositories: [] }>;
    } = {
      async readAccountSnapshot(input) {
        reads.push(input);
        if (reads.length === 2) {
          return accountSnapshot({
            fetchedAt: "2026-08-23T09:05:00.000Z",
            scope: {
              ...accountSnapshot().scope,
              inventoryComplete: false,
              partialReasons: [{ kind: "search_result_limit", itemType: "issue" }],
              status: "partial",
            },
          });
        }
        return accountSnapshot({ fetchedAt: fullAt });
      },
      async readRelationshipEnrichment({ nodeIds }) { return completeEnrichment(nodeIds); },
      async readOwnedRepositoryInventory() {
        return { account: { id: "U_inventory", login: "octo" }, fetchedAt: fullAt, repositories: [] };
      },
    };

    try {
      const service = createSyncService({
        cache,
        client,
        now: () => new Date("2026-08-23T10:00:00.000Z").getTime(),
        webhookProvisioner: {
          async reconcile() {
            const created = provisioningRuns++ === 0 ? 1 : 0;
            return { eligible: created, created, alreadyPresent: 0, failed: 0 };
          },
        },
      });

      await service.sync();
      await service.sync();

      expect(cache.getActiveSnapshot()?.scope.lastFullReconciliationAt).toBeNull();

      await service.sync();

      expect(reads).toEqual([{ updatedSince: null }, { updatedSince: null }, { updatedSince: null }]);
    } finally {
      cache.close();
    }
  });

  it("keeps the reconciliation cursor when provisioning creates no webhook", async () => {
    const cache = openCache({ path: await createCachePath() });
    const reads: Array<{ updatedSince: string | null } | undefined> = [];
    const fullAt = "2026-08-23T09:00:00.000Z";
    const client: SyncClient & {
      readOwnedRepositoryInventory(): Promise<{ account: { id: string; login: string }; fetchedAt: string; repositories: [] }>;
    } = {
      async readAccountSnapshot(input) {
        reads.push(input);
        return reads.length === 1
          ? accountSnapshot({ fetchedAt: fullAt })
          : accountSnapshot({
            fetchedAt: "2026-08-23T09:05:00.000Z",
            scope: { ...accountSnapshot().scope, reconciliation: "incremental", lastFullReconciliationAt: fullAt },
          });
      },
      async readRelationshipEnrichment({ nodeIds }) { return completeEnrichment(nodeIds); },
      async readOwnedRepositoryInventory() {
        return { account: { id: "U_inventory", login: "octo" }, fetchedAt: fullAt, repositories: [] };
      },
    };

    try {
      const service = createSyncService({
        cache,
        client,
        now: () => new Date("2026-08-23T10:00:00.000Z").getTime(),
        webhookProvisioner: { async reconcile() { return { eligible: 0, created: 0, alreadyPresent: 0, failed: 0 }; } },
      });

      await service.sync();
      await service.sync();

      expect(reads).toEqual([{ updatedSince: null }, { updatedSince: fullAt }]);
    } finally {
      cache.close();
    }
  });

  it("forces the next sync full when provisioning creates a webhook during an incremental sync", async () => {
    const cache = openCache({ path: await createCachePath() });
    const reads: Array<{ updatedSince: string | null } | undefined> = [];
    const fullAt = "2026-08-23T09:00:00.000Z";
    const client: SyncClient & {
      readOwnedRepositoryInventory(): Promise<{ account: { id: string; login: string }; fetchedAt: string; repositories: [] }>;
    } = {
      async readAccountSnapshot(input) {
        reads.push(input);
        return reads.length === 1
          ? accountSnapshot({ fetchedAt: fullAt })
          : accountSnapshot({
            fetchedAt: "2026-08-23T09:05:00.000Z",
            scope: reads.length === 2
              ? { ...accountSnapshot().scope, reconciliation: "incremental", lastFullReconciliationAt: fullAt }
              : accountSnapshot().scope,
          });
      },
      async readRelationshipEnrichment({ nodeIds }) { return completeEnrichment(nodeIds); },
      async readOwnedRepositoryInventory() {
        return { account: { id: "U_inventory", login: "octo" }, fetchedAt: fullAt, repositories: [] };
      },
    };
    let provisioningRuns = 0;

    try {
      const service = createSyncService({
        cache,
        client,
        now: () => new Date("2026-08-23T10:00:00.000Z").getTime(),
        webhookProvisioner: {
          async reconcile() {
            const created = provisioningRuns++ === 1 ? 1 : 0;
            return { eligible: created, created, alreadyPresent: 0, failed: 0 };
          },
        },
      });

      await service.sync();
      await service.sync();
      await service.sync();

      expect(reads).toEqual([{ updatedSince: null }, { updatedSince: fullAt }, { updatedSince: null }]);
    } finally {
      cache.close();
    }
  });

  it("runs another full reconciliation at the 24-hour boundary", async () => {
    const cache = openCache({ path: await createCachePath() });
    const fullAt = "2026-08-23T09:00:00.000Z";
    const reads: Array<{ updatedSince: string | null } | undefined> = [];
    const client: SyncClient = {
      async readAccountSnapshot(input) {
        reads.push(input);
        return accountSnapshot({ fetchedAt: fullAt });
      },
      async readRelationshipEnrichment({ nodeIds }) {
        return completeEnrichment(nodeIds);
      },
    };
    try {
      const service = createSyncService({
        cache,
        client,
        now: () => new Date("2026-08-24T09:00:00.000Z").getTime(),
      });
      await service.sync();
      await service.sync();

      expect(reads).toEqual([{ updatedSince: null }, { updatedSince: null }]);
    } finally {
      cache.close();
    }
  });

  it("enriches all reconciliation items in safe batches before it swaps the active generation", async () => {
    const cache = openCache({ path: await createCachePath() });
    const batches: string[][] = [];
    const items = Array.from({ length: 11 }, (_, index) => ({ ...issueItem(), id: `I_${index}` }));
    const client: SyncClient = {
      async readAccountSnapshot() {
        return accountSnapshot({ items });
      },
      async readRelationshipEnrichment({ nodeIds }) {
        batches.push(nodeIds);
        return completeEnrichment(nodeIds);
      },
    };

    try {
      await createSyncService({ cache, client }).sync();
      expect(batches).toEqual([items.slice(0, 10).map((item) => item.id), ["I_10"]]);
      expect(cache.getActiveSnapshot()?.items.every((item) => item.relationshipCoverage.blocker === "complete")).toBe(true);
    } finally {
      cache.close();
    }
  });

  it("does not drop prior cached items when GitHub reports a capped partial full read", async () => {
    const cache = openCache({ path: await createCachePath() });
    try {
      await createSyncService({ cache, client: countingClient(async () => accountSnapshot({
        fetchedAt: "2026-08-20T10:00:00.000Z",
        items: [issueItem(), { ...pullRequestItem(), id: "PR_retained" }],
      })) }).sync();
      const cappedClient: SyncClient = {
        async readAccountSnapshot() {
          return accountSnapshot({
            fetchedAt: new Date().toISOString(),
            items: [issueItem()],
            scope: {
              ...accountSnapshot().scope,
              inventoryComplete: false,
              partialReasons: [{ kind: "search_result_limit", itemType: "issue" }],
              status: "partial",
            },
          });
        },
        async readRelationshipEnrichment({ nodeIds }) {
          return completeEnrichment(nodeIds);
        },
      };

      await createSyncService({ cache, client: cappedClient }).sync();

      expect(cache.getActiveSnapshot()?.items.map((item) => item.id)).toEqual(["I_fixture_1", "PR_retained"]);
      expect(cache.getActiveSnapshot()?.scope.truncatedReason).toBe("search_result_limit");
    } finally {
      cache.close();
    }
  });

  it("stops later enrichment batches after an unavailable read and exposes its rate limit", async () => {
    const cache = openCache({ path: await createCachePath() });
    const items = Array.from({ length: 11 }, (_, index) => ({ ...issueItem(), id: `I_${index}` }));
    const batches: string[][] = [];
    const client: SyncClient = {
      async readAccountSnapshot() {
        return accountSnapshot({ items });
      },
      async readRelationshipEnrichment({ nodeIds }) {
        batches.push(nodeIds);
        return {
          status: "unavailable" as const,
          error: { code: "rate_limited" as const, message: "GitHub rate limit prevented this read.", retryAfterSeconds: 60 },
          rateLimit: { cost: 3, remaining: 4700, resetAt: "2026-08-23T10:00:00.000Z" },
        };
      },
    };
    try {
      await expect(createSyncService({ cache, client }).sync()).resolves.toMatchObject({
        status: "partial",
        rateLimit: { cost: 15, remaining: 4700, resetAt: "2026-08-23T10:00:00.000Z" },
        scope: { truncatedReason: "relationship_enrichment_failed" },
      });
      expect(batches).toEqual([items.slice(0, 10).map((item) => item.id)]);
      expect(cache.getActiveSnapshot()?.items.every((item) => item.relationshipCoverage.blocker !== "complete")).toBe(true);
    } finally {
      cache.close();
    }
  });

  it("reconciles webhooks from a separate complete repository inventory inside the shared sync", async () => {
    const cache = openCache({ path: await createCachePath() });
    const calls: string[] = [];
    const client: SyncClient & {
      readOwnedRepositoryInventory(): Promise<{ account: { id: string; login: string }; fetchedAt: string; repositories: [] }>;
    } = {
      async readAccountSnapshot() { return accountSnapshot(); },
      async readRelationshipEnrichment({ nodeIds }) { return completeEnrichment(nodeIds); },
      async readOwnedRepositoryInventory() {
        calls.push("inventory");
        return { account: { id: "U_inventory", login: "octo" }, fetchedAt: "2026-08-24T12:00:00.000Z", repositories: [] };
      },
    };
    const events: Array<Record<string, unknown>> = [];

    try {
      const service = createSyncService({
        cache,
        client,
        webhookProvisioner: {
          async reconcile(inventory) {
            calls.push(`provision:${inventory.account.id}`);
            return { eligible: 0, created: 0, alreadyPresent: 0, failed: 0 };
          },
        },
        logEvent: (event) => events.push(event),
      });
      await Promise.all([service.sync(), service.sync()]);

      expect(calls).toEqual(["inventory", "provision:U_inventory"]);
      expect(events).toContainEqual(expect.objectContaining({
        event: "webhook.provisioning.finished",
        status: "complete",
        eligibleCount: 0,
      }));
    } finally {
      cache.close();
    }
  });

  it("skips provisioning after an incomplete inventory and never puts inventory identities in logs", async () => {
    const cache = openCache({ path: await createCachePath() });
    const events: Array<Record<string, unknown>> = [];
    const inventorySentinel = "repository-identity-SENTINEL";
    const client: SyncClient = {
      async readAccountSnapshot() { return accountSnapshot(); },
      async readRelationshipEnrichment({ nodeIds }) { return completeEnrichment(nodeIds); },
      async readOwnedRepositoryInventory() {
        return {
          status: "unavailable" as const,
          error: { code: "unavailable" as const, message: inventorySentinel },
        };
      },
    };

    try {
      await createSyncService({
        cache,
        client,
        webhookProvisioner: { async reconcile() { throw new Error("must not reconcile"); } },
        logEvent: (event) => events.push(event),
      }).sync();

      expect(events).toContainEqual(expect.objectContaining({
        event: "webhook.provisioning.finished",
        status: "skipped",
        errorCode: "inventory_unavailable",
      }));
      expect(JSON.stringify(events)).not.toContain(inventorySentinel);
      expect(cache.getActiveSnapshot()?.scope.lastFullReconciliationAt).toBe("2026-08-23T09:00:00.000Z");
    } finally {
      cache.close();
    }
  });

  it("keeps the reconciliation cursor when webhook provisioning fails", async () => {
    const cache = openCache({ path: await createCachePath() });
    const client: SyncClient & {
      readOwnedRepositoryInventory(): Promise<{ account: { id: string; login: string }; fetchedAt: string; repositories: [] }>;
    } = {
      async readAccountSnapshot() { return accountSnapshot(); },
      async readRelationshipEnrichment({ nodeIds }) { return completeEnrichment(nodeIds); },
      async readOwnedRepositoryInventory() {
        return { account: { id: "U_inventory", login: "octo" }, fetchedAt: "2026-08-23T09:00:00.000Z", repositories: [] };
      },
    };

    try {
      await createSyncService({
        cache,
        client,
        webhookProvisioner: { async reconcile() { throw new Error("provisioning failed"); } },
      }).sync();

      expect(cache.getActiveSnapshot()?.scope.lastFullReconciliationAt).toBe("2026-08-23T09:00:00.000Z");
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
    async readRelationshipEnrichment({ nodeIds }: { nodeIds: string[] }) {
      return {
        requestedCount: nodeIds.length,
        readCount: nodeIds.length,
        subjectLimit: 10,
        status: "complete" as const,
        subjects: nodeIds.map((nodeId) => ({
          nodeId,
          status: "read" as const,
          coverage: { blocker: "unavailable" as const, closing_issue: "unavailable" as const },
          relationships: [],
          relatedItems: [],
        })),
      };
    },
  };
  return client;
}

function completeEnrichment(nodeIds: string[]) {
  return {
    requestedCount: nodeIds.length,
    readCount: nodeIds.length,
    subjectLimit: 10,
    status: "complete" as const,
    subjects: nodeIds.map((nodeId) => ({
      nodeId,
      status: "read" as const,
      coverage: { blocker: "complete" as const, closing_issue: "not_sampled" as const },
      relationships: [],
      relatedItems: [],
    })),
  };
}

function accountSnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    account: { id: "U_fixture", login: "octofixture" },
    fetchedAt: "2026-08-23T09:00:00.000Z",
    rateLimit: { cost: 12, remaining: 4888, resetAt: "2026-08-23T10:00:00.000Z" },
    repositories: [{ id: "R_fixture", nameWithOwner: "octofixture/example-widgets" }],
    items: [issueItem(), pullRequestItem()],
    scope: {
      reconciliation: "full",
      lastFullReconciliationAt: "2026-08-23T09:00:00.000Z",
      inventoryComplete: true,
      searchPageSize: 100,
      searchResultLimit: 1_000,
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
