import type { FastifyPluginAsync } from "fastify";
import { ExplorationError } from "./contracts.js";
import type { ExplorationEngine } from "./engine.js";

export const explorationPlugin: FastifyPluginAsync<{ engine: ExplorationEngine }> = async (app, { engine }) => {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (request.headers["sec-fetch-site"] === "cross-site") return reply.code(403).send({ status: "error", code: "unavailable" });
    if (origin) {
      try { if (new URL(origin).host !== request.headers.host) return reply.code(403).send({ status: "error", code: "unavailable" }); }
      catch { return reply.code(403).send({ status: "error", code: "unavailable" }); }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof ExplorationError ? error.code : "unavailable";
    return reply.code(code === "invalid_request" ? 400 : code === "expired" ? 410 : code === "busy" || code === "head_changed" ? 409 : 503).send({ status: "error", code });
  });
  app.post<{ Body: { nodeId: string; headSha: string } }>("/sessions", { bodyLimit: 4096 }, async (request, reply) => {
    const body = request.body;
    if (!body || Object.keys(body).sort().join(",") !== "headSha,nodeId" || typeof body.nodeId !== "string" || body.nodeId.length < 1 || body.nodeId.length > 256 || typeof body.headSha !== "string" || !/^[a-f0-9]{40,64}$/i.test(body.headSha)) throw new ExplorationError("invalid_request");
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", abort);
    try { return await engine.create(body.nodeId, body.headSha, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)])); }
    finally { reply.raw.off("close", abort); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/sessions/:id/turns", { bodyLimit: 48 * 1024 }, async (request, reply) => {
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", abort);
    try { return await engine.turn(request.params.id, request.body, controller.signal); }
    finally { reply.raw.off("close", abort); }
  });
  app.post<{ Params: { id: string } }>("/sessions/:id/cancel", async request => { engine.cancel(request.params.id); return { status: "cancelled" }; });
  app.delete<{ Params: { id: string } }>("/sessions/:id", async request => { engine.close(request.params.id); return { status: "closed" }; });
};
