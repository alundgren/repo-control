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
    });
    const body = Buffer.from(JSON.stringify(issuePayload({ action: "opened" })));
    await service.accept({ body, signature: sign(body, "fixture-secret"), deliveryId: "d-open", eventName: "issues" });
    await service.start();

    expect(upserts).toEqual(["I_fixture"]);
    const pending = store.takePending(new Date().toISOString());
    expect(pending).toEqual([]);

    service.stop();
    store.close();
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

function issuePayload({ action = "edited", nodeId = "I_fixture" }: { action?: string; nodeId?: string } = {}) {
  return {
    action,
    issue: { node_id: nodeId, number: 7 },
    repository: { node_id: "R_fixture" },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
