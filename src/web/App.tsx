import { useEffect, useRef, useState, type MouseEvent } from "react";

import type { ApiItem, OverviewResponse } from "../api/read-models.js";
import { getOverview, syncOverview } from "./api.js";

type View = "now" | "pullRequests" | "agent" | "human" | "triage";

type ViewDetails = {
  title: string;
  description: string;
  queue?: string;
};

const views: Record<View, ViewDetails> = {
  now: { title: "Now", description: "A short view of the work worth opening first." },
  pullRequests: { title: "Pull requests", description: "Open changes in the current sample." },
  agent: { title: "Ready for agent", description: "Issues marked ready in the current sample.", queue: "agent" },
  human: { title: "Needs me", description: "Issues that need a decision or hands-on work.", queue: "human" },
  triage: { title: "Triage", description: "Open issues that need sorting.", queue: "triage" },
};

const previewLimit = 3;

export function App() {
  const [overview, setOverview] = useState<Extract<OverviewResponse, { status: "ready" }> | null>(null);
  const [view, setView] = useState<View>("now");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    void loadOverview();
  }, []);

  async function loadOverview() {
    try {
      const response = await getOverview();
      setOverview(response.status === "ready" ? response : null);
      setMessage("");
    } catch {
      setMessage("The sampled work queue is unavailable. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function changeView(nextView: View) {
    setView(nextView);
    setQuery("");
    window.requestAnimationFrame(() => titleRef.current?.focus());
  }

  async function refreshSample() {
    setRefreshing(true);
    setMessage("Refreshing sample…");
    try {
      const response = await syncOverview();
      if (response.status === "complete" || response.status === "partial") {
        const nextOverview = await getOverview();
        setOverview(nextOverview.status === "ready" ? nextOverview : null);
        setMessage("Sample refreshed just now.");
      } else {
        setMessage("Refresh failed. Showing the current sample. Try again.");
      }
    } catch {
      setMessage("Refresh failed. Showing the current sample. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  const currentView = views[view];
  const items = overview ? itemsForView(overview, view) : [];
  const filteredItems = overview ? filterItems(items, query, overview) : [];

  return (
    <main className="appShell">
      <aside className="navigation">
        <a className="brand" href="#now" onClick={(event) => navigate(event, "now", changeView)}>
          <span aria-hidden="true" className="brandMark">↗</span>
          Repo Control
        </a>
        <nav aria-label="Work views" className="viewNavigation">
          {(Object.keys(views) as View[]).map((nextView) => (
            <a
              aria-current={view === nextView ? "page" : undefined}
              aria-label={`${views[nextView].title} ${overview ? countForView(overview, nextView) : 0}`}
              href={`#${nextView}`}
              key={nextView}
              onClick={(event) => navigate(event, nextView, changeView)}
            >
              <span>{views[nextView].title}</span>
              <span className="count">{overview ? countForView(overview, nextView) : 0}</span>
            </a>
          ))}
        </nav>
      </aside>

      <section className="content" aria-busy={loading}>
        <header className="pageHeader">
          <div>
            <p className="eyebrow">Current work</p>
            <h1 ref={titleRef} tabIndex={-1}>{currentView.title}</h1>
            <p className="description">{currentView.description}</p>
          </div>
          <div className="refreshArea">
            {overview ? <p className="freshness">{freshness(overview)}</p> : null}
            <button disabled={refreshing} onClick={() => void refreshSample()} type="button">
              {refreshing ? "Refreshing sample" : "Refresh sample"}
            </button>
          </div>
        </header>

        <p aria-live="polite" className="statusMessage">{message}</p>

        {loading ? <p>Loading the sampled work queue…</p> : null}
        {!loading && !overview ? <p className="emptyState">No sampled work is available yet.</p> : null}

        {overview ? (
          <>
            <label className="searchLabel" htmlFor="work-search">Search loaded work</label>
            <input
              id="work-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles, repositories, numbers, and queues"
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
      </section>
    </main>
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
    return <ListSection items={filteredItems} overview={overview} title="Search results" />;
  }

  return (
    <div className="queuePreviews">
      {(Object.keys(views).filter((view): view is Exclude<View, "now"> => view !== "now")).map((view) => {
        const items = itemsForView(overview, view);
        return (
          <section className="queueSection" key={view}>
            <div className="sectionHeading">
              <h2>{views[view].title}</h2>
              <a href={`#${view}`} onClick={(event) => navigate(event, view, onNavigate)}>
                View all {items.length}
              </a>
            </div>
            <ItemList items={items.slice(0, previewLimit)} overview={overview} />
          </section>
        );
      })}
    </div>
  );
}

function ListSection({ items, overview, title }: { items: ApiItem[]; overview: Extract<OverviewResponse, { status: "ready" }>; title: string }) {
  return (
    <section className="queueSection" aria-label={title}>
      <ItemList items={items} overview={overview} />
      {items.length === 0 ? <p className="emptyState">No loaded items match this view.</p> : null}
    </section>
  );
}

function ItemList({ items, overview }: { items: ApiItem[]; overview: Extract<OverviewResponse, { status: "ready" }> }) {
  return (
    <ul className="itemList">
      {items.map((item) => <ItemRow item={item} key={item.id} overview={overview} />)}
    </ul>
  );
}

function ItemRow({ item, overview }: { item: ApiItem; overview: Extract<OverviewResponse, { status: "ready" }> }) {
  const repository = overview.repositories.find((entry) => entry.id === item.repositoryId)?.nameWithOwner ?? "Repository unavailable";
  return (
    <li>
      <a className="itemRow" href={item.url} rel="noreferrer" target="_blank">
        <span className="itemIdentity">{repository} #{item.number}</span>
        <span className="itemTitle">{item.title}</span>
        <span className="itemMeta">Updated {relativeTime(item.updatedAt)}</span>
      </a>
    </li>
  );
}

function navigate(event: MouseEvent<HTMLAnchorElement>, view: View, onNavigate: (view: View) => void) {
  event.preventDefault();
  onNavigate(view);
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
    const repository = overview.repositories.find((entry) => entry.id === item.repositoryId)?.nameWithOwner ?? "";
    const queue = item.type === "issue" ? item.queue : "pull requests";
    return `${item.title} ${repository} ${item.number} ${queue}`.toLocaleLowerCase().includes(normalizedQuery);
  });
}

function freshness(overview: Extract<OverviewResponse, { status: "ready" }>) {
  const partial = overview.scope.truncatedReason ? " Partial result." : "";
  return `Sample of ${overview.scope.itemCount} items from ${overview.scope.repositoryCount} repositories. Refreshed ${relativeTime(overview.fetchedAt)}.${partial}`;
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
