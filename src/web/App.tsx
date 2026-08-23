import { useEffect, useRef, useState } from "react";

import type { ApiItem, OverviewResponse } from "../api/read-models.js";
import { getOverview, syncOverview } from "./api.js";

type View = "now" | "pullRequests" | "agent" | "human" | "triage";
type SyncState = "idle" | "busy" | "success" | "partial" | "failed";

type ViewDetails = {
  title: string;
  description: string;
  sectionTitle?: string;
  sectionNote?: string;
  fullListLabel?: string;
  queue?: string;
};

const views: Record<View, ViewDetails> = {
  now: { title: "Now", description: "The few things worth looking at first." },
  pullRequests: {
    title: "Pull requests",
    description: "Open changes, with enough context to decide where to click.",
    sectionTitle: "Open pull requests",
    sectionNote: "Across your repositories",
    fullListLabel: "See all open pull requests",
  },
  agent: {
    title: "Ready for agent",
    description: "Issues with a workflow label. A blocker still wins over that label.",
    sectionTitle: "Ready for agent",
    sectionNote: "A blocker still wins over the workflow label",
    fullListLabel: "See all ready-for-agent issues",
    queue: "agent",
  },
  human: {
    title: "Needs me",
    description: "A decision, access, or hands-on work belongs here.",
    sectionTitle: "Needs me",
    sectionNote: "A decision, access, or hands-on work",
    fullListLabel: "See all human work",
    queue: "human",
  },
  triage: {
    title: "Triage",
    description: "Open work that needs sorting before it becomes a task.",
    sectionTitle: "Triage",
    sectionNote: "Open work that needs sorting",
    fullListLabel: "See all triage",
    queue: "triage",
  },
};

const mainViews: View[] = ["now", "pullRequests"];
const issueViews: View[] = ["agent", "human", "triage"];
const previewLimit = 2;

export function App() {
  const [overview, setOverview] = useState<Extract<OverviewResponse, { status: "ready" }> | null>(null);
  const [view, setView] = useState<View>("now");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadMessage, setLoadMessage] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    void loadOverview();
  }, []);

  async function loadOverview() {
    try {
      const response = await getOverview();
      setOverview(response.status === "ready" ? response : null);
      setLoadMessage("");
    } catch {
      setLoadMessage("The sampled work queue is unavailable. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function changeView(nextView: View) {
    setView(nextView);
    setQuery("");
    window.requestAnimationFrame(() => titleRef.current?.focus());
  }

  async function syncSampledView() {
    setSyncState("busy");
    try {
      const response = await syncOverview();
      if (response.status === "complete" || response.status === "partial") {
        const nextOverview = await getOverview();
        setOverview(nextOverview.status === "ready" ? nextOverview : null);
        setSyncState(response.status === "partial" ? "partial" : "success");
      } else {
        setSyncState("failed");
      }
    } catch {
      setSyncState("failed");
    }
  }

  const currentView = views[view];
  const items = overview ? itemsForView(overview, view) : [];
  const filteredItems = overview ? filterItems(items, query, overview) : [];
  const statusMessage = loadMessage || syncStatusMessage(syncState);

  return (
    <main className="appShell">
      <aside className="navigation">
        <button className="brand" onClick={() => changeView("now")} type="button">
          <span aria-hidden="true" className="brandMark">↗</span>
          Repo Control
        </button>
        <ViewNavigation
          ariaLabel="Main views"
          currentView={view}
          onNavigate={changeView}
          overview={overview}
          viewNames={mainViews}
        />
        <div className="issueNavigation">
          <p className="eyebrow">Issues</p>
          <ViewNavigation
            ariaLabel="Issue queues"
            currentView={view}
            onNavigate={changeView}
            overview={overview}
            viewNames={issueViews}
          />
        </div>
      </aside>

      <section className="content" aria-busy={loading}>
        <div className="contentInner">
          <header className="pageHeader">
            <div>
              <h1 ref={titleRef} tabIndex={-1}>{currentView.title}</h1>
              <p className="description">{currentView.description}</p>
            </div>
            <div className="syncArea">
              {overview ? (
                <p className={`freshness ${overview.scope.truncatedReason ? "warning" : "complete"}`}>
                  {freshness(overview)}
                </p>
              ) : null}
              <button
                className="quietButton syncButton"
                disabled={syncState === "busy"}
                onClick={() => void syncSampledView()}
                type="button"
              >
                {syncState === "busy" ? "Syncing sampled view…" : "Sync sampled view"}
              </button>
            </div>
          </header>

          <p aria-live="polite" className={`statusMessage ${syncState}`}>{statusMessage}</p>

          {loading ? <p>Loading the sampled work queue…</p> : null}
          {!loading && !overview ? <p className="emptyState">No sampled work is available yet.</p> : null}

          {overview ? (
            <>
              <label className="visuallyHidden" htmlFor="work-search">Search loaded work</label>
              <input
                id="work-search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search loaded work"
                type="search"
                value={query}
              />
              {view === "now" ? (
                <NowView overview={overview} query={query} filteredItems={filteredItems} onNavigate={changeView} />
              ) : (
                <ListSection items={filteredItems} overview={overview} title={currentView.title} />
              )}
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function ViewNavigation({
  ariaLabel,
  currentView,
  onNavigate,
  overview,
  viewNames,
}: {
  ariaLabel: string;
  currentView: View;
  onNavigate: (view: View) => void;
  overview: Extract<OverviewResponse, { status: "ready" }> | null;
  viewNames: View[];
}) {
  return (
    <nav aria-label={ariaLabel} className="viewNavigation">
      {viewNames.map((nextView) => (
        <button
          aria-current={currentView === nextView ? "page" : undefined}
          aria-label={`${views[nextView].title} ${overview ? countForView(overview, nextView) : 0}`}
          key={nextView}
          onClick={() => onNavigate(nextView)}
          type="button"
        >
          <span>{views[nextView].title}</span>
          <span className="count">{overview ? countForView(overview, nextView) : 0}</span>
        </button>
      ))}
    </nav>
  );
}

function NowView({
  overview,
  query,
  filteredItems,
  onNavigate,
}: {
  overview: Extract<OverviewResponse, { status: "ready" }>;
  query: string;
  filteredItems: ApiItem[];
  onNavigate: (view: View) => void;
}) {
  if (query.trim()) {
    return <ListSection items={filteredItems} overview={overview} showKind title="Search results" />;
  }

  const previewViews: View[] = ["pullRequests", "agent", "human", "triage"];
  return (
    <div className="queuePreviews">
      {previewViews.map((view) => {
        const items = itemsForView(overview, view);
        const details = views[view];
        return (
          <section className="queueSection" key={view}>
            <div className="sectionHeading">
              <h2>{details.sectionTitle}</h2>
              {details.sectionNote ? <p className="sectionNote">{details.sectionNote}</p> : null}
            </div>
            <ItemList items={items.slice(0, previewLimit)} overview={overview} />
            <button className="quietButton viewAll" onClick={() => onNavigate(view)} type="button">
              {details.fullListLabel}
            </button>
          </section>
        );
      })}
    </div>
  );
}

function ListSection({
  items,
  overview,
  showKind = false,
  title,
}: {
  items: ApiItem[];
  overview: Extract<OverviewResponse, { status: "ready" }>;
  showKind?: boolean;
  title: string;
}) {
  return (
    <section className="queueSection fullList" aria-label={title}>
      <ItemList items={items} overview={overview} showKind={showKind} />
      {items.length === 0 ? <p className="emptyState">No loaded items match this view.</p> : null}
    </section>
  );
}

function ItemList({
  items,
  overview,
  showKind = false,
}: {
  items: ApiItem[];
  overview: Extract<OverviewResponse, { status: "ready" }>;
  showKind?: boolean;
}) {
  return (
    <ul className="itemList">
      {items.map((item) => <ItemRow item={item} key={item.id} overview={overview} showKind={showKind} />)}
    </ul>
  );
}

function ItemRow({
  item,
  overview,
  showKind,
}: {
  item: ApiItem;
  overview: Extract<OverviewResponse, { status: "ready" }>;
  showKind: boolean;
}) {
  const repository = repositoryName(overview, item.repositoryId);
  return (
    <li>
      <a className="itemRow" href={item.url} rel="noreferrer" target="_blank">
        <span className="itemNumber">{item.type === "pull_request" ? `PR${item.number}` : `#${item.number}`}</span>
        <span className="itemBody">
          <span className="itemTitle">{item.title}</span>
          <span className="itemIdentity">{repository} · #{item.number}</span>
          <ItemFacts item={item} overview={overview} showKind={showKind} />
        </span>
        <span className="itemAge">Updated {relativeTime(item.updatedAt)}</span>
      </a>
    </li>
  );
}

function ItemFacts({
  item,
  overview,
  showKind,
}: {
  item: ApiItem;
  overview: Extract<OverviewResponse, { status: "ready" }>;
  showKind: boolean;
}) {
  const facts: Array<{ className: string; text: string }> = [];
  if (showKind) {
    facts.push({ className: "neutral", text: item.type === "pull_request" ? "Pull request" : queueTitle(item.queue) });
  }
  if (item.type === "pull_request") {
    if (item.isDraft) {
      facts.push({ className: "neutral", text: "Draft" });
    }
    if (item.additions !== null && item.deletions !== null) {
      facts.push({ className: "neutral", text: `+${item.additions} −${item.deletions}` });
    }
  } else {
    facts.push(readinessFact(item, overview));
  }
  return (
    <span className="itemFacts">
      {facts.map((fact, index) => <span className={`tag ${fact.className}`} key={`${fact.text}-${index}`}>{fact.text}</span>)}
    </span>
  );
}

function readinessFact(
  item: Extract<ApiItem, { type: "issue" }>,
  overview: Extract<OverviewResponse, { status: "ready" }>,
) {
  if (item.readiness.kind === "unblocked") {
    return { className: "success", text: "Unblocked" };
  }
  if (item.readiness.kind === "unavailable") {
    return { className: "neutral", text: "Dependency status unavailable" };
  }
  const knownBlocker = item.readiness.blockers.find((blocker) => blocker.status === "known");
  if (!knownBlocker || knownBlocker.status !== "known") {
    return { className: "warning", text: "Blocked; blocker details unavailable" };
  }
  const remaining = item.readiness.blockers.length - 1;
  const suffix = remaining > 0 ? ` +${remaining} more` : "";
  return {
    className: "warning",
    text: `Blocked by ${repositoryName(overview, knownBlocker.repositoryId)}#${knownBlocker.number}${suffix}`,
  };
}

function itemsForView(overview: Extract<OverviewResponse, { status: "ready" }>, view: View): ApiItem[] {
  if (view === "pullRequests") {
    return overview.pullRequests;
  }
  if (view === "now") {
    return [overview.pullRequests, ...overview.queues.map((queue) => queue.issues)].flat();
  }
  return overview.queues.find((queue) => queue.name === views[view].queue)?.issues ?? [];
}

function countForView(overview: Extract<OverviewResponse, { status: "ready" }>, view: View) {
  return itemsForView(overview, view).length;
}

function filterItems(items: ApiItem[], query: string, overview: Extract<OverviewResponse, { status: "ready" }>): ApiItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return items;
  }
  return items.filter((item) => {
    const repository = repositoryName(overview, item.repositoryId);
    const queue = item.type === "issue" ? queueTitle(item.queue) : "Pull request";
    return `${item.title} ${repository} ${item.number} ${queue}`.toLocaleLowerCase().includes(normalizedQuery);
  });
}

function freshness(overview: Extract<OverviewResponse, { status: "ready" }>) {
  const partial = overview.scope.truncatedReason ? " · Partial result" : "";
  return `Sampled ${relativeTime(overview.fetchedAt)} · ${overview.scope.itemCount} items from ${overview.scope.repositoryCount} repositories${partial}`;
}

function syncStatusMessage(syncState: SyncState) {
  switch (syncState) {
    case "success":
      return "Sample synced just now.";
    case "partial":
      return "Sample synced with a partial result.";
    case "failed":
      return "Sync failed. Showing the previous sample. Try again.";
    default:
      return "";
  }
}

function repositoryName(overview: Extract<OverviewResponse, { status: "ready" }>, repositoryId: string) {
  return overview.repositories.find((entry) => entry.id === repositoryId)?.nameWithOwner ?? "Repository unavailable";
}

function queueTitle(queue: string) {
  const view = issueViews.find((name) => views[name].queue === queue);
  return view ? views[view].title : queue;
}

function relativeTime(timestamp: string) {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  const days = Math.max(0, Math.floor(elapsed / 86_400_000));
  if (days >= 1) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  const hours = Math.max(0, Math.floor(elapsed / 3_600_000));
  return hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : "just now";
}
