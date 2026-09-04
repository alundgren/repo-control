import type { FastifyError, FastifyPluginAsync } from "fastify";

import type { Cache } from "../cache/index.js";
import type { ItemRefreshService } from "../refresh/index.js";
import type { SyncService } from "../sync/index.js";
import type { GitHubReadClient } from "../github/read-client.js";
import type { PullRequestMergeService } from "../merge/index.js";
import type { ReviewSubmissionInput, ReviewSubmissionService } from "../review/index.js";
import type { ChangeEventHub } from "../events/index.js";
import { emitLogEvent, type LogEventSink } from "../observability/index.js";
import { buildOverview, buildRepositoryVisibility, toItemRefreshResponse, toSyncResponse } from "./read-models.js";

export type ApiPluginOptions = {
  cache: Cache;
  syncService: SyncService;
  refreshService: ItemRefreshService;
  diffClient: Pick<GitHubReadClient, "readPullRequestDiff">;
  reviewService?: ReviewSubmissionService;
  mergeService?: PullRequestMergeService;
  eventHub?: ChangeEventHub;
  logEvent?: LogEventSink;
};

export const apiPlugin: FastifyPluginAsync<ApiPluginOptions> = async (
  app,
  { cache, syncService, refreshService, diffClient, reviewService, mergeService, eventHub, logEvent },
) => {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (request.method === "PUT" && request.routeOptions.url?.endsWith("/settings/repository-visibility")) {
      emitLogEvent(logEvent, {
        event: "settings.repository_visibility.finished",
        level: "warn",
        status: "failed",
        errorCode: statusCode >= 400 && statusCode < 500 ? "invalid_request" : "unavailable",
      });
    }
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

  app.get("/settings/repository-visibility", async () => ({ status: "ready", ...buildRepositoryVisibility(cache) }));

  app.put<{ Body: { revision: number; ignoredRepositoryIds: string[] } }>(
    "/settings/repository-visibility",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["revision", "ignoredRepositoryIds"],
          properties: {
            revision: { type: "integer", minimum: 0 },
            ignoredRepositoryIds: {
              type: "array",
              maxItems: 10_000,
              items: { type: "string", minLength: 1, maxLength: 256 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { revision, ignoredRepositoryIds } = request.body;
      if (new Set(ignoredRepositoryIds).size !== ignoredRepositoryIds.length) {
        emitLogEvent(logEvent, { event: "settings.repository_visibility.finished", level: "warn", status: "failed", errorCode: "duplicate_repository" });
        return reply.code(400).send({ status: "invalid", error: { code: "duplicate_repository" } });
      }
      const result = cache.replaceIgnoredRepositories(ignoredRepositoryIds, revision);
      if (result.status === "conflict") {
        emitLogEvent(logEvent, { event: "settings.repository_visibility.finished", level: "warn", status: "conflict", revision: result.settings.revision, ignoredRepositoryCount: result.settings.repositories.filter((entry) => entry.ignored).length });
        return reply.code(409).send({ status: "conflict", ...buildRepositoryVisibility(cache) });
      }
      if (result.status === "unknown_repository") {
        emitLogEvent(logEvent, { event: "settings.repository_visibility.finished", level: "warn", status: "failed", errorCode: "unknown_repository" });
        return reply.code(400).send({ status: "invalid", error: { code: "unknown_repository" } });
      }
      const overview = buildOverview(cache);
      if (overview.status === "ready") {
        eventHub?.publish({
          status: "settings",
          revision: result.settings.revision,
          visibleItemCount: overview.scope.visibleItemCount ?? 0,
          visibleRepositoryCount: overview.scope.visibleRepositoryCount ?? 0,
          ignoredRepositoryCount: overview.scope.ignoredRepositoryCount ?? 0,
        });
      }
      emitLogEvent(logEvent, { event: "settings.repository_visibility.finished", level: "info", status: "complete", revision: result.settings.revision, ignoredRepositoryCount: result.settings.repositories.filter((entry) => entry.ignored).length });
      return { status: "updated", ...buildRepositoryVisibility(cache) };
    },
  );

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
      if (cache.isRepositoryIgnored(item.repositoryId)) return reply.code(409).send({ status: "ignored" });
      if (item.type !== "pull_request") return reply.code(400).send({ status: "error", error: { code: "not_pull_request" } });
      const repository = cache.getActiveSnapshot()?.repositories.find((entry) => entry.id === item.repositoryId);
      if (!repository) return reply.code(404).send({ status: "error", error: { code: "not_found" } });
      const result = await diffClient.readPullRequestDiff({ repositoryNameWithOwner: repository.nameWithOwner, number: item.number });
      return { ...result, reviewEnabled: reviewService?.enabled ?? false, mergeEnabled: mergeService?.enabled ?? false };
    },
  );

  app.post<{ Params: { nodeId: string }; Body: Omit<ReviewSubmissionInput, "nodeId"> }>(
    "/items/:nodeId/review",
    {
      schema: {
        params: {
          type: "object",
          required: ["nodeId"],
          properties: { nodeId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedHeadSha", "event", "comments"],
          properties: {
            expectedHeadSha: { type: "string", minLength: 1 },
            summary: { type: "string" },
            event: { type: "string", enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"] },
            comments: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "line", "side", "body"],
                properties: {
                  path: { type: "string", minLength: 1 },
                  line: { type: "integer", minimum: 1 },
                  side: { type: "string", enum: ["LEFT", "RIGHT"] },
                  body: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!reviewService) return reply.code(403).send({ status: "disabled" });
      const item = cache.getItem(request.params.nodeId);
      if (item && cache.isRepositoryIgnored(item.repositoryId)) return reply.code(409).send({ status: "ignored" });
      const outcome = await reviewService.submit({ nodeId: request.params.nodeId, ...request.body });
      if (outcome.status === "submitted") {
        return {
          status: "submitted",
          reviewUrl: outcome.reviewUrl,
          refresh: outcome.refresh ? toItemRefreshResponse(cache, outcome.refresh) : { status: "failed" },
        };
      }
      const code = outcome.status === "disabled" ? 403
        : outcome.status === "not_found" ? 404
          : outcome.status === "head_changed" ? 409
            : outcome.status === "rejected" ? 422
              : outcome.status === "verification_failed" ? 503
                : outcome.status === "unknown" ? 502
                  : 400;
      return reply.code(code).send(outcome);
    },
  );

  app.get<{ Params: { nodeId: string } }>(
    "/items/:nodeId/merge",
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
      if (item && cache.isRepositoryIgnored(item.repositoryId)) return reply.code(409).send({ status: "ignored" });
      return mergeService?.read(request.params.nodeId) ?? { status: "not_permitted" };
    },
  );

  app.post<{ Params: { nodeId: string }; Body: { expectedHeadSha: string } }>(
    "/items/:nodeId/merge",
    {
      schema: {
        params: {
          type: "object",
          required: ["nodeId"],
          properties: { nodeId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedHeadSha"],
          properties: { expectedHeadSha: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      if (!mergeService) return reply.code(403).send({ status: "failed", reason: "permission" });
      const item = cache.getItem(request.params.nodeId);
      if (item && cache.isRepositoryIgnored(item.repositoryId)) return reply.code(409).send({ status: "ignored" });
      const outcome = await mergeService.merge({ nodeId: request.params.nodeId, expectedHeadSha: request.body.expectedHeadSha });
      if (outcome.status === "merged") {
        return {
          status: "merged",
          alreadyMerged: outcome.alreadyMerged,
          refresh: outcome.refresh ? toItemRefreshResponse(cache, outcome.refresh) : { status: "failed" },
        };
      }
      const code = outcome.status === "failed"
        ? outcome.reason === "permission" ? 403 : outcome.reason === "validation" ? 409 : outcome.reason === "policy" ? 422 : 502
        : outcome.status === "unavailable" ? 503
          : outcome.status === "not_permitted" ? 403
            : 409;
      return reply.code(code).send(outcome);
    },
  );
};
