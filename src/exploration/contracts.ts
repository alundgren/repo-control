/** Transport-neutral contracts shared by the review engine and its clients. */
export type Selection = { path: string; side: "LEFT" | "RIGHT"; startLine: number; endLine: number };
export type Source = Selection & { id: string; code: string };
export type Location = { sourceId: string; label: string; explanation: string };
export type ReviewAction =
  | { kind: "explain"; sourceId: string; text: string }
  | { kind: "locations"; title: string; items: Location[] }
  | { kind: "guide"; items: Location[] };
export type ReviewAnswer = {
  version: 1;
  kind: "answer";
  message: string;
  actions: ReviewAction[];
  question: { text: string; options: string[] } | null;
};
export type ReadDecision = {
  version: 1;
  kind: "read";
  requests: (
    | { kind: "file"; path: string; side: "LEFT" | "RIGHT"; startLine: number; endLine: number }
    | { kind: "search"; query: string; pathPrefix: string | null; offset: number }
  )[];
};
export type Decision = ReviewAnswer | ReadDecision;
export type ExplorationTurn = { turnId: string; message: string; guided: boolean; selection: Selection | null };
export type ExplorationResult = { turnId: string; headSha: string; answer: ReviewAnswer; sources: Source[]; notices: string[] };
export type ExplorationFailure = "unavailable" | "invalid_request" | "expired" | "busy" | "head_changed" | "cancelled" | "invalid_response" | "limit";
export class ExplorationError extends Error {
  constructor(readonly code: ExplorationFailure) { super(code); }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]) { return Object.keys(value).sort().join(",") === expected.sort().join(","); }
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !Array.from(value).some(character => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))); }
function range(value: Record<string, unknown>) { return (value.side === "LEFT" || value.side === "RIGHT") && text(value.path, 1024) && Number.isSafeInteger(value.startLine) && Number.isSafeInteger(value.endLine) && Number(value.startLine) > 0 && Number(value.endLine) >= Number(value.startLine) && Number(value.endLine) - Number(value.startLine) < 160; }
export function validSelection(value: unknown): value is Selection { return record(value) && keys(value, ["path", "side", "startLine", "endLine"]) && range(value); }
export function validateTurn(value: unknown): ExplorationTurn {
  if (!record(value) || !keys(value, ["turnId", "message", "guided", "selection"]) || !text(value.turnId, 100) || typeof value.message !== "string" || value.message.length > 8000 || typeof value.guided !== "boolean" || (!value.message.trim() && !value.guided) || (value.selection !== null && !validSelection(value.selection))) throw new ExplorationError("invalid_request");
  return value as ExplorationTurn;
}

/** Syntax validation does not authorize source IDs or repository paths. The engine does that. */
export function validateDecision(value: unknown): Decision {
  const invalid = () => { throw new ExplorationError("invalid_response"); };
  if (!record(value) || value.version !== 1) return invalid();
  if (value.kind === "read") {
    if (!keys(value, ["version", "kind", "requests"]) || !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 3) return invalid();
    for (const request of value.requests) {
      if (!record(request)) return invalid();
      if (request.kind === "file") { if (!keys(request, ["kind", "path", "side", "startLine", "endLine"]) || !range(request)) return invalid(); }
      else if (request.kind === "search") { if (!keys(request, ["kind", "query", "pathPrefix", "offset"]) || !text(request.query, 120) || (request.pathPrefix !== null && !text(request.pathPrefix, 1024)) || !Number.isSafeInteger(request.offset) || Number(request.offset) < 0 || Number(request.offset) > 1960) return invalid(); }
      else return invalid();
    }
    return value as ReadDecision;
  }
  if (value.kind !== "answer" || !keys(value, ["version", "kind", "message", "actions", "question"]) || !text(value.message, 12000) || !Array.isArray(value.actions) || value.actions.length > 4) return invalid();
  if (value.question !== null && (!record(value.question) || !keys(value.question, ["text", "options"]) || !text(value.question.text, 500) || !Array.isArray(value.question.options) || value.question.options.length < 2 || value.question.options.length > 5 || !value.question.options.every(option => text(option, 160)) || new Set(value.question.options).size !== value.question.options.length)) return invalid();
  for (const action of value.actions) {
    if (!record(action)) return invalid();
    if (action.kind === "explain") {
      if (!keys(action, ["kind", "sourceId", "text"]) || !text(action.sourceId, 100) || !text(action.text, 4000)) return invalid();
    } else if (action.kind === "locations" || action.kind === "guide") {
      if (!keys(action, action.kind === "guide" ? ["kind", "items"] : ["kind", "title", "items"]) || (action.kind === "locations" && !text(action.title, 160)) || !Array.isArray(action.items) || action.items.length < 1 || action.items.length > (action.kind === "guide" ? 6 : 30)) return invalid();
      for (const item of action.items) if (!record(item) || !keys(item, ["sourceId", "label", "explanation"]) || !text(item.sourceId, 100) || !text(item.label, 160) || !text(item.explanation, 2000)) return invalid();
    } else return invalid();
  }
  return value as ReviewAnswer;
}

export type ModelMessage = { role: "user" | "assistant"; content: string };
export type ExplorationModel = (messages: ModelMessage[], signal: AbortSignal) => Promise<Decision>;
