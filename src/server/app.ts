import fastify, { LogController, type FastifyBaseLogger, type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";

import { apiPlugin, type ApiPluginOptions } from "../api/plugin.js";
import { buildOverview, toApiItem } from "../api/read-models.js";
import { artifactPlugin, type ArtifactService } from "../artifact/index.js";
import type { ChangeEventHub } from "../events/index.js";
import { registerWebhookRoutes, type WebhookService } from "../webhook/index.js";

export type AppOptions = {
  webRoot: string;
  logger?: FastifyBaseLogger;
  eventHub?: ChangeEventHub;
  webhookService?: WebhookService;
  artifactService?: ArtifactService;
} & ApiPluginOptions;

export async function createApp({ webRoot, logger, cache, syncService, refreshService, diffClient, reviewService, mergeService, eventHub, webhookService, artifactService, logEvent }: AppOptions) {
  const app = logger
    ? fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }) })
    : fastify();

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    try {
      request.log.error({
        event: "http.request.failed",
        statusCode,
        route: request.routeOptions.url,
        requestId: request.id,
        errorCode: statusCode >= 400 && statusCode < 500 ? "invalid_request" : "unavailable",
      }, "http request failed");
    } catch {
      // Logging must not prevent the safe HTTP error response.
    }
    reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500)
      .send({ status: "error", error: { code: statusCode >= 400 && statusCode < 500 ? "invalid_request" : "unavailable" } });
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(apiPlugin, { prefix: "/api", cache, syncService, refreshService, diffClient, reviewService, mergeService, eventHub, logEvent });

  if (webhookService) {
    await registerWebhookRoutes(app, webhookService);
  }

  if (artifactService) {
    await app.register(artifactPlugin, { service: artifactService });
  }

  app.get("/events", async (request, reply) => {
    if (!eventHub) {
      return reply.code(503).send({ status: "error", error: { code: "unavailable" } });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const unsubscribe = eventHub.subscribe((change) => {
      if (change.status === "settings") {
        reply.raw.write(`event: settings\ndata: ${JSON.stringify({ ...change, type: "settings", status: undefined })}\n\n`);
        return;
      }
      if (change.status === "projection_changed") {
        reply.raw.write("event: item\ndata: {\"type\":\"reconcile\"}\n\n");
        return;
      }
      const repositoryId = change.status === "removed" ? change.repositoryId : change.item.repositoryId;
      if (cache.isRepositoryIgnored(repositoryId)) return;
      const overview = buildOverview(cache);
      const repositories = overview.status === "ready" ? overview.repositories : [];
      const scope = overview.status === "ready" ? overview.scope : { repositoryCount: 0, itemCount: 0, visibleItemCount: 0, visibleRepositoryCount: 0, ignoredRepositoryCount: 0, truncatedReason: null };
      const event = change.status === "updated"
        ? { type: "updated", item: toApiItem(cache, change.item), repositories, scope }
        : { type: "removed", nodeId: change.nodeId, itemType: change.itemType, number: change.number, reason: change.reason, scope };
      reply.raw.write(`event: item\ndata: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", () => {
      unsubscribe();
      if (!reply.raw.destroyed) reply.raw.end();
    });
  });

  await app.register(fastifyStatic, {
    root: webRoot,
  });

  return app;
}
