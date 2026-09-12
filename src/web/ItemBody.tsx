import { useEffect, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApiItem } from "../api/read-models.js";
import { getItemBody } from "./api.js";

type BodyState = { status: "loading" } | { status: "failed" } | { status: "read"; body: string | null };

export function ItemBody({ item, kind, active = true }: { item: Pick<ApiItem, "id" | "url" | "observedAt">; kind: "issue" | "pull request"; active?: boolean }) {
  const [body, setBody] = useState<BodyState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [requested, setRequested] = useState(active);
  useEffect(() => { if (active) setRequested(true); }, [active]);
  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    setBody({ status: "loading" });
    void getItemBody(item.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setBody(result.status === "read" ? result : { status: "failed" });
    }).catch(() => { if (!controller.signal.aborted) setBody({ status: "failed" }); });
    return () => controller.abort();
  }, [item.id, item.observedAt, attempt, requested]);

  return <div className="issueMarkdown" aria-busy={body.status === "loading"}>
    {body.status === "loading" ? <p role="status">Loading {kind} body…</p> : body.status === "failed" ? <p role="alert">The {kind} body is unavailable. <button className="quietButton" onClick={() => setAttempt((value) => value + 1)} type="button">Try again</button></p> : body.body?.trim() ? <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => {
      const safeUrl = defaultUrlTransform(url);
      if (!safeUrl) return "";
      try { return new URL(safeUrl, item.url).href; } catch { return ""; }
    }} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{body.body}</Markdown> : <p>No description provided.</p>}
  </div>;
}
