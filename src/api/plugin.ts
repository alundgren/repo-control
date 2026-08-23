import type { FastifyError, FastifyPluginAsync } from "fastify";

import type { Cache } from "../cache/index.js";
import type { ItemRefreshService } from "../refresh/index.js";
import type { SyncService } from "../sync/index.js";
import { buildOverview, toItemRefreshResponse, toSyncResponse } from "./read-models.js";

export type ApiPluginOptions = {
  cache: Cache;
  syncService: SyncService;
  refreshService: ItemRefreshService;
};

export const apiPlugin: FastifyPluginAsync<ApiPluginOptions> = async (
  app,
  { cache, syncService, refreshService },
) => {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "api request failed");
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ status: "error", error: { code: "invalid_request" } });
      return;
    }
    reply.code(500).send({ status: "error", error: { code: "unavailable" } });
  });

  app.get("/overview", async () => buildOverview(cache));

  app.post("/sync", async () => toSyncResponse(await syncService.sync()));

  app.post<{ Params: { nodeId: string } }>(
    "/items/:nodeId/refresh",
    {
      schema: {
        params: {
          type: "object",
          required: ["nodeId"],
          properties: { nodeId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => {
      const outcome = await refreshService.refreshItem({ nodeId: request.params.nodeId });
      return toItemRefreshResponse(cache, outcome);
    },
  );
};
