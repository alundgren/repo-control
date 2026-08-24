import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Cache } from "../cache/index.js";
import { emitLogEvent, type LogEventSink } from "../observability/index.js";
import type { ItemRefreshService, UpsertOutcome } from "../refresh/index.js";
import type { DeliveryRecord, DeliveryStore } from "./store.js";

const DELIVERY_RETENTION_DAYS = 30;
const DEFAULT_BODY_LIMIT = 256 * 1024;
const MAX_DELIVERY_ATTEMPTS = 3;

export type WebhookService = {
  accept(request: { body: Buffer; signature: string | undefined; deliveryId: string | undefined; eventName: string | undefined }): Promise<AcceptResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type AcceptResult =
  | { status: "accepted"; duplicate: boolean }
  | { status: "rejected"; code: "invalid_signature" | "invalid_payload" | "payload_too_large" };

export function createWebhookService({
  secret,
  store,
  cache,
  refreshService,
  logEvent,
  now = () => new Date(),
  bodyLimit = DEFAULT_BODY_LIMIT,
}: {
  secret: string;
  store: DeliveryStore;
  cache: Cache;
  refreshService: ItemRefreshService;
  logEvent?: LogEventSink;
  now?: () => Date;
  bodyLimit?: number;
}): WebhookService {
  let running = false;
  let processing: Promise<void> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeAt: number | null = null;

  async function processPending() {
    if (processing) return processing;
    processing = (async () => {
      while (running) {
        const pending = store.takePending(now().toISOString());
        if (pending.length === 0) break;
        for (const delivery of pending) {
          await processDelivery(delivery);
        }
      }
    })().finally(() => {
      processing = null;
      scheduleWake();
    });
    return processing;
  }

  return {
    async accept({ body, signature, deliveryId, eventName }) {
      if (body.length > bodyLimit) return { status: "rejected", code: "payload_too_large" };
      if (!signature || !isValidSignature(body, signature, secret)) {
        return { status: "rejected", code: "invalid_signature" };
      }
      const record = normalizeDelivery(body, deliveryId, eventName);
      if (!record) return { status: "rejected", code: "invalid_payload" };
      const accepted = store.accept(record, now().toISOString());
      void processPending().catch(() => emitLogEvent(logEvent, {
        event: "webhook.worker.failed",
        level: "error",
        status: "failed",
        errorCode: "worker_failed",
      }));
      return { status: "accepted", duplicate: !accepted };
    },
    async start() {
      running = true;
      store.recoverProcessing(now().toISOString());
      await processPending();
    },
    async stop() {
      running = false;
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      wakeAt = null;
      await processing;
    },
  };

  async function processDelivery(delivery: Awaited<ReturnType<DeliveryStore["takePending"]>>[number]) {
    const { deliveryId, target, eventName } = delivery;
    try {
      const timestamp = now();
      store.prune(new Date(timestamp.getTime() - DELIVERY_RETENTION_DAYS * 86_400_000).toISOString());
      if (!target || (eventName !== "issues" && eventName !== "pull_request")) {
        store.finish(deliveryId, "manual_reconciliation", "unsupported_event", timestamp.toISOString());
        logDelivery(delivery, "manual_reconciliation", "unsupported_event", logEvent);
        return;
      }

      const cached = cache.getItem(target.nodeId);
      if (cached) {
        const outcome = await refreshService.refreshItem({ nodeId: target.nodeId });
        finishRefresh(delivery, outcome, timestamp);
        return;
      }
      if (isUpsertAction(target.action)) {
        const outcome = refreshService.upsertItem
          ? await refreshService.upsertItem({ nodeId: target.nodeId })
          : ({ status: "failed", error: { code: "cache_write_failed" }, rateLimit: null } satisfies UpsertOutcome);
        finishUpsert(delivery, outcome, timestamp);
        return;
      }
      store.finish(deliveryId, "succeeded", "uncached_item_out_of_loaded_scope", timestamp.toISOString());
      logDelivery(delivery, "succeeded", "uncached_item_out_of_loaded_scope", logEvent);
    } catch {
      const result = retryOrReconcile(delivery, "processing_failed", null, null, now());
      logDelivery(delivery, result.status, "processing_failed", logEvent, result.retryDelayMs);
    }
  }

  function finishRefresh(delivery: Awaited<ReturnType<DeliveryStore["takePending"]>>[number], outcome: Awaited<ReturnType<ItemRefreshService["refreshItem"]>>, timestamp: Date) {
    if (outcome.status === "updated" || outcome.status === "removed" || outcome.status === "not_found") {
      store.finish(delivery.deliveryId, "succeeded", outcome.status, timestamp.toISOString());
      logDelivery(delivery, "succeeded", outcome.status, logEvent);
    } else {
      const result = retryOrReconcile(delivery, outcome.error.code, retryAfter(outcome.error), retryAt(outcome.error), timestamp, outcome.error.code === "authentication_failed");
      logDelivery(delivery, result.status, outcome.error.code, logEvent, result.retryDelayMs);
    }
  }

  function finishUpsert(delivery: Awaited<ReturnType<DeliveryStore["takePending"]>>[number], outcome: UpsertOutcome, timestamp: Date) {
    if (outcome.status === "updated" || outcome.status === "removed" || outcome.status === "not_found") {
      store.finish(delivery.deliveryId, "succeeded", outcome.status, timestamp.toISOString());
      logDelivery(delivery, "succeeded", outcome.status, logEvent);
    } else {
      const result = retryOrReconcile(delivery, outcome.error.code, retryAfter(outcome.error), retryAt(outcome.error), timestamp, outcome.error.code === "authentication_failed");
      logDelivery(delivery, result.status, outcome.error.code, logEvent, result.retryDelayMs);
    }
  }

  function retryOrReconcile(
    delivery: Awaited<ReturnType<DeliveryStore["takePending"]>>[number],
    detail: string,
    retryAfterSeconds: number | null,
    retryAtValue: string | null,
    timestamp: Date,
    reconcileNow = false,
  ): { status: "retry_scheduled" | "manual_reconciliation"; retryDelayMs?: number } {
    if (reconcileNow || delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
      store.finish(delivery.deliveryId, "manual_reconciliation", detail, timestamp.toISOString());
      return { status: "manual_reconciliation" };
    }
    const retryAtDelay = retryAtValue ? Math.max(0, new Date(retryAtValue).getTime() - timestamp.getTime()) : null;
    const delay = retryAtDelay ?? Math.min(60_000, Math.max(1_000, (retryAfterSeconds ?? 2 ** delivery.attempts) * 1_000));
    store.retry(delivery.deliveryId, detail, new Date(timestamp.getTime() + delay).toISOString(), timestamp.toISOString());
    return { status: "retry_scheduled", retryDelayMs: delay };
  }

  function retryAfter(error: { code: string; retryAfterSeconds?: number }) {
    return error.retryAfterSeconds ?? null;
  }

  function retryAt(error: { code: string; retryAt?: string }) {
    return error.retryAt ?? null;
  }

  function scheduleWake() {
    if (!running) return;
    const next = store.nextAvailableAt();
    if (!next) {
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      wakeAt = null;
      return;
    }
    const nextAt = new Date(next).getTime();
    if (wakeTimer && wakeAt === nextAt) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeAt = nextAt;
    const delay = Math.max(0, nextAt - now().getTime());
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      wakeAt = null;
      void processPending().catch(() => emitLogEvent(logEvent, {
        event: "webhook.worker.failed",
        level: "error",
        status: "failed",
        errorCode: "worker_failed",
      }));
    }, delay);
  }
}

function logDelivery(
  delivery: Awaited<ReturnType<DeliveryStore["takePending"]>>[number],
  status: "succeeded" | "retry_scheduled" | "manual_reconciliation",
  detail: string,
  logEvent?: LogEventSink,
  retryDelayMs?: number,
) {
  emitLogEvent(logEvent, {
    event: "webhook.delivery.finished",
    level: status === "succeeded" ? "info" : "warn",
    status,
    deliveryId: delivery.deliveryId,
    eventName: delivery.eventName,
    action: delivery.target?.action ?? null,
    itemType: delivery.target?.itemType ?? null,
    attempt: delivery.attempts,
    detail,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
  });
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  service: WebhookService,
  { bodyLimit = DEFAULT_BODY_LIMIT } = {},
) {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.post<{ Body: Buffer }>(
    "/webhooks/github",
    { bodyLimit },
    async (request, reply) => {
      const result = await service.accept({
        body: Buffer.isBuffer(request.body) ? request.body : Buffer.from([]),
        signature: header(request, "x-hub-signature-256"),
        deliveryId: header(request, "x-github-delivery"),
        eventName: header(request, "x-github-event"),
      });
      if (result.status === "accepted") return reply.code(202).send({ status: "accepted" });
      return reply.code(result.code === "payload_too_large" ? 413 : 401).send({ status: "error", error: { code: result.code } });
    },
  );
}

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function isValidSignature(body: Buffer, signature: string, secret: string) {
  if (!signature.startsWith("sha256=")) return false;
  const provided = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function normalizeDelivery(body: Buffer, deliveryId: string | undefined, eventName: string | undefined): DeliveryRecord | null {
  if (!deliveryId || !eventName) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const raw = eventName === "issues" ? payload.issue : eventName === "pull_request" ? payload.pull_request : null;
  if (!isRecord(raw) || typeof raw.node_id !== "string" || !Number.isInteger(raw.number) || !isRecord(payload.repository)) {
    return { deliveryId, eventName, target: null };
  }
  const repository = payload.repository;
  return {
    deliveryId,
    eventName,
    target: {
      nodeId: raw.node_id,
      repositoryId: typeof repository.node_id === "string" ? repository.node_id : null,
      itemType: eventName === "issues" ? "issue" : "pull_request",
      number: raw.number as number,
      action: typeof payload.action === "string" ? payload.action : "unknown",
    },
  };
}

function isUpsertAction(action: string) {
  return action === "opened" || action === "reopened" || action === "transferred";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
