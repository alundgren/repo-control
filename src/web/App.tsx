import { useEffect, useRef, useState, type RefObject } from "react";

import type { ApiItem, OverviewResponse } from "../api/read-models.js";
import { getOverview, refreshItem, syncOverview, type LiveItemEvent } from "./api.js";

type View = "now" | "pullRequests" | "agent" | "human" | "triage";
type SyncState = "idle" | "busy" | "success" | "partial" | "failed";
type ItemRefreshState = "idle" | "busy" | "success" | "partial" | "failed" | "removed";

type ViewDetails = {
  title: string;
  sectionTitle?: string;
  queue?: string;
};

const views: Record<View, ViewDetails> = {
  now: { title: "Now" },
  pullRequests: {
    title: "Pull requests",
    sectionTitle: "Open pull requests",
  },
  agent: {
    title: "Ready for agent",
    sectionTitle: "Ready for agent",
    queue: "agent",
  },
  human: {
    title: "Needs me",
    sectionTitle: "Needs me",
    queue: "human",
  },
  triage: {
    title: "Triage",
    sectionTitle: "Triage",
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
  const [itemMessage, setItemMessage] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [itemRefreshStates, setItemRefreshStates] = useState<Record<string, ItemRefreshState>>({});
  const [compactLayout, setCompactLayout] = useState(false);
  const [liveState, setLiveState] = useState<"connected" | "unavailable">("connected");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const quickReadHeadingRef = useRef<HTMLHeadingElement>(null);
  const overviewRef = useRef<Extract<OverviewResponse, { status: "ready" }> | null>(null);
  const selectedItemRef = useRef<string | null>(null);
  const viewRef = useRef<View>("now");
  const queryRef = useRef("");
  const eventBufferRef = useRef<LiveItemEvent[]>([]);
  const reconcilingLiveRef = useRef(false);

  useEffect(() => {
    void loadOverview();
  }, []);

  useEffect(() => {
    overviewRef.current = overview;
  }, [overview]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/events");
    source.addEventListener("item", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent).data) as LiveItemEvent;
        if (reconcilingLiveRef.current || !overviewRef.current) eventBufferRef.current.push(event);
        else applyLiveEvent(event);
      } catch {
        // Ignore malformed events and preserve the loaded view.
      }
    });
    source.onopen = () => {
      setLiveState("connected");
      void reconcileLiveOverview();
    };
    source.onerror = () => setLiveState("unavailable");
    return () => source.close();
  }, []);

  useEffect(() => {
    if (compactLayout && selectedItemId) {
      window.requestAnimationFrame(() => quickReadHeadingRef.current?.focus());
    }
  }, [compactLayout, selectedItemId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 64rem)");
    const update = () => setCompactLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  async function loadOverview() {
    setLoading(true);
    try {
      const response = await getOverview();
      setOverview(response.status === "ready" ? response : null);
      overviewRef.current = response.status === "ready" ? response : null;
      setLoadMessage("");
    } catch {
      setLoadMessage("The work queue is unavailable. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function changeView(nextView: View) {
    setView(nextView);
    viewRef.current = nextView;
    setQuery("");
    queryRef.current = "";
    setSelectedItemId(null);
    selectedItemRef.current = null;
    window.requestAnimationFrame(() => titleRef.current?.focus());
  }

  async function syncAccount() {
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

  async function refreshFocusedItem(nodeId: string) {
    setItemMessage("");
    setItemRefreshStates((states) => ({ ...states, [nodeId]: "busy" }));
    try {
      const response = await refreshItem(nodeId);
      if (response.status === "updated") {
        const nextOverview = overviewRef.current ? replaceOverviewItem(overviewRef.current, response.item, { repositories: response.repositories, scope: response.scope }) : null;
        if (nextOverview) {
          overviewRef.current = nextOverview;
          setOverview(nextOverview);
        }
        setItemRefreshStates((states) => ({ ...states, [nodeId]: response.relationshipStatus === "fresh" ? "success" : "partial" }));
        const currentQueue = views[viewRef.current].queue;
        const movedQueue = response.item.type === "issue"
          && currentQueue !== undefined
          && response.item.queue !== currentQueue
          ? response.item.queue
          : null;
        if (movedQueue && selectedItemRef.current === nodeId) {
          selectedItemRef.current = null;
          setSelectedItemId(null);
          setItemMessage(`Item refreshed and moved to ${queueTitle(movedQueue)}.`);
          focusNextRowOrPageHeading();
        }
        return;
      }
      if (response.status === "removed" || response.status === "not_found") {
        const nextOverview = overviewRef.current ? removeOverviewItem(overviewRef.current, nodeId, response.status === "removed" ? response.scope : undefined) : null;
        if (nextOverview) {
          overviewRef.current = nextOverview;
          setOverview(nextOverview);
        }
        const wasSelected = selectedItemRef.current === nodeId;
        if (wasSelected) {
          selectedItemRef.current = null;
          setSelectedItemId(null);
          setItemMessage("This item is no longer in the loaded work.");
        }
        setItemRefreshStates((states) => ({ ...states, [nodeId]: "removed" }));
        if (wasSelected) focusNextRowOrPageHeading();
        return;
      }
      setOverview((current) => current ? replaceOverviewItem(current, response.item) : current);
      setItemRefreshStates((states) => ({ ...states, [nodeId]: "failed" }));
    } catch {
      setItemRefreshStates((states) => ({ ...states, [nodeId]: "failed" }));
    }
  }

  function focusNextRowOrPageHeading() {
    window.requestAnimationFrame(() => {
      const nextRow = document.querySelector<HTMLButtonElement>(".itemRow");
      if (nextRow) {
        nextRow.focus();
      } else {
        titleRef.current?.focus();
      }
    });
  }

  const currentView = views[view];
  const items = overview ? itemsForView(overview, view) : [];
  const filteredItems = overview ? filterItems(items, query, overview) : [];
  const selectedItem = filteredItems.find((item) => item.id === selectedItemId) ?? null;
  const statusMessage = itemMessage || syncStatusMessage(syncState);

  function selectItem(nodeId: string) {
    setItemMessage("");
    selectedItemRef.current = nodeId;
    setSelectedItemId(nodeId);
  }

  function returnToList() {
    const previousSelection = selectedItemId;
    setSelectedItemId(null);
    selectedItemRef.current = null;
    window.requestAnimationFrame(() => document.getElementById(`item-row-${previousSelection}`)?.focus());
  }

  async function reconcileLiveOverview() {
    reconcilingLiveRef.current = true;
    let reconciled = false;
    try {
      const response = await getOverview();
      if (response.status === "ready") {
        reconcileSelectionAfterOverview(overviewRef.current, response);
        setOverview(response);
        overviewRef.current = response;
        reconciled = true;
      }
    } catch {
      setLiveState("unavailable");
    } finally {
      reconcilingLiveRef.current = false;
      if (reconciled || overviewRef.current) {
        const buffered = eventBufferRef.current.splice(0);
        buffered.forEach(applyLiveEvent);
      }
    }
  }

  function applyLiveEvent(event: LiveItemEvent) {
    if (event.type === "updated") {
      const current = overviewRef.current;
      if (!current) {
        eventBufferRef.current.push(event);
        return;
      }
      const next = replaceOverviewItem(current, event.item, { repositories: event.repositories, scope: event.scope });
      overviewRef.current = next;
      setOverview(next);
      if (selectedItemRef.current === event.item.id) {
        const remainsVisible = filterItems(itemsForView(next, viewRef.current), queryRef.current, next).some((item) => item.id === event.item.id);
        if (!remainsVisible) {
          const previousItem = itemFromOverview(current, event.item.id);
          selectedItemRef.current = null;
          setSelectedItemId(null);
          const queueMoved = previousItem?.type === "issue" && event.item.type === "issue" && previousItem.queue !== event.item.queue;
          const nextQueue = event.item.type === "issue" ? event.item.queue : null;
          setItemMessage(queueMoved
            ? `Item refreshed and moved to ${queueTitle(nextQueue!)}.`
            : queryRef.current
              ? "Item refreshed and no longer matches this search."
              : "Item refreshed and moved out of this view.");
          focusNextRowOrPageHeading();
        }
      }
      return;
    }
    const current = overviewRef.current;
    if (current) {
      const next = removeOverviewItem(current, event.nodeId, event.scope);
      overviewRef.current = next;
      setOverview(next);
    }
    setItemMessage(liveRemovalMessage(event));
    if (selectedItemRef.current === event.nodeId) {
      selectedItemRef.current = null;
      setSelectedItemId(null);
      setItemMessage(liveRemovalMessage(event));
      focusNextRowOrPageHeading();
    }
  }

  function reconcileSelectionAfterOverview(previous: Extract<OverviewResponse, { status: "ready" }> | null, next: Extract<OverviewResponse, { status: "ready" }>) {
    const selected = selectedItemRef.current;
    if (!selected || !previous) return;
    const stillLoaded = itemFromOverview(next, selected);
    const stillVisible = filterItems(itemsForView(next, viewRef.current), queryRef.current, next).some((item) => item.id === selected);
    if (!stillLoaded || !stillVisible) {
      selectedItemRef.current = null;
      setSelectedItemId(null);
      setItemMessage(stillLoaded ? "The selected item moved out of this view while live updates reconnected." : "The selected item was removed while live updates reconnected.");
      focusNextRowOrPageHeading();
    }
  }

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

      <section aria-busy={loading} aria-label="Work queues" className="content">
        <div className="contentInner">
          <header className="pageHeader">
            <div>
              <h1 ref={titleRef} tabIndex={-1}>{currentView.title}</h1>
            </div>
            <div className="syncArea">
              {overview ? (
                <p className={`freshness ${overview.scope.truncatedReason ? "warning" : "complete"}`}>
                  {freshness(overview)}
                </p>
              ) : null}
              {liveState === "unavailable" ? <p className="freshness warning">Live updates are unavailable. Sync account still works.</p> : null}
              <button
                className="quietButton syncButton"
                disabled={syncState === "busy"}
                onClick={() => void syncAccount()}
                type="button"
              >
                {syncState === "busy" ? "Syncing account…" : "Sync account"}
              </button>
            </div>
          </header>

          <p aria-live="polite" className={`statusMessage ${syncState}`}>{statusMessage}</p>

          {loading ? <p>Loading the work queue…</p> : null}
          {!loading && !overview ? (
            <p className="emptyState">
              {loadMessage || "No work is available yet."}
              {loadMessage ? <button className="quietButton retryButton" onClick={() => void loadOverview()} type="button">Try again</button> : null}
            </p>
          ) : null}

          {overview ? (
            <>
              <label className="visuallyHidden" htmlFor="work-search">Search loaded work</label>
              <input
                id="work-search"
                onChange={(event) => {
                  queryRef.current = event.target.value;
                  setQuery(event.target.value);
                }}
                placeholder="Search loaded work"
                type="search"
                value={query}
              />
              <p aria-live="polite" className="visuallyHidden">{selectedItem ? `Showing ${selectedItem.title}.` : ""}</p>
              <div className="workArea">
                {!compactLayout || !selectedItem ? <div className="workList">
                  {view === "now" ? (
                    <NowView
                      onSelect={selectItem}
                      overview={overview}
                      query={query}
                      selectedItemId={selectedItemId}
                      filteredItems={filteredItems}
                    />
                  ) : (
                    <ListSection
                      items={filteredItems}
                      onSelect={selectItem}
                      overview={overview}
                      selectedItemId={selectedItemId}
                      title={currentView.title}
                    />
                  )}
                </div> : null}
              </div>
            </>
          ) : null}
        </div>
      </section>
      {overview && (!compactLayout || selectedItem) ? <QuickRead backLabel={currentView.title} headingRef={quickReadHeadingRef} item={selectedItem} onBack={compactLayout ? returnToList : undefined} onRefresh={refreshFocusedItem} overview={overview} refreshState={selectedItem ? itemRefreshStates[selectedItem.id] ?? "idle" : "idle"} /> : null}
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
  onSelect,
  selectedItemId,
}: {
  overview: Extract<OverviewResponse, { status: "ready" }>;
  query: string;
  filteredItems: ApiItem[];
  onSelect: (nodeId: string) => void;
  selectedItemId: string | null;
}) {
  if (query.trim()) {
    return <ListSection items={filteredItems} onSelect={onSelect} overview={overview} selectedItemId={selectedItemId} showKind title="Search results" />;
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
            </div>
            <ItemList items={items.slice(0, previewLimit)} onSelect={onSelect} overview={overview} selectedItemId={selectedItemId} />
          </section>
        );
      })}
    </div>
  );
}

function ListSection({
  items,
  onSelect,
  overview,
  selectedItemId,
  showKind = false,
  title,
}: {
  items: ApiItem[];
  onSelect: (nodeId: string) => void;
  overview: Extract<OverviewResponse, { status: "ready" }>;
  selectedItemId: string | null;
  showKind?: boolean;
  title: string;
}) {
  return (
    <section className="queueSection fullList" aria-label={title}>
      <ItemList items={items} onSelect={onSelect} overview={overview} selectedItemId={selectedItemId} showKind={showKind} />
      {items.length === 0 ? <p className="emptyState">No loaded items match this view.</p> : null}
    </section>
  );
}

function ItemList({
  items,
  onSelect,
  overview,
  selectedItemId,
  showKind = false,
}: {
  items: ApiItem[];
  onSelect: (nodeId: string) => void;
  overview: Extract<OverviewResponse, { status: "ready" }>;
  selectedItemId: string | null;
  showKind?: boolean;
}) {
  return (
    <ul className="itemList">
      {items.map((item) => <ItemRow item={item} key={item.id} onSelect={onSelect} overview={overview} selected={selectedItemId === item.id} showKind={showKind} />)}
    </ul>
  );
}

function ItemRow({
  item,
  onSelect,
  overview,
  selected,
  showKind,
}: {
  item: ApiItem;
  onSelect: (nodeId: string) => void;
  overview: Extract<OverviewResponse, { status: "ready" }>;
  selected: boolean;
  showKind: boolean;
}) {
  const repository = repositoryName(overview, item.repositoryId);
  return (
    <li>
      <button aria-label={`Select ${item.title}`} aria-pressed={selected} className="itemRow" id={`item-row-${item.id}`} onClick={() => onSelect(item.id)} type="button">
        <span className="itemNumber">{item.type === "pull_request" ? `PR${item.number}` : `#${item.number}`}</span>
        <span className="itemBody">
          <span className="itemTitle">{item.title}</span>
          <span className="itemIdentity">{repository} · #{item.number}</span>
          <ItemFacts item={item} overview={overview} showKind={showKind} />
        </span>
        <span className="itemAge">Updated {relativeTime(item.updatedAt)}</span>
      </button>
    </li>
  );
}

function QuickRead({ backLabel, headingRef, item, onBack, onRefresh, overview, refreshState }: {
  backLabel: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  item: ApiItem | null;
  onBack?: () => void;
  onRefresh: (nodeId: string) => void;
  overview: Extract<OverviewResponse, { status: "ready" }>;
  refreshState: ItemRefreshState;
}) {
  if (!item) {
    return <aside aria-label="Quick read" className="quickRead"><p className="eyebrow">Quick read</p><h2 ref={headingRef} tabIndex={-1}>Choose an item</h2><p>Read the excerpt here, then open GitHub when you need the full context.</p></aside>;
  }
  return (
    <aside aria-label="Quick read" className="quickRead">
      {onBack ? <button className="quietButton backToList" onClick={onBack} type="button">Back to {backLabel}</button> : null}
      <p className="eyebrow">{item.type === "pull_request" ? "Pull request" : "Issue"}</p>
      <p className="detailIdentity">{repositoryName(overview, item.repositoryId)} · {item.type === "pull_request" ? "PR" : "#"}{item.number}</p>
      <h2 ref={headingRef} tabIndex={-1}>{item.title}</h2>
      <p className="detailAge">Updated {relativeTime(item.updatedAt)}</p>
      <a className="detailLink" href={item.url} rel="noreferrer" target="_blank">Open on GitHub</a>
      <p className="itemExcerpt">{item.excerpt ?? "No text excerpt is available for this item."}</p>
      <p className="itemContextFreshness">Item facts checked {relativeTime(item.observedAt ?? item.updatedAt)}.</p>
      {item.type === "pull_request" ? <ClosingIssueFacts item={item} /> : <BlockerFacts item={item} overview={overview} />}
      <div className="itemRefresh">
        <button className="quietButton" disabled={refreshState === "busy"} onClick={() => onRefresh(item.id)} type="button">
          {refreshState === "busy" ? "Refreshing this item…" : "Refresh this item"}
        </button>
        <span aria-live="polite" className={`itemRefreshMessage ${refreshState}`}>{itemRefreshMessage(refreshState)}</span>
      </div>
    </aside>
  );
}

function ClosingIssueFacts({ item }: { item: Extract<ApiItem, { type: "pull_request" }> }) {
  if (item.closingIssues.status === "unavailable") return <p>Closing-issue details are unavailable.</p>;
  if (item.closingIssues.status === "not_sampled") return <p>Closing-issue details were not sampled.</p>;
  if (item.closingIssues.items.length === 0) return <p>No closing issue linked.</p>;
  return <p>{item.closingIssues.items.map((issue, index) => <span key={issue.id}>{index > 0 ? ", " : "Closes "}<a href={issue.url} rel="noreferrer" target="_blank">{issue.repositoryNameWithOwner}#{issue.number}</a></span>)}</p>;
}

function BlockerFacts({ item, overview }: { item: Extract<ApiItem, { type: "issue" }>; overview: Extract<OverviewResponse, { status: "ready" }> }) {
  if (item.readiness.kind === "unblocked") return <p>No open blockers.</p>;
  if (item.readiness.kind === "unavailable") return <p>Dependency status unavailable.</p>;
  const known = item.readiness.blockers.filter((blocker) => blocker.status === "known");
  if (known.length === 0) return <p>Blocker details are unavailable.</p>;
  return <p>Blocked by {known.map((blocker, index) => blocker.status === "known" ? <span key={blocker.id}>{index > 0 ? ", " : ""}<a href={blocker.url} rel="noreferrer" target="_blank">{blocker.repositoryNameWithOwner ?? repositoryName(overview, blocker.repositoryId)}#{blocker.number}</a></span> : null)}</p>;
}

function itemRefreshMessage(state: ItemRefreshState) {
  if (state === "success") return "Item refreshed just now.";
  if (state === "partial") return "Item refreshed; relationship details could not be updated.";
  if (state === "failed") return "Refresh failed. Showing the previous item context.";
  if (state === "removed") return "This item is no longer in the loaded work.";
  return "";
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
    text: `Blocked by ${knownBlocker.repositoryNameWithOwner ?? repositoryName(overview, knownBlocker.repositoryId)}#${knownBlocker.number}${suffix}`,
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

function itemFromOverview(overview: Extract<OverviewResponse, { status: "ready" }>, nodeId: string): ApiItem | null {
  return [...overview.pullRequests, ...overview.queues.flatMap((queue) => queue.issues)].find((item) => item.id === nodeId) ?? null;
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
  return `Synced ${relativeTime(overview.fetchedAt)} · ${overview.scope.itemCount} items from ${overview.scope.repositoryCount} repositories${partial}`;
}

function syncStatusMessage(syncState: SyncState) {
  switch (syncState) {
    case "success":
      return "Account synced just now.";
    case "partial":
      return "Account synced with a partial result.";
    case "failed":
      return "Sync failed. Showing the previous account cache. Try again.";
    default:
      return "";
  }
}

function liveRemovalMessage(event: Extract<LiveItemEvent, { type: "removed" }>) {
  const label = event.itemType === "pull_request" ? `PR #${event.number}` : `Issue #${event.number}`;
  if (event.reason === "issue_closed") return `${label} was closed on GitHub and removed from the loaded work.`;
  if (event.reason === "pull_request_merged") return `${label} was merged on GitHub and removed from the loaded work.`;
  if (event.reason === "pull_request_closed") return `${label} was closed without merging on GitHub and removed from the loaded work.`;
  return `${label} left the loaded repository scope and was removed from the loaded work.`;
}

function repositoryName(overview: Extract<OverviewResponse, { status: "ready" }>, repositoryId: string) {
  return overview.repositories.find((entry) => entry.id === repositoryId)?.nameWithOwner ?? "Repository unavailable";
}

function queueTitle(queue: string) {
  const view = issueViews.find((name) => views[name].queue === queue);
  return view ? views[view].title : queue;
}

function replaceOverviewItem(
  overview: Extract<OverviewResponse, { status: "ready" }>,
  updated: ApiItem,
  metadata: { repositories?: Extract<OverviewResponse, { status: "ready" }> ["repositories"]; scope?: Extract<OverviewResponse, { status: "ready" }> ["scope"] } = {},
): Extract<OverviewResponse, { status: "ready" }> {
  return {
    ...overview,
    repositories: metadata.repositories ?? overview.repositories,
    scope: metadata.scope ?? { ...overview.scope, itemCount: overview.scope.itemCount },
    pullRequests: updated.type === "pull_request"
      ? [...overview.pullRequests.filter((item) => item.id !== updated.id), updated].sort(comparePullRequests)
      : overview.pullRequests.filter((item) => item.id !== updated.id),
    queues: overview.queues.map((queue) => ({
      ...queue,
      issues: updated.type === "issue" && queue.name === updated.queue
        ? [...queue.issues.filter((item) => item.id !== updated.id), updated].sort(compareIssues)
        : queue.issues.filter((item) => item.id !== updated.id),
    })),
  };
}

function comparePullRequests(left: Extract<ApiItem, { type: "pull_request" }>, right: Extract<ApiItem, { type: "pull_request" }>) {
  return left.updatedAt.localeCompare(right.updatedAt) || left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number;
}

function compareIssues(left: Extract<ApiItem, { type: "issue" }>, right: Extract<ApiItem, { type: "issue" }>) {
  return readinessBand(left.readiness) - readinessBand(right.readiness)
    || left.updatedAt.localeCompare(right.updatedAt)
    || left.repositoryId.localeCompare(right.repositoryId)
    || left.number - right.number
    || left.id.localeCompare(right.id);
}

function readinessBand(readiness: Extract<ApiItem, { type: "issue" }> ["readiness"]) {
  if (readiness.kind === "unblocked") return 0;
  if (readiness.kind === "unavailable") return 1;
  return 2;
}

function removeOverviewItem(
  overview: Extract<OverviewResponse, { status: "ready" }>,
  nodeId: string,
  scope?: Extract<OverviewResponse, { status: "ready" }> ["scope"],
): Extract<OverviewResponse, { status: "ready" }> {
  return {
    ...overview,
    scope: scope ?? overview.scope,
    pullRequests: overview.pullRequests.filter((item) => item.id !== nodeId),
    queues: overview.queues.map((queue) => ({ ...queue, issues: queue.issues.filter((item) => item.id !== nodeId) })),
  };
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
