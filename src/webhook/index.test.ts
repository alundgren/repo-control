import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Cache } from "../cache/index.js";
import type { ItemRefreshService } from "../refresh/index.js";
import { createWebhookService, registerWebhookRoutes } from "./index.js";
import { openDeliveryStore } from "./store.js";

describe("GitHub webhook delivery", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("validates the bounded signed body before accepting an idempotent delivery", async () => {
    const store = await deliveryStore();
    const service = createWebhookService({
      cache: { getItem: () => null } as unknown as Cache,
      refreshService: { refreshItem: async () => ({ status: "not_found" }) } as ItemRefreshService,
      secret: "fixture-secret",
      store,
      bodyLimit: 200,
    });
    const body = Buffer.from(JSON.stringify(issuePayload()));
    const signature = sign(body, "fixture-secret");

    expect(await service.accept({ body, signature: "sha256=wrong", deliveryId: "d-invalid", eventName: "issues" })).toEqual({ status: "rejected", code: "invalid_signature" });
    expect(await service.accept({ body: Buffer.alloc(201), signature, deliveryId: "d-large", eventName: "issues" })).toEqual({ status: "rejected", code: "payload_too_large" });
    expect(await service.accept({ body, signature, deliveryId: "d-1", eventName: "issues" })).toEqual({ status: "accepted", duplicate: false });
    expect(await service.accept({ body, signature, deliveryId: "d-1", eventName: "issues" })).toEqual({ status: "accepted", duplicate: true });

    service.stop();
    store.close();
  });

  it("resumes pending deliveries and uses the uncached focused-upsert path", async () => {
    const store = await deliveryStore();
    const upserts: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const service = createWebhookService({
      cache: { getItem: () => null } as unknown as Cache,
      refreshService: {
        refreshItem: async () => ({ status: "not_found" }),
        upsertItem: async ({ nodeId }) => {
          upserts.push(nodeId);
          return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
      },
      secret: "fixture-secret",
      store,
      logEvent: (event) => events.push(event),
    });
    const payloadSentinel = "fixture-webhook-body-must-not-be-logged";
    const body = Buffer.from(JSON.stringify(issuePayload({ action: "opened", title: payloadSentinel })));
    await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-open", eventName: "issues" });
    await service.start();

    expect(upserts).toEqual(["I_fixture"]);
    expect(events).toEqual([
      expect.objectContaining({
        event: "webhook.delivery.finished",
        status: "succeeded",
        deliveryId: "d-open",
        eventName: "issues",
        action: "opened",
        itemType: "issue",
        detail: "updated",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(payloadSentinel);
    const pending = store.takePending(new Date().toISOString());
    expect(pending).toEqual([]);

    service.stop();
    store.close();
  });

  it("uses the webhook refresh path for cached work", async () => {
    const store = await deliveryStore();
    const refreshes: string[] = [];
    const service = createWebhookService({
      cache: { getItem: () => ({ type: "issue" }) } as unknown as Cache,
      refreshService: {
        refreshItem: async () => { throw new Error("direct refresh must not handle webhook work"); },
        refreshFromWebhook: async ({ nodeId }) => {
          refreshes.push(nodeId);
          return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
      },
      secret: "fixture-secret",
      store,
    });
    const body = Buffer.from(JSON.stringify(issuePayload()));

    try {
      await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-cached", eventName: "issues" });
      await service.start();

      expect(refreshes).toEqual(["I_fixture"]);
      expect(store.takePending(new Date().toISOString())).toEqual([]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("upserts reopened cached work that is absent from the active snapshot", async () => {
    const store = await deliveryStore();
    const upserts: string[] = [];
    const service = createWebhookService({
      cache: {
        getItem: () => ({ type: "issue" }),
        isItemInActiveSnapshot: () => false,
      } as unknown as Cache,
      refreshService: {
        refreshItem: async () => { throw new Error("inactive cached work must use upsert"); },
        upsertItem: async ({ nodeId }) => {
          upserts.push(nodeId);
          return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
      },
      secret: "fixture-secret",
      store,
    });
    const body = Buffer.from(JSON.stringify(issuePayload({ action: "reopened" })));

    try {
      await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-reopened", eventName: "issues" });
      await service.start();

      expect(upserts).toEqual(["I_fixture"]);
      expect(store.takePending(new Date().toISOString())).toEqual([]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("refreshes the parent and child for a sub-issue link delivery", async () => {
    const store = await deliveryStore();
    const refreshes: string[] = [];
    const service = createWebhookService({
      cache: { getItem: () => ({ type: "issue" }) } as unknown as Cache,
      refreshService: {
        refreshItem: async ({ nodeId }) => {
          refreshes.push(nodeId);
          return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
      },
      secret: "fixture-secret",
      store,
    });
    const body = Buffer.from(JSON.stringify(subIssuePayload()));

    try {
      await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-sub-issue", eventName: "sub_issues" });
      await service.start();

      expect(refreshes).toEqual(["I_parent", "I_child"]);
      expect(store.takePending(new Date().toISOString())).toEqual([]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it.each(["blocked_by_added", "blocked_by_removed", "blocking_added", "blocking_removed"])(
    "refreshes the blocked issue for an issue dependency %s delivery",
    async (action) => {
      const store = await deliveryStore();
      const refreshes: string[] = [];
      const service = createWebhookService({
        cache: { getItem: () => ({ type: "issue" }) } as unknown as Cache,
        refreshService: {
          refreshItem: async ({ nodeId }) => {
            refreshes.push(nodeId);
            return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
          },
        },
        secret: "fixture-secret",
        store,
      });
      const body = Buffer.from(JSON.stringify(issueDependencyPayload(action)));

      try {
        await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: `d-${action}`, eventName: "issue_dependencies" });
        await service.start();

        expect(refreshes).toEqual(["I_blocked"]);
        expect(store.takePending(new Date().toISOString())).toEqual([]);
      } finally {
        await service.stop();
        store.close();
      }
    },
  );

  it("refreshes a cached parent before processing a child state change", async () => {
    const store = await deliveryStore();
    const refreshes: string[] = [];
    const service = createWebhookService({
      cache: {
        getItem(nodeId: string) {
          if (nodeId === "I_child") return {
            type: "issue",
            relationshipCoverage: { parent: "complete" },
            relationships: [{ sourceId: "I_child", targetId: "I_parent", type: "parent" }],
          };
          return { type: "issue" };
        },
      } as unknown as Cache,
      refreshService: {
        refreshItem: async ({ nodeId }) => {
          refreshes.push(nodeId);
          return nodeId === "I_child"
            ? { status: "removed", reason: "closed", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } }
            : { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
      },
      secret: "fixture-secret",
      store,
    });
    const body = Buffer.from(JSON.stringify(issuePayload({ action: "closed", nodeId: "I_child" })));

    try {
      await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-child-closed", eventName: "issues" });
      await service.start();

      expect(refreshes).toEqual(["I_parent", "I_child"]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("refreshes the parent discovered while upserting a reopened child", async () => {
    const store = await deliveryStore();
    const calls: string[] = [];
    const service = createWebhookService({
      cache: { getItem: () => null } as unknown as Cache,
      refreshService: {
        refreshItem: async ({ nodeId }) => {
          calls.push(`refresh:${nodeId}`);
          return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
        upsertItem: async ({ nodeId }) => {
          calls.push(`upsert:${nodeId}`);
          return {
            status: "updated",
            item: {
              type: "issue",
              relationshipCoverage: { parent: "complete" },
              relationships: [{ sourceId: nodeId, targetId: "I_parent", type: "parent" }],
            } as never,
            fetchedAt: "now",
            relationshipStatus: "fresh",
            rateLimit: { cost: 1, remaining: 1, resetAt: "later" },
          };
        },
      },
      secret: "fixture-secret",
      store,
    });
    const body = Buffer.from(JSON.stringify(issuePayload({ action: "reopened", nodeId: "I_child" })));

    try {
      await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-child-reopened", eventName: "issues" });
      await service.start();

      expect(calls).toEqual(["upsert:I_child", "refresh:I_parent"]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("keeps a persisted delivery successful when the optional logger fails", async () => {
    const store = await deliveryStore();
    let upsertCount = 0;
    const service = createWebhookService({
      cache: { getItem: () => null } as unknown as Cache,
      refreshService: {
        refreshItem: async () => ({ status: "not_found" }),
        upsertItem: async () => {
          upsertCount += 1;
          return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
      },
      secret: "fixture-secret",
      store,
      logEvent: () => { throw new Error("logger unavailable"); },
    });
    const body = Buffer.from(JSON.stringify(issuePayload({ action: "opened" })));

    try {
      await service.start();
      await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-logger-fails", eventName: "issues" });
      await service.stop();

      expect(upsertCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it("keeps the receiver as the only webhook route and rejects non-POST requests", async () => {
    const app = fastify();
    const service = {
      async accept() {
        return { status: "accepted" as const, duplicate: false };
      },
      async start() {},
      async stop() {},
    };
    await registerWebhookRoutes(app, service);

    const get = await app.inject({ method: "GET", url: "/webhooks/github" });
    const post = await app.inject({ method: "POST", url: "/webhooks/github", payload: "{}", headers: { "content-type": "application/json" } });
    const other = await app.inject({ method: "POST", url: "/webhooks/other", payload: "{}" });

    expect(get.statusCode).toBe(404);
    expect(post.statusCode).toBe(202);
    expect(other.statusCode).toBe(404);
    await app.close();
  });

  it("re-arms the retry wake when a later delivery becomes due sooner", async () => {
    vi.useFakeTimers();
    const store = await deliveryStore();
    let currentTime = new Date("2026-08-23T20:00:00.000Z");
    const calls: string[] = [];
    const service = createWebhookService({
      cache: { getItem: () => ({ type: "issue" }) } as unknown as Cache,
      refreshService: {
        refreshItem: async ({ nodeId }) => {
          calls.push(nodeId);
          const retrySeconds = nodeId === "I_first" ? 60 : calls.filter((call) => call === nodeId).length === 1 ? 1 : null;
          if (retrySeconds !== null) {
            return { status: "failed", error: { code: "rate_limited", message: "retry", retryAfterSeconds: retrySeconds }, rateLimit: null, cachedItem: {} as never };
          }
          return { status: "updated", item: {} as never, fetchedAt: "now", relationshipStatus: "fresh", rateLimit: { cost: 1, remaining: 1, resetAt: "later" } };
        },
      },
      now: () => currentTime,
      secret: "fixture-secret",
      store,
    });

    try {
      await service.start();
      const firstBody = Buffer.from(JSON.stringify(issuePayload({ nodeId: "I_first" })));
      const secondBody = Buffer.from(JSON.stringify(issuePayload({ nodeId: "I_second" })));
      await service.accept({ body: firstBody, signature: sign(firstBody, "fixture-secret"), deliveryId: "d-first", eventName: "issues" });
      await flushPromises();
      await service.accept({ body: secondBody, signature: sign(secondBody, "fixture-secret"), deliveryId: "d-second", eventName: "issues" });
      await flushPromises();

      currentTime = new Date(currentTime.getTime() + 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await flushPromises();

      expect(calls).toEqual(["I_first", "I_second", "I_second"]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  async function deliveryStore() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-webhook-"));
    temporaryDirectories.push(directory);
    return openDeliveryStore({ path: join(directory, "cache.sqlite") });
  }
});

function sign(body: Buffer, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function issuePayload({ action = "edited", nodeId = "I_fixture", title = "Fixture issue" }: { action?: string; nodeId?: string; title?: string } = {}) {
  return {
    action,
    issue: { node_id: nodeId, number: 7, title },
    repository: { node_id: "R_fixture" },
  };
}

function subIssuePayload() {
  return {
    action: "parent_issue_added",
    parent_issue: { node_id: "I_parent", number: 7 },
    sub_issue: { node_id: "I_child", number: 8 },
    repository: { node_id: "R_fixture" },
  };
}

function issueDependencyPayload(action: string) {
  return {
    action,
    blocked_issue: { node_id: "I_blocked", number: 7 },
    blocking_issue: { node_id: "I_blocker", number: 8 },
    repository: { node_id: "R_fixture" },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
