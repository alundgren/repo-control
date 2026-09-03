import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactService } from "../artifact/index.js";
import { openCache, type Cache, type CacheItem, type SuccessfulSnapshot } from "../cache/index.js";
import type { ItemRefreshService } from "../refresh/index.js";
import type { GitHubReadClient } from "../github/read-client.js";
import { createOperationalLogger } from "../observability/index.js";
import type { SyncService } from "../sync/index.js";
import { createApp, type AppOptions } from "./app.js";

describe("application server", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("reports its health without exposing runtime details", async () => {
    const { app } = await buildApp();

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("serves the browser shell from the configured build directory", async () => {
    const { app } = await buildApp();

    try {
      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("<main>Browser shell</main>");
    } finally {
      await app.close();
    }
  });

  it("returns complete, partial, bounded, and unavailable pull-request diff reads without caching", async () => {
    const outcomes: Awaited<ReturnType<GitHubReadClient["readPullRequestDiff"]>>[] = [
      {
        status: "complete",
        headSha: "abc123",
        fileCount: 1,
        files: [{ path: "src/complete.ts", previousPath: null, changeType: "modified", additions: 1, deletions: 0, patch: { status: "available", text: "@@ -0,0 +1 @@\n+hello" } }],
        groups: [{ name: "src", fileIndexes: [0] }],
        rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-08-24T12:00:00.000Z" },
      },
      {
        status: "partial",
        headSha: "def456",
        fileCount: 3000,
        files: [],
        groups: [],
        partialReason: "file_limit",
        rateLimit: { cost: 31, remaining: 4969, resetAt: "2026-08-24T12:00:00.000Z" },
      },
      {
        status: "complete",
        headSha: "ghi789",
        fileCount: 1,
        files: [{ path: "src/bounded.ts", previousPath: null, changeType: "modified", additions: 20, deletions: 0, patch: { status: "unavailable", reason: "patch_budget" } }],
        groups: [{ name: "src", fileIndexes: [0] }],
        rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-08-24T12:00:00.000Z" },
      },
      { status: "unavailable", error: { code: "rate_limited", message: "GitHub rate limit prevented this read.", retryAfterSeconds: 60 } },
    ];
    const requests: unknown[] = [];
    const { app, cache } = await buildApp({
      diffClient: {
        async readPullRequestDiff(input) {
          requests.push(input);
          return outcomes.shift()!;
        },
      },
    });

    try {
      cache.replaceActiveSnapshot(snapshot());
      for (const expectedStatus of ["complete", "partial", "complete", "unavailable"]) {
        const response = await app.inject({ method: "GET", url: "/api/items/PR_1/diff" });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({ status: expectedStatus });
      }
      expect(requests).toEqual(Array.from({ length: 4 }, () => ({ repositoryNameWithOwner: "octo-user/fictional", number: 4 })));
    } finally {
      await app.close();
    }
  });

  it("does not register artifact routes unless an artifact service is configured", async () => {
    const { app } = await buildApp();
    const id = "a".repeat(32);

    try {
      expect((await app.inject({ method: "POST", url: "/api/artifacts/archify", headers: { "content-type": "text/html" }, payload: "fixture" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/public/${id}/view` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("registers artifact upload and public routes when an artifact service is configured", async () => {
    const id = "a".repeat(32);
    const service: ArtifactService = {
      publish(type) {
        return {
          id,
          type,
          createdAt: "2026-08-31T10:00:00.000Z",
          deleteAfter: "2026-09-30T10:00:00.000Z",
          viewUrl: `https://artifacts.example.test/public/${id}/view`,
          downloadUrl: `https://artifacts.example.test/public/${id}/download`,
        };
      },
      find() {
        return {
          id,
          type: "archify",
          content: Buffer.from("<!doctype html><title>Fixture</title>"),
          appearance: null,
          createdAt: "2026-08-31T10:00:00.000Z",
          deleteAfter: "2026-09-30T10:00:00.000Z",
        };
      },
      start() {},
      stop() {},
    };
    const { app } = await buildApp({ artifactService: service });

    try {
      expect((await app.inject({ method: "POST", url: "/api/artifacts/archify", headers: { "content-type": "text/html" }, payload: "fixture" })).statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: "/api/artifacts/presentation", headers: { "content-type": "text/html" }, payload: "fixture" })).statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: "/api/artifacts/mockup", headers: { "content-type": "text/html" }, payload: "fixture" })).statusCode).toBe(201);
      expect((await app.inject({ method: "GET", url: `/public/${id}/view` })).statusCode).toBe(200);
      expect((await app.inject({ method: "HEAD", url: `/public/${id}/view` })).statusCode).toBe(404);
      expect((await app.inject({ method: "HEAD", url: `/public/${id}/download` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  describe("GET /api/overview", () => {
    it("reports no data yet with a private no-store response before any sync has completed", async () => {
      const { app } = await buildApp();

      try {
        const response = await app.inject({ method: "GET", url: "/api/overview" });

        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({ status: "empty" });
      } finally {
        await app.close();
      }
    });

    it("returns queues and pull requests built from the cached generation, with no raw fields or token material", async () => {
      const { app, cache } = await buildApp();

      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });
        cache.replaceActiveSnapshot(snapshot());

        const response = await app.inject({ method: "GET", url: "/api/overview" });
        const body = response.json();

        expect(response.headers["cache-control"]).toBe("no-store");
        expect(body.status).toBe("ready");
        expect(body.queues).toEqual([
          { name: "agent", issues: [expect.objectContaining({ id: "I_issue_1" })] },
          { name: "triage", issues: [] },
        ]);
        expect(body.pullRequests).toEqual([expect.objectContaining({ id: "PR_1", type: "pull_request" })]);
        expect(Object.keys(body.queues[0].issues[0]).sort()).toEqual(
          ["createdAt", "epic", "excerpt", "id", "number", "observedAt", "queue", "readiness", "repositoryId", "subIssues", "title", "type", "updatedAt", "url"].sort(),
        );
        expect(Object.keys(body.pullRequests[0]).sort()).toEqual(
          [
            "additions",
            "closingIssues",
            "createdAt",
            "deletions",
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
        await app.close();
      }
    });
  });

  describe("POST /api/sync", () => {
    it("reports a successful sync without leaking rate-limit internals", async () => {
      const { app } = await buildApp({
        syncService: {
          async sync() {
            return {
              status: "complete",
              generationId: 1,
              fetchedAt: "2026-08-23T10:00:00.000Z",
              scope: { repositoryLimit: 50, repositoryCount: 1, itemLimit: 200, itemCount: 1, truncatedReason: null },
              rateLimit: { cost: 3, remaining: 4997, resetAt: "2026-08-23T11:00:00.000Z" },
            };
          },
        },
      });

      try {
        const response = await app.inject({ method: "POST", url: "/api/sync" });

        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({
          status: "complete",
          fetchedAt: "2026-08-23T10:00:00.000Z",
          scope: { repositoryLimit: 50, repositoryCount: 1, itemLimit: 200, itemCount: 1, truncatedReason: null },
        });
      } finally {
        await app.close();
      }
    });

    it("reports a failed sync with a safe error code and no raw GitHub message", async () => {
      const { app } = await buildApp({
        syncService: {
          async sync() {
            return {
              status: "failed",
              error: { code: "authentication_failed", message: "internal detail that must never leave the server" },
              rateLimit: null,
              activeSnapshot: null,
            };
          },
        },
      });

      try {
        const response = await app.inject({ method: "POST", url: "/api/sync" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          status: "failed",
          error: { code: "authentication_failed" },
          lastSuccessfulSync: null,
        });
        expect(response.body).not.toContain("internal detail");
      } finally {
        await app.close();
      }
    });
  });

  describe("POST /api/items/:nodeId/refresh", () => {
    it("returns a successful typed response when the item is not cached", async () => {
      const { app } = await buildApp({
        refreshService: {
          async refreshItem() {
            return { status: "not_found" };
          },
        },
      });

      try {
        const response = await app.inject({ method: "POST", url: "/api/items/I_missing/refresh" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "not_found" });
      } finally {
        await app.close();
      }
    });

    it("rejects an empty node id with a safe, generic validation error and no schema detail", async () => {
      const { app } = await buildApp();

      try {
        const response = await app.inject({ method: "POST", url: "/api/items//refresh" });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ status: "error", error: { code: "invalid_request" } });
      } finally {
        await app.close();
      }
    });

    it("returns 200 with the cached fallback item and a code-only error when a refresh cannot complete", async () => {
      const { app, cache } = await buildApp({
        refreshService: {
          async refreshItem() {
            return {
              status: "failed",
              error: { code: "rate_limited", message: "internal detail that must never leave the server", retryAfterSeconds: 60 },
              rateLimit: null,
              cachedItem: issue({ id: "I_issue_1", labels: ["ready-for-agent"] }),
            };
          },
        },
      });

      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });

        const response = await app.inject({ method: "POST", url: "/api/items/I_issue_1/refresh" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          status: "failed",
          error: { code: "rate_limited", retryAfterSeconds: 60 },
          item: expect.objectContaining({ id: "I_issue_1", queue: "agent" }),
        });
        expect(response.body).not.toContain("internal detail");
      } finally {
        await app.close();
      }
    });

    it("returns a redacted 500 instead of a stack trace when a handler throws unexpectedly", async () => {
      const { app } = await buildApp({
        refreshService: {
          async refreshItem() {
            throw new Error("internal detail that must never leave the server");
          },
        },
      });

      try {
        const response = await app.inject({ method: "POST", url: "/api/items/I_issue_1/refresh" });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ status: "error", error: { code: "unavailable" } });
        expect(response.body).not.toContain("internal detail");
      } finally {
        await app.close();
      }
    });

    it("logs only a safe route template and classification when a handler throws", async () => {
      const output: string[] = [];
      const logger = createOperationalLogger(new Writable({
        write(chunk, _encoding, callback) {
          output.push(chunk.toString());
          callback();
        },
      }));
      const sentinel = "fixture-error-must-not-be-logged";
      const { app } = await buildApp({
        logger,
        refreshService: {
          async refreshItem() {
            throw new Error(sentinel);
          },
        },
      });

      try {
        await app.inject({ method: "POST", url: "/api/items/I_fixture/refresh" });

        expect(output.join("\n")).toContain('"event":"api.request.failed"');
        expect(output.join("\n")).toContain('"route":"/api/items/:nodeId/refresh"');
        expect(output.join("\n")).not.toContain(sentinel);
      } finally {
        await app.close();
      }
    });

    it("returns the classified item on a successful focused refresh", async () => {
      const { app, cache } = await buildApp({
        refreshService: {
          async refreshItem(input) {
            expect(input.nodeId).toBe("I_issue_1");
            return {
              status: "updated",
              item: issue({ id: "I_issue_1", labels: ["ready-for-agent"] }),
              fetchedAt: "2026-08-23T10:00:00.000Z",
              relationshipStatus: "fresh",
              rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-23T11:00:00.000Z" },
            };
          },
        },
      });

      try {
        cache.replaceQueueMapping({ defaultQueue: "triage", labels: [{ label: "ready-for-agent", queue: "agent" }] });

        const response = await app.inject({ method: "POST", url: "/api/items/I_issue_1/refresh" });

        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({
          status: "updated",
          item: { id: "I_issue_1", type: "issue", queue: "agent", readiness: { kind: "unblocked" } },
        });
      } finally {
        await app.close();
      }
    });
  });

  async function buildApp(overrides: Partial<Pick<AppOptions, "syncService" | "refreshService" | "logger" | "artifactService" | "diffClient">> = {}) {
    const webRoot = await createWebRoot();
    const dataDirectory = await mkdtemp(join(tmpdir(), "repo-control-data-"));
    temporaryDirectories.push(dataDirectory);
    const cache = openCache({ path: join(dataDirectory, "repo-control.sqlite") });
    temporaryCaches.push(cache);

    const syncService: SyncService = overrides.syncService ?? {
      async sync() {
        throw new Error("sync should not be called in this test");
      },
    };
    const refreshService: ItemRefreshService = overrides.refreshService ?? {
      async refreshItem() {
        throw new Error("refreshItem should not be called in this test");
      },
    };

    const diffClient = overrides.diffClient ?? { async readPullRequestDiff() { throw new Error("readPullRequestDiff should not be called in this test"); } };
    const app = await createApp({ webRoot, cache, syncService, refreshService, diffClient, logger: overrides.logger, artifactService: overrides.artifactService });
    return { app, cache };
  }

  const temporaryCaches: Cache[] = [];
  afterEach(() => {
    temporaryCaches.splice(0).forEach((cache) => cache.close());
  });

  async function createWebRoot() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><main>Browser shell</main>",
    );

    return directory;
  }
});

function snapshot(): SuccessfulSnapshot {
  return {
    account: { id: "U_account", login: "octo-user" },
    fetchedAt: "2026-08-23T10:00:00.000Z",
    repositories: [{ id: "R_repo_1", nameWithOwner: "octo-user/fictional" }],
    items: [
      issue({ id: "I_issue_1", labels: ["ready-for-agent"] }),
      {
        id: "PR_1",
        repositoryId: "R_repo_1",
        number: 4,
        title: "Fictional pull request",
        body: "Fictional body",
        url: "https://github.test/fictional/pull/4",
        updatedAt: "2026-08-23T10:00:00.000Z",
        labels: [],
        relationships: [],
        relationshipCoverage: { blocker: "not_sampled", closing_issue: "complete", parent: "not_sampled" },
        type: "pull_request",
        pullRequest: { additions: 2, deletions: 0, isDraft: false },
      },
    ],
    scope: { itemCount: 2, itemLimit: 200, repositoryCount: 1, repositoryLimit: 50, truncatedReason: null },
  };
}

function issue({ id, labels }: { id: string; labels: string[] }): CacheItem & { type: "issue" } {
  return {
    id,
    repositoryId: "R_repo_1",
    number: 17,
    title: "Fictional issue",
    body: "Fictional body",
    url: `https://github.test/fictional/issues/17`,
    updatedAt: "2026-08-23T10:00:00.000Z",
    labels: labels.map((name, index) => ({ id: `L_${index}`, name })),
    relationships: [],
    relationshipCoverage: { blocker: "complete", closing_issue: "complete", parent: "complete" },
    type: "issue",
  };
}
