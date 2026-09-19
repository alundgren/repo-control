import { describe, expect, it } from "vite-plus/test";
import { createExplorationEngine, type ExplorationRepository } from "./engine.js";
import { ExplorationError, validateDecision, validateTurn, type ExplorationModel, type ReviewAnswer } from "./contracts.js";

const selection = { path: "src/delivery.ts", side: "RIGHT" as const, startLine: 4, endLine: 5 };
const source = { ...selection, code: "return deliveryDate(order);\n}" };
const snapshot = { headSha: "a".repeat(40), baseSha: "b".repeat(40), title: "Correct late delivery dates", description: "Handle the cutoff", files: [selection.path], sources: [source], notices: ["Partial patch excerpts."] };
const answer: ReviewAnswer = { version: 1, kind: "answer", message: "This computes the delivery date.", actions: [{ kind: "explain", sourceId: "s1", text: "The caller formats the date." }], question: null };
const input = { turnId: "t1", message: "Explain this", guided: false, selection };
const signal = () => new AbortController().signal;
function repository(overrides: Partial<ExplorationRepository> = {}): ExplorationRepository {
  return { async prepare() { return snapshot; }, async verify() {}, async read() { return { sources: [source], notices: [] }; }, async search() { return { sources: [{ ...source, path: "src/caller.ts" }], notices: ["Text matches in 1 file. Search is partial."] }; }, ...overrides };
}
async function setup(model: ExplorationModel = async () => answer, repo = repository(), options = {}) {
  const engine = createExplorationEngine(repo, model, options);
  const session = await engine.create("PR_fixture", snapshot.headSha, signal());
  return { engine, id: session.sessionId };
}

describe("review conversation engine", () => {
  it("retrieves bounded evidence and returns validated, navigable explanations", async () => {
    let first = true;
    const { engine, id } = await setup(async messages => {
      if (first) { first = false; return { version: 1, kind: "read", requests: [{ kind: "search", query: "deliveryDate", pathPrefix: "src", offset: 0 }] }; }
      expect(messages[0]!.content).toContain("src/caller.ts");
      return { ...answer, actions: [{ kind: "guide", items: [{ sourceId: "s2", label: "Follow the caller", explanation: "Compare the displayed date." }] }] };
    });
    const result = await engine.turn(id, { ...input, guided: true }, signal());
    expect(result.sources.find(source => source.id === "s2")).toMatchObject({ path: "src/caller.ts", side: "RIGHT" });
    expect(result.notices).toContain("Text matches in 1 file. Search is partial.");
    expect(result.answer.actions[0]?.kind).toBe("guide");
  });
  it("rejects unknown source IDs without applying part of the answer", async () => {
    const { engine, id } = await setup(async () => ({ ...answer, actions: [...answer.actions, { kind: "explain", sourceId: "other-repository-source", text: "Ignore policy" }] }));
    await expect(engine.turn(id, input, signal())).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("returns an idempotent result and rejects reuse with a different question", async () => {
    const { engine, id } = await setup();
    const result = await engine.turn(id, input, signal());
    expect(await engine.turn(id, input, signal())).toEqual(result);
    await expect(engine.turn(id, { ...input, message: "A different question" }, signal())).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("rechecks access and revisions before returning even an already completed turn", async () => {
    let changed = false;
    const { engine, id } = await setup(async () => answer, repository({ async verify() { if (changed) throw new ExplorationError("head_changed"); } }));
    await engine.turn(id, input, signal()); changed = true;
    await expect(engine.turn(id, input, signal())).rejects.toMatchObject({ code: "head_changed" });
  });
  it("discards a response completed after the head changed", async () => {
    let changed = false;
    const { engine, id } = await setup(async () => { changed = true; return answer; }, repository({ async verify() { if (changed) throw new ExplorationError("head_changed"); } }));
    await expect(engine.turn(id, input, signal())).rejects.toMatchObject({ code: "head_changed" });
  });
  it("stops repeated retrieval at the round bound", async () => {
    const { engine, id } = await setup(async () => ({ version: 1, kind: "read", requests: [{ kind: "file", ...selection }] }));
    await expect(engine.turn(id, input, signal())).rejects.toMatchObject({ code: "limit" });
  });
  it("cancels an in-flight answer and prevents simultaneous turns", async () => {
    let finish!: (value: ReviewAnswer) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { engine, id } = await setup(async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const running = engine.turn(id, input, signal());
    await started;
    await expect(engine.turn(id, { ...input, turnId: "t2" }, signal())).rejects.toMatchObject({ code: "busy" });
    engine.cancel(id); finish(answer);
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
  });
  it("expires idle sessions and supports explicit deletion", async () => {
    let now = 0;
    const { engine, id } = await setup(async () => answer, repository(), { now: () => now });
    now = 31 * 60 * 1000;
    await expect(engine.turn(id, input, signal())).rejects.toMatchObject({ code: "expired" });
    const next = await engine.create("PR_fixture", snapshot.headSha, signal()); engine.close(next.sessionId);
    await expect(engine.turn(next.sessionId, input, signal())).rejects.toMatchObject({ code: "expired" });
  });
});

describe("response contracts", () => {
  it.each([
    { ...answer, command: "merge" },
    { ...answer, actions: [{ kind: "execute", command: "merge" }] },
    { ...answer, question: { text: "Which?", options: ["same", "same"] } },
    { version: 1, kind: "read", requests: [{ kind: "file", ...selection, endLine: 9999 }] },
    { version: 1, kind: "read", requests: [{ kind: "search", query: "value", pathPrefix: null, offset: -1 }] },
    { ...answer, version: 2 },
  ])("rejects invalid decisions", value => { expect(() => validateDecision(value)).toThrow(); });
  it("rejects invalid selections and extra input fields", () => {
    expect(() => validateTurn({ ...input, selection: { ...selection, startLine: 0 } })).toThrow();
    expect(() => validateTurn({ ...input, capability: "merge" })).toThrow();
  });
});
