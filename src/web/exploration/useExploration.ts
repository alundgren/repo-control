import { useEffect, useRef, useState } from "react";
import type { ExplorationResult, Selection } from "../../exploration/contracts.js";

export type Exchange = { question: string; result: ExplorationResult };
export function useExploration(nodeId: string, headSha: string | null) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraftValue] = useState("");
  const draftVersion = useRef(0);
  function setDraft(value: string) { draftVersion.current++; setDraftValue(value); }
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const [stale, setStale] = useState(false);
  function stop() {
    generation.current++;
    request.current?.abort();
    request.current = null;
    busy.current = false;
    setPending(null);
    if (session.current) void fetch(`/api/exploration/sessions/${encodeURIComponent(session.current)}/cancel`, { method: "POST" }).catch(() => {});
  }
  function reset() {
    stop();
    if (session.current) void fetch(`/api/exploration/sessions/${encodeURIComponent(session.current)}`, { method: "DELETE" }).catch(() => {});
    session.current = null;
    setExchanges([]); setError(null); setStale(false);
  }
  useEffect(() => {
    reset();
    setSelection(null);
    return () => {
      generation.current++;
      request.current?.abort();
      if (session.current) void fetch(`/api/exploration/sessions/${encodeURIComponent(session.current)}`, { method: "DELETE", keepalive: true }).catch(() => {});
      session.current = null;
    };
  }, [nodeId, headSha]);
  async function send(message: string, guided = false) {
    if (busy.current || stale || !headSha || (!message.trim() && !guided)) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    const current = ++generation.current;
    const submittedDraftVersion = draftVersion.current;
    const submittedFromComposer = !guided && message.trim() === draft.trim();
    const question = guided ? "Guide me through this PR." : message.trim();
    setPending(question); setError(null); setOpen(true);
    async function post(url: string, input: unknown) {
      const response = await fetch(url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.code === "string" ? data.code : "unavailable");
      return data;
    }
    try {
      if (!session.current) {
        const created = await post("/api/exploration/sessions", { nodeId, headSha });
        if (current !== generation.current) { void fetch(`/api/exploration/sessions/${encodeURIComponent(created.sessionId)}`, { method: "DELETE" }).catch(() => {}); return; }
        session.current = created.sessionId;
      }
      const turnId = crypto.randomUUID();
      const result = await post(`/api/exploration/sessions/${encodeURIComponent(session.current!)}/turns`, { turnId, message: question, guided, selection }) as ExplorationResult;
      if (current !== generation.current) return;
      if (result.headSha !== headSha || result.turnId !== turnId) throw new Error("head_changed");
      setExchanges(previous => [...previous, { question, result }]);
      if (submittedFromComposer && draftVersion.current === submittedDraftVersion) setDraftValue("");
    } catch (failure) {
      if (current !== generation.current) return;
      const code = failure instanceof Error ? failure.message : "unavailable";
      if (code === "head_changed") { setStale(true); setError("This PR changed. Close and reopen the review to use the current revision."); }
      else if (code === "expired") { session.current = null; setError("The conversation expired or the server restarted. Start a new conversation to continue."); }
      else if (code === "limit") setError("The conversation reached its evidence or turn limit. Start a new conversation with a narrower question.");
      else if (code === "busy") setError("The agent is busy. Your question is still here; try again shortly.");
      else if (code === "cancelled") setError("The request stopped or timed out. Your question is still here.");
      else setError("The agent could not return a valid answer. No actions were applied. Try sending your question again.");
    } finally {
      if (current === generation.current) { busy.current = false; setPending(null); request.current = null; }
    }
  }
  return { open, setOpen, selection, setSelection, draft, setDraft, exchanges, pending, error, stale, send, stop, reset };
}
export type ExplorationController = ReturnType<typeof useExploration>;
