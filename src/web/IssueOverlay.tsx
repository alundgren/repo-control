import { useEffect, useRef, type ReactNode, type KeyboardEvent } from "react";
import { ItemBody } from "./ItemBody.js";
import type { ApiIssue } from "../api/read-models.js";

export function IssueOverlay({ item, repository, onClose, opener, fallback, children }: {
  item: ApiIssue; repository: string; onClose: () => void; opener: HTMLElement | null; fallback: HTMLElement | null; children: ReactNode;
}) {
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

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? []);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <div className="issueBackdrop"><div aria-labelledby="issue-title" aria-modal="true" role="dialog" className="issueWindow" ref={dialog} onKeyDown={keyDown}>
    <header className="issueHeader"><span>{repository} · Issue {item.number}</span><a href={item.url} target="_blank" rel="noopener noreferrer">GitHub ↗</a><button className="issueClose" aria-label="Close issue" onClick={onClose} ref={close} type="button">×</button></header>
    <div className="issueScroll" tabIndex={0} aria-label="Issue body"><article className="issueDocument"><h1 id="issue-title">{item.title}</h1>
      <ItemBody item={item} kind="issue" />
      <footer className="issueFacts">{children}</footer>
    </article></div>
  </div></div>;
}
