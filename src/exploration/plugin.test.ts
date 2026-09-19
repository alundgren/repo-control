import { expect, it } from "vite-plus/test";
import fastify from "fastify";
import { explorationPlugin } from "./plugin.js";
import { createExplorationEngine, type ExplorationRepository } from "./engine.js";
const headSha = "a".repeat(40);
const repository: ExplorationRepository = {
  async prepare() { return { headSha, baseSha: "b".repeat(40), title: "Delivery", description: "", files: [], sources: [], notices: [] }; },
  async verify() {}, async read() { return { sources: [], notices: [] }; }, async search() { return { sources: [], notices: [] }; },
};
it("serves a complete conversation through the private API and refuses cross-origin creation", async () => {
  const app = fastify();
  const engine = createExplorationEngine(repository, async () => ({ version: 1, kind: "answer", message: "Choose the cutoff or its callers.", actions: [], question: { text: "Where should we start?", options: ["Cutoff", "Callers"] } }));
  await app.register(explorationPlugin, { prefix: "/api/exploration", engine });
  try {
    const denied = await app.inject({ method: "POST", url: "/api/exploration/sessions", headers: { origin: "https://untrusted.test" }, payload: { nodeId: "PR_fixture", headSha } });
    expect(denied.statusCode).toBe(403);
    const create = await app.inject({ method: "POST", url: "/api/exploration/sessions", payload: { nodeId: "PR_fixture", headSha } });
    expect(create.statusCode).toBe(200);
    const id = create.json().sessionId;
    const turn = await app.inject({ method: "POST", url: `/api/exploration/sessions/${id}/turns`, payload: { turnId: "t1", message: "Explain", guided: false, selection: null } });
    expect(turn.statusCode).toBe(200);
    expect(turn.headers["cache-control"]).toBe("no-store");
    expect(turn.json().answer.question.options).toEqual(["Cutoff", "Callers"]);
    await app.inject({ method: "DELETE", url: `/api/exploration/sessions/${id}` });
    const expired = await app.inject({ method: "POST", url: `/api/exploration/sessions/${id}/turns`, payload: { turnId: "t2", message: "Explain", guided: false, selection: null } });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toEqual({ status: "error", code: "expired" });
  } finally { await app.close(); }
});
