import { useEffect, useRef } from "react";
import type { Source } from "../../exploration/contracts.js";
import type { ExplorationController } from "./useExploration.js";
import "./exploration.css";

export type CodeVisit = { source: Source; explanation: string };
export function ExplorerDrawer({ controller: c, onVisit, onClose }: { controller: ExplorationController; onVisit: (visit: CodeVisit) => void; onClose: () => void }) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  useEffect(() => { if (c.open) composer.current?.focus(); }, [c.open]);
  useEffect(() => { if (history.current) history.current.scrollTop = history.current.scrollHeight; }, [c.exchanges.length, c.pending]);
  return <aside className="explorerDrawer" hidden={!c.open} aria-label="AI code review">
    <header><h2>Explore this PR</h2><button type="button" aria-label="Close agent chat" onClick={onClose}>×</button></header>
    <div className="explorerHistory" ref={history}>
      {c.exchanges.length === 0 && !c.pending ? <div className="explorerStart"><h3>Where would you like to start?</h3><p>Follow a guided review, or ask a question below.</p><button className="primaryButton" disabled={c.stale} onClick={() => void c.send("", true)} type="button">Start guided review</button><p className="explorerDisclosure">Questions send PR excerpts and requested source from this repository to the configured AI provider. The agent can show explanations and code locations.</p></div> : null}
      {c.exchanges.map(({ question, result }, exchangeIndex) => <section className="explorerExchange" key={result.turnId}>
        <p className="explorerSpeaker">You</p><p className="explorerQuestion">{question}</p>
        <p className="explorerSpeaker">Agent</p><p className="explorerMessage">{result.answer.message}</p>
        {result.notices.length ? <details className="explorerCoverage"><summary>Evidence limits</summary>{result.notices.map(notice => <p key={notice}>{notice}</p>)}</details> : null}
        {result.answer.actions.map((action, index) => <div className="explorerActions" key={index}>
          {action.kind === "explain" ? <button disabled={c.stale} type="button" onClick={() => { const source = result.sources.find(source => source.id === action.sourceId); if (source) onVisit({ source, explanation: action.text }); }}>Read explanation at the code</button> : <><h3>{action.kind === "guide" ? "Suggested reading order" : action.title}</h3>{action.items.map((item, itemIndex) => {
            const source = result.sources.find(source => source.id === item.sourceId);
            return source ? <button className="explorerLocation" disabled={c.stale} key={`${item.sourceId}-${itemIndex}`} type="button" onClick={() => onVisit({ source, explanation: item.explanation })}><span>{action.kind === "guide" ? `${itemIndex + 1}. ` : ""}{item.label}</span><small>{source.path}:{source.startLine}–{source.endLine} · {source.side === "LEFT" ? "Base" : "Head"}</small></button> : null;
          })}</>}
        </div>)}
        {result.answer.question ? <div className="explorerChoices"><p>{result.answer.question.text}</p>{result.answer.question.options.map(option => <button disabled={Boolean(c.pending) || c.stale || exchangeIndex !== c.exchanges.length - 1} key={option} onClick={() => void c.send(option)} type="button">{option}</button>)}</div> : null}
      </section>)}
      {c.pending ? <div role="status"><p className="explorerQuestion">{c.pending}</p><p>Reading code and preparing an answer…</p><button onClick={() => { c.stop(); composer.current?.focus(); }} type="button">Stop</button></div> : null}
      {c.error ? <p className="explorerError" role="alert">{c.error}</p> : null}
    </div>
    <form className="explorerComposer" onSubmit={event => { event.preventDefault(); void c.send(c.draft); }}>
      {c.selection ? <div className="explorerSelection"><span>{c.selection.path}:{c.selection.startLine}–{c.selection.endLine} · {c.selection.side === "LEFT" ? "Base" : "Head"}</span><button aria-label="Remove code selection" type="button" onClick={() => { c.setSelection(null); composer.current?.focus(); }}>×</button></div> : <p className="explorerScope">Context: this PR</p>}
      <textarea ref={composer} maxLength={8000} value={c.draft} onChange={event => c.setDraft(event.target.value)} aria-label="Question for the review agent" placeholder="Ask about this change…" disabled={c.stale} />
      <div className="explorerComposerActions"><button className="primaryButton" disabled={Boolean(c.pending) || c.stale || !c.draft.trim()} type="submit">Send</button>{c.selection ? <><button disabled={Boolean(c.pending) || c.stale} type="button" onClick={() => void c.send("Explain the selected code and any important edge cases.")}>Explain selection</button><button disabled={Boolean(c.pending) || c.stale} type="button" onClick={() => void c.send("Find usages of the symbol in the selected code. Ask me which symbol if it is ambiguous.")}>Find usages</button></> : null}</div>
      {c.exchanges.length > 0 || c.error ? <button className="explorerReset" disabled={Boolean(c.pending) || c.stale} type="button" onClick={() => { c.reset(); composer.current?.focus(); }}>New conversation</button> : null}
    </form>
  </aside>;
}
export function ExplorationCode({ visit, onBack, onAsk, stale }: { stale?: boolean; visit: CodeVisit; onBack: () => void; onAsk: () => void }) {
  return <article className="explorationCode" aria-label="Agent code location" tabIndex={-1}>
    <div className="explorationCodeControls"><button onClick={onBack} type="button">← Back to review</button><button disabled={stale} onClick={onAsk} type="button">Ask about this code</button></div>
    <p className="explorationSourcePath">{visit.source.path}:{visit.source.startLine}–{visit.source.endLine} · {visit.source.side === "LEFT" ? "Base" : "Reviewed head"}</p>
    <pre>{visit.source.code.split("\n").map((line, index) => <span className="explorationSourceLine" key={index}><span aria-hidden="true">{visit.source.startLine + index}</span>{line}{"\n"}</span>)}</pre>
    <div className="explorationAnnotation"><p>{visit.explanation}</p></div>
  </article>;
}
