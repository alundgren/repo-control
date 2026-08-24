// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewResponse } from "../api/read-models.js";
import { App } from "./App.js";

describe("work queue overview", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the reconciled Now view with complete queue counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          status: "ready",
          fetchedAt: "2026-08-23T10:00:00.000Z",
          repositories: [
            { id: "R_1", nameWithOwner: "fictional-tools/garden" },
            { id: "R_2", nameWithOwner: "fictional-tools/river" },
          ],
          scope: {
            repositoryLimit: 50,
            repositoryCount: 2,
            itemLimit: 200,
            itemCount: 6,
            truncatedReason: "item_limit",
          },
          pullRequests: [pullRequest({ id: "PR_1", number: 41, title: "Keep fictional paths tidy" })],
          queues: [
            { name: "agent", issues: [issue({ id: "I_1", number: 22, title: "Add a fictional seed" }), issue({ id: "I_2", number: 23, title: "Review fictional moss" })] },
            { name: "human", issues: [issue({ id: "I_3", number: 24, title: "Choose a garden name" })] },
            { name: "triage", issues: [issue({ id: "I_4", number: 25, title: "Clarify fictional soil" }), issue({ id: "I_5", number: 26, title: "Sort fictional leaves" })] },
          ],
        }),
      ),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pull requests 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ready for agent 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs me 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Triage 2" })).toBeTruthy();
    expect(screen.getByText("Issues")).toBeTruthy();
    expect(screen.getByText(/Synced .* · 6 items from 2 repositories · Partial result/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync account" })).toBeTruthy();
    expect(screen.queryByText("Current work")).toBeNull();
  });

  it("keeps quick read as the shell's third column", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(readyOverview())));

    render(<App />);

    await screen.findByRole("heading", { name: "Now" });

    const shell = screen.getByRole("main");
    expect(Array.from(shell.children).map((child) => child.getAttribute("aria-label"))).toEqual([
      null,
      "Work queues",
      "Quick read",
    ]);
  });

  it("opens full lists and searches the loaded work with keyboard navigation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(readyOverview())),
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Now" });
    const agentNavigation = screen.getByRole("button", { name: "Ready for agent 2" });
    agentNavigation.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("heading", { name: "Ready for agent" })).toBeTruthy();
    expect(agentNavigation.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
    expect(screen.getByText("Review fictional moss")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Now 6" }));
    const search = screen.getByRole("searchbox", { name: "Filter pull requests and issues" });

    await user.type(search, "paths tidy");
    expect(screen.getByText("Keep fictional paths tidy")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "fictional-tools/river");
    expect(screen.getByText("Keep fictional paths tidy")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "22");
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "agent");
    const results = screen.getByRole("region", { name: "Search results" });
    expect(within(results).getByText("Add a fictional seed")).toBeTruthy();
    expect(within(results).getByText("Review fictional moss")).toBeTruthy();
  });

  it("keeps the current sample visible while refresh runs and replaces it after success", async () => {
    const user = userEvent.setup();
    const refresh = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce(response({ ...readyOverview(), fetchedAt: "2026-08-23T11:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("Add a fictional seed");
    const refreshButton = screen.getByRole("button", { name: "Sync account" });
    await user.click(refreshButton);

    const syncingButton = screen.getByRole("button", { name: "Syncing account…" });
    expect(syncingButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();

    refresh.resolve(response({
      status: "complete",
      fetchedAt: "2026-08-23T11:00:00.000Z",
      scope: readyOverview().scope,
    }));

    expect(await screen.findByText("Account synced just now.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a failed sampled refresh without clearing the loaded work", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(response(readyOverview()))
        .mockResolvedValueOnce(response({
          status: "failed",
          error: { code: "unavailable" },
          lastSuccessfulSync: { fetchedAt: "2026-08-23T10:00:00.000Z" },
        })),
    );

    render(<App />);

    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Sync account" }));

    expect(await screen.findByText("Sync failed. Showing the previous account cache. Try again.")).toBeTruthy();
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
  });

  it("keeps Now concise and restores the facts needed to choose work", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    overview.pullRequests = [
      { ...pullRequest({ id: "PR_1", number: 41, title: "Keep fictional paths tidy" }), isDraft: true },
      pullRequest({ id: "PR_2", number: 42, title: "Trim fictional branches" }),
      pullRequest({ id: "PR_3", number: 43, title: "Water the fictional garden" }),
    ];
    overview.scope.itemCount = 8;
    overview.queues[0]!.issues = [
      {
        ...issue({ id: "I_1", number: 22, title: "Add a fictional seed" }),
        readiness: {
          kind: "blocked" as const,
          blockers: [
            { status: "known" as const, id: "I_9", repositoryId: "R_2", number: 31, title: "Choose a river", url: "https://github.test/fictional-tools/river/issues/31" },
            { status: "unknown" as const, id: "I_10" },
          ],
        },
      },
      { ...issue({ id: "I_2", number: 23, title: "Review fictional moss" }), readiness: { kind: "unavailable" as const } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(overview)));

    render(<App />);

    expect(await screen.findByText("Keep fictional paths tidy")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getAllByText("+8 −3").length).toBeGreaterThan(0);
    expect(screen.getByText("Blocked by fictional-tools/river#31 +1 more")).toBeTruthy();
    expect(screen.getByText("Dependency status unavailable")).toBeTruthy();
    expect(screen.queryByText("Water the fictional garden")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Pull requests 3" }));
    expect(screen.getByText("Water the fictional garden")).toBeTruthy();
  });

  it("shows partial account sync as a warning without clearing the queue", async () => {
    const user = userEvent.setup();
    const partialOverview = { ...readyOverview(), scope: { ...readyOverview().scope, truncatedReason: "item_limit" } };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(response(readyOverview()))
        .mockResolvedValueOnce(response({ status: "partial", fetchedAt: "2026-08-23T11:00:00.000Z", scope: partialOverview.scope }))
        .mockResolvedValueOnce(response(partialOverview)),
    );

    render(<App />);

    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Sync account" }));

    expect(await screen.findByText("Account synced with a partial result.")).toBeTruthy();
    expect(screen.getByText(/Partial result/)).toBeTruthy();
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
  });

  it("selects one row at a time while keeping the work list and quick read visible", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    overview.queues[0]!.issues = [
      { ...issue({ id: "I_1", number: 22, title: "Add a fictional seed" }), excerpt: "Use <strong>plain text</strong>, not rendered markup." },
      { ...issue({ id: "I_2", number: 23, title: "Review fictional moss" }), excerpt: "Second item context." },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(overview)));

    render(<App />);

    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Ready for agent 2" }));
    const firstRow = screen.getByRole("button", { name: "Select Add a fictional seed" });
    await user.click(firstRow);

    expect(screen.getByText("Use <strong>plain text</strong>, not rendered markup.")).toBeTruthy();
    expect(screen.queryByRole("strong")).toBeNull();
    expect(screen.getByText("Review fictional moss")).toBeTruthy();
    expect(firstRow.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Select Review fictional moss" }));
    expect(screen.queryByText("Use <strong>plain text</strong>, not rendered markup.")).toBeNull();
    expect(screen.getByText("Second item context.")).toBeTruthy();
  });

  it("moves a refreshed issue to its returned queue in queue order", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    const refreshed = {
      ...issue({ id: "I_1", number: 22, title: "Add a fictional seed" }),
      queue: "human",
      updatedAt: "2026-08-19T10:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(overview))
      .mockResolvedValueOnce(response({
        status: "updated",
        item: refreshed,
        fetchedAt: "2026-08-23T11:00:00.000Z",
        relationshipStatus: "fresh",
      })));

    render(<App />);

    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Ready for agent 2" }));
    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    await user.click(screen.getByRole("button", { name: "Refresh this item" }));

    expect(await screen.findByText("Item refreshed and moved to Needs me.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose an item" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs me 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Add a fictional seed" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Needs me 2" }));
    const rows = screen.getAllByRole("button", { name: /Select / });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Select Add a fictional seed",
      "Select Choose a garden name",
    ]);
  });

  it("removes a focused item and clears its notice after the focus move", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ status: "not_found" })));

    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ready for agent 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh this item" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("This item is no longer in the loaded work.")).toBeTruthy();
    expect(screen.queryByText("Add a fictional seed")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByText("This item is no longer in the loaded work.")).toBeNull();
  });

  it("applies live updates to the selected item and announces a normal close", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(readyOverview()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", TestEventSource);

    render(<App />);
    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    TestEventSource.last?.open();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    TestEventSource.last?.emit({ type: "updated", item: issue({ id: "I_1", number: 22, title: "Updated fictional seed" }) });
    expect(await screen.findByRole("heading", { name: "Updated fictional seed" })).toBeTruthy();

    TestEventSource.last?.emit({ type: "removed", nodeId: "I_1", itemType: "issue", number: 22, reason: "issue_closed" });
    expect(await screen.findByText("Issue #22 was closed on GitHub and removed from the loaded work.")).toBeTruthy();
    expect(screen.queryByText("Updated fictional seed")).toBeNull();
  });

  it("announces unselected removals and distinguishes a search exit from a queue move", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(readyOverview()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", TestEventSource);

    render(<App />);
    await screen.findByText("Add a fictional seed");
    TestEventSource.last?.open();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    TestEventSource.last?.emit({ type: "removed", nodeId: "I_2", itemType: "issue", number: 23, reason: "issue_closed" });
    expect(await screen.findByText("Issue #23 was closed on GitHub and removed from the loaded work.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter pull requests and issues" }), "seed");
    TestEventSource.last?.emit({ type: "updated", item: issue({ id: "I_1", number: 22, title: "A renamed item" }) });
    expect(await screen.findByText("Item refreshed and no longer matches this search.")).toBeTruthy();
  });

  it("does not let a delayed refresh response steal a newer selection", async () => {
    const user = userEvent.setup();
    const refresh = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockImplementationOnce(() => refresh.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Ready for agent 2" }));
    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    await user.click(screen.getByRole("button", { name: "Refresh this item" }));
    await user.click(screen.getByRole("button", { name: "Select Review fictional moss" }));

    refresh.resolve(response({ status: "not_found" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Review fictional moss" })).toBeTruthy());
    expect(screen.queryByText("This item is no longer in the loaded work.")).toBeNull();
  });
});

function readyOverview(): Extract<OverviewResponse, { status: "ready" }> {
  return {
    status: "ready" as const,
    fetchedAt: "2026-08-23T10:00:00.000Z",
    repositories: [
      { id: "R_1", nameWithOwner: "fictional-tools/garden" },
      { id: "R_2", nameWithOwner: "fictional-tools/river" },
    ],
    scope: {
      repositoryLimit: 50,
      repositoryCount: 2,
      itemLimit: 200,
      itemCount: 6,
      truncatedReason: "item_limit",
    },
    pullRequests: [pullRequest({ id: "PR_1", number: 41, title: "Keep fictional paths tidy" })],
    queues: [
      { name: "agent", issues: [issue({ id: "I_1", number: 22, title: "Add a fictional seed" }), issue({ id: "I_2", number: 23, title: "Review fictional moss" })] },
      { name: "human", issues: [issue({ id: "I_3", number: 24, title: "Choose a garden name" })] },
      { name: "triage", issues: [issue({ id: "I_4", number: 25, title: "Clarify fictional soil" }), issue({ id: "I_5", number: 26, title: "Sort fictional leaves" })] },
    ],
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function response(body: unknown) {
  return { ok: true, json: async () => body };
}

class TestEventSource {
  static last: TestEventSource | null = null;
  private readonly listeners = new Map<string, (event: Event) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    TestEventSource.last = this;
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, listener);
  }

  open() {
    this.onopen?.();
  }

  emit(data: unknown) {
    this.listeners.get("item")?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close() {}
}

function issue({ id, number, title }: { id: string; number: number; title: string }) {
  return {
    id,
    type: "issue" as const,
    repositoryId: "R_1",
    number,
    title,
    excerpt: null,
    url: `https://github.test/fictional-tools/garden/issues/${number}`,
    updatedAt: "2026-08-20T10:00:00.000Z",
    queue: "agent",
    readiness: { kind: "unblocked" as const },
  };
}

function pullRequest({ id, number, title }: { id: string; number: number; title: string }) {
  return {
    id,
    type: "pull_request" as const,
    repositoryId: "R_2",
    number,
    title,
    excerpt: null,
    url: `https://github.test/fictional-tools/river/pull/${number}`,
    updatedAt: "2026-08-21T10:00:00.000Z",
    isDraft: false,
    additions: 8,
    deletions: 3,
    closingIssues: { status: "complete" as const, items: [] },
  };
}
