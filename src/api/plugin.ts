import type { FastifyError, FastifyPluginAsync } from "fastify";

import type { Cache } from "../cache/index.js";
import type { ItemRefreshService } from "../refresh/index.js";
import type { SyncService } from "../sync/index.js";
import type { GitHubReadClient } from "../github/read-client.js";
import { buildOverview, toItemRefreshResponse, toSyncResponse } from "./read-models.js";

export type ApiPluginOptions = {
  cache: Cache;
  syncService: SyncService;
  refreshService: ItemRefreshService;
  diffClient: Pick<GitHubReadClient, "readPullRequestDiff">;
};

export const apiPlugin: FastifyPluginAsync<ApiPluginOptions> = async (
  app,
  { cache, syncService, refreshService, diffClient },
) => {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    try {
      request.log.error({
        event: "api.request.failed",
        statusCode,
        route: request.routeOptions.url,
        requestId: request.id,
        errorCode: statusCode >= 400 && statusCode < 500 ? "invalid_request" : "unavailable",
      }, "api request failed");
    } catch {
      // Logging must not prevent the safe API error response.
    }
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

  app.get<{ Params: { nodeId: string } }>(
    "/items/:nodeId/diff",
    {
      schema: {
        params: {
          type: "object",
          required: ["nodeId"],
          properties: { nodeId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const item = cache.getItem(request.params.nodeId);
      if (!item) return reply.code(404).send({ status: "error", error: { code: "not_found" } });
      if (item.type !== "pull_request") return reply.code(400).send({ status: "error", error: { code: "not_pull_request" } });
      const repository = cache.getActiveSnapshot()?.repositories.find((entry) => entry.id === item.repositoryId);
      if (!repository) return reply.code(404).send({ status: "error", error: { code: "not_found" } });
      return diffClient.readPullRequestDiff({ repositoryNameWithOwner: repository.nameWithOwner, number: item.number });
    },
  );
};
