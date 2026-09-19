import { describe, expect, it } from "vite-plus/test";
import { createExplorationModel } from "./provider.js";
const configuration = { endpoint: "https://inference.do-ai.run/v1/chat/completions", apiKey: "fictional-key" };
const answer = { version: 1, kind: "answer", message: "Read the date calculation.", actions: [], question: null };
function payload(overrides = {}) { return { model: "glm-5.3-flash", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }], ...overrides }; }
const signal = new AbortController().signal;
describe("exploration provider", () => {
  it("accepts a complete JSON answer without exposing the credential in content", async () => {
    const model = createExplorationModel(configuration, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toBe("none");
      expect(body.messages[0].content).toContain("untrusted data");
      expect(String(init?.body)).not.toContain(configuration.apiKey);
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify(payload()));
    });
    expect(await model([{ role: "user", content: "Explain the cutoff" }], signal)).toEqual(answer);
  });
  it.each([
    payload({ model: "other-model" }),
    payload({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(answer) } }] }),
    payload({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer), tool_calls: [{ name: "merge" }] } }] }),
    payload({ choices: [{ finish_reason: "stop", message: { content: "```json\n{}\n```" } }] }),
  ])("rejects responses outside the completion contract", async response => {
    const model = createExplorationModel(configuration, async () => new Response(JSON.stringify(response)));
    await expect(model([], signal)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("bounds streamed response bytes before parsing JSON", async () => {
    const model = createExplorationModel(configuration, async () => new Response("a".repeat(129 * 1024)));
    await expect(model([], signal)).rejects.toMatchObject({ code: "limit" });
  });
});
