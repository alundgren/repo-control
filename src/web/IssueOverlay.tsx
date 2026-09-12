import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApiIssue } from "../api/read-models.js";
import { getIssueBody } from "./api.js";

type BodyState = { status: "loading" } | { status: "failed" } | { status: "read"; body: string | null };

export function IssueOverlay({ item, repository, onClose, opener, fallback, children }: {
  item: ApiIssue; repository: string; onClose: () => void; opener: HTMLElement | null; fallback: HTMLElement | null; children: ReactNode;
}) {
  const [body, setBody] = useState<BodyState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const overflow = document.body.style.overflow;
    const scroll = window.scrollY;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      window.requestAnimationFrame(() => {
        window.scrollTo(0, scroll);
        (opener?.isConnected ? opener : document.querySelector<HTMLElement>(".itemRow") ?? fallback)?.focus({ preventScroll: true });
      });
    };
  }, [opener, fallback]);

  useEffect(() => {
    const controller = new AbortController();
    setBody({ status: "loading" });
    void getIssueBody(item.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setBody(result.status === "read" ? result : { status: "failed" });
    }).catch(() => { if (!controller.signal.aborted) setBody({ status: "failed" }); });
    return () => controller.abort();
  }, [item.id, item.observedAt, attempt]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <div className="issueBackdrop"><div aria-labelledby="issue-title" aria-modal="true" role="dialog" className="issueWindow" ref={dialog} onKeyDown={keyDown}>
    <header className="issueHeader"><span>{repository} · Issue {item.number}</span><a href={item.url} target="_blank" rel="noopener noreferrer">GitHub ↗</a><button className="issueClose" aria-label="Close issue" onClick={onClose} ref={close} type="button">×</button></header>
    <div className="issueScroll"><article className="issueDocument"><h1 id="issue-title">{item.title}</h1>
      <div className="issueMarkdown" aria-busy={body.status === "loading"}>
        {body.status === "loading" ? <p role="status">Loading issue body…</p> : body.status === "failed" ? <p role="alert">The issue body is unavailable. <button className="quietButton" onClick={() => setAttempt((value) => value + 1)} type="button">Try again</button></p> : body.body?.trim() ? <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => {
          const safeUrl = defaultUrlTransform(url);
          if (!safeUrl) return "";
          try { return new URL(safeUrl, item.url).href; } catch { return ""; }
        }} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{body.body}</Markdown> : <p>No description provided.</p>}
      </div>
      <footer className="issueFacts">{children}</footer>
    </article></div>
  </div></div>;
}
