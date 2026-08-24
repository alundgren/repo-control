import fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { apiPlugin, type ApiPluginOptions } from "../api/plugin.js";
import { toApiItem } from "../api/read-models.js";
import type { ChangeEventHub } from "../events/index.js";
import { registerWebhookRoutes, type WebhookService } from "../webhook/index.js";

export type AppOptions = {
  webRoot: string;
  eventHub?: ChangeEventHub;
  webhookService?: WebhookService;
} & ApiPluginOptions;

export async function createApp({ webRoot, cache, syncService, refreshService, eventHub, webhookService }: AppOptions) {
  const app = fastify();

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(apiPlugin, { prefix: "/api", cache, syncService, refreshService });

  if (webhookService) {
    await registerWebhookRoutes(app, webhookService);
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
      const active = cache.getActiveSnapshot();
      const event = change.status === "updated"
        ? { type: "updated", item: toApiItem(cache, change.item), repositories: active?.repositories ?? [], scope: active?.scope ?? { repositoryCount: 0, itemCount: 0, truncatedReason: null } }
        : { type: "removed", nodeId: change.nodeId, itemType: change.itemType, number: change.number, reason: change.reason, scope: active?.scope ?? { repositoryCount: 0, itemCount: 0, truncatedReason: null } };
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
