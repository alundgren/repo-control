import { ExplorationError, validateTurn, validateDecision, type ExplorationResult, type Selection, type Source, type ReviewAnswer } from "./contracts.js";
import type { ExplorationModel, ModelMessage } from "./contracts.js";

export type Evidence = { sources: Omit<Source, "id">[]; notices: string[] };
export type ReviewSnapshot = Evidence & { headSha: string; baseSha: string; title: string; description: string; files: string[] };
/** Hosts provide immutable code reads. The engine has no GitHub, HTTP, React or disk dependency. */
export type ExplorationRepository = {
  prepare(nodeId: string, expectedHeadSha: string, signal: AbortSignal): Promise<ReviewSnapshot>;
  verify(nodeId: string, expectedHeadSha: string, signal: AbortSignal, baseSha?: string): Promise<void>;
  read(nodeId: string, headSha: string, selection: Selection, signal: AbortSignal, baseSha: string): Promise<Evidence>;
  search(nodeId: string, headSha: string, query: string, pathPrefix: string | null, offset: number, signal: AbortSignal, baseSha: string): Promise<Evidence>;
};
type Session = { nodeId: string; snapshot: ReviewSnapshot; sources: Source[]; notices: string[]; history: ModelMessage[]; results: Map<string, { input: string; result: ExplorationResult }>; touched: number; controller?: AbortController; nextSource: number; historyTruncated: boolean };
export function createExplorationEngine(repository: ExplorationRepository, model: ExplorationModel, options: { now?: () => number; id?: () => string } = {}) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  let creating = 0;
  const ttl = 30 * 60 * 1000;
  const prune = () => { for (const [id, session] of sessions) if (now() - session.touched > ttl && !session.controller) sessions.delete(id); };
  const get = (id: string) => { prune(); const session = sessions.get(id); if (!session) throw new ExplorationError("expired"); session.touched = now(); return session; };
  function addEvidence(session: Session, evidence: Evidence) {
    for (const notice of evidence.notices) if (!session.notices.includes(notice)) session.notices.push(notice);
    for (const source of evidence.sources) {
      if (session.sources.some(existing => existing.path === source.path && existing.side === source.side && existing.startLine === source.startLine && existing.endLine === source.endLine)) continue;
      if (session.sources.length >= 80 || new TextEncoder().encode(JSON.stringify(session.sources) + JSON.stringify(source)).byteLength > 48_000) { if (!session.notices.includes("Evidence limit reached. Start a new conversation to inspect more code.")) session.notices.push("Evidence limit reached. Start a new conversation to inspect more code."); break; }
      session.sources.push({ ...source, id: `s${session.nextSource++}` });
    }
  }
  function authorize(answer: ReviewAnswer, session: Session) {
    const ids = new Set(session.sources.map(source => source.id));
    for (const action of answer.actions) {
      const references = action.kind === "explain" ? [action.sourceId] : action.items.map(item => item.sourceId);
      if (references.some(id => !ids.has(id))) throw new ExplorationError("invalid_response");
    }
  }
  return {
    async create(nodeId: string, headSha: string, signal: AbortSignal) {
      prune();
      if (sessions.size + creating >= 8) throw new ExplorationError("busy");
      creating++;
      try {
        const snapshot = await repository.prepare(nodeId, headSha, signal);
        signal.throwIfAborted();
        if (sessions.size >= 8) throw new ExplorationError("busy");
        const id = options.id?.() ?? crypto.randomUUID();
        const session: Session = { nodeId, snapshot: { ...snapshot, sources: [] }, sources: [], notices: [], history: [], results: new Map(), touched: now(), nextSource: 1, historyTruncated: false };
        addEvidence(session, snapshot);
        sessions.set(id, session);
        return { sessionId: id, headSha: snapshot.headSha };
      } finally { creating--; }
    },
    async turn(id: string, input: unknown, externalSignal: AbortSignal): Promise<ExplorationResult> {
      const turn = validateTurn(input);
      const session = get(id);
      const encoded = JSON.stringify(turn);
      if (session.controller) throw new ExplorationError("busy");
      const previous = session.results.get(turn.turnId);
      if (previous && previous.input !== encoded) throw new ExplorationError("invalid_request");
      if (!previous && session.results.size >= 20) throw new ExplorationError("limit");
      const controller = new AbortController();
      session.controller = controller;
      const signal = AbortSignal.any([controller.signal, externalSignal, AbortSignal.timeout(90_000)]);
      try {
        await repository.verify(session.nodeId, session.snapshot.headSha, signal, session.snapshot.baseSha);
        signal.throwIfAborted();
        if (previous) return previous.result;
        if (turn.selection) addEvidence(session, await repository.read(session.nodeId, session.snapshot.headSha, turn.selection, signal, session.snapshot.baseSha));
        const question: ModelMessage = { role: "user", content: JSON.stringify({ question: turn.message, guided: turn.guided, selection: turn.selection }) };
        const rounds: ModelMessage[] = [];
        let reads = 0;
        for (let round = 0; round < 4; round++) {
          signal.throwIfAborted();
          const evidence: ModelMessage = { role: "user", content: JSON.stringify({ title: session.snapshot.title, description: session.snapshot.description, headSha: session.snapshot.headSha, files: session.snapshot.files, sources: session.sources, notices: [...session.notices, ...(session.historyTruncated ? ["Older exchanges were omitted from this conversation."] : [])], finalRound: round === 3 }) };
          const decision = validateDecision(await model([evidence, ...session.history.slice(-6), question, ...rounds], signal));
          signal.throwIfAborted();
          if (decision.kind === "answer") {
            authorize(decision, session);
            await repository.verify(session.nodeId, session.snapshot.headSha, signal, session.snapshot.baseSha);
            signal.throwIfAborted();
            const result: ExplorationResult = { turnId: turn.turnId, headSha: session.snapshot.headSha, answer: decision, sources: [...session.sources], notices: [...session.notices, ...(session.historyTruncated ? ["Older exchanges were omitted to keep the conversation within its context budget."] : [])] };
            session.history.push(question, { role: "assistant", content: JSON.stringify(decision) });
            while (session.history.length > 6 || new TextEncoder().encode(JSON.stringify(session.history)).byteLength > 24 * 1024) { session.history.splice(0, 2); session.historyTruncated = true; }
            session.results.set(turn.turnId, { input: encoded, result });
            return result;
          }
          if (round === 3 || reads + decision.requests.length > 8) throw new ExplorationError("limit");
          rounds.push({ role: "assistant", content: JSON.stringify(decision) });
          for (const request of decision.requests) {
            reads++;
            const evidence = request.kind === "search"
              ? await repository.search(session.nodeId, session.snapshot.headSha, request.query, request.pathPrefix, request.offset, signal, session.snapshot.baseSha)
              : await repository.read(session.nodeId, session.snapshot.headSha, { path: request.path, side: request.side, startLine: request.startLine, endLine: request.endLine }, signal, session.snapshot.baseSha);
            signal.throwIfAborted();
            addEvidence(session, evidence);
          }
          rounds.push({ role: "user", content: "Requested evidence is included in the source registry at the start of this request. Continue with those IDs and notices." });
        }
        throw new ExplorationError("limit");
      } catch (error) {
        if (signal.aborted) throw new ExplorationError("cancelled");
        if (error instanceof ExplorationError) throw error;
        throw new ExplorationError("unavailable");
      } finally { session.controller = undefined; session.touched = now(); }
    },
    shutdown() { for (const session of sessions.values()) session.controller?.abort(); sessions.clear(); },
    cancel(id: string) { const session = sessions.get(id); session?.controller?.abort(); },
    close(id: string) { const session = sessions.get(id); session?.controller?.abort(); sessions.delete(id); },
  };
}
export type ExplorationEngine = ReturnType<typeof createExplorationEngine>;
