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
          epics: [],
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

  it("opens, folds, unfolds, and closes a pull-request diff while restoring focus", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({
        status: "complete",
        headSha: "abc123def456",
        fileCount: 2,
        rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-08-24T12:00:00.000Z" },
        files: [
          { path: "src/first.ts", previousPath: null, changeType: "modified", additions: 2, deletions: 2, patch: { status: "available", text: "@@ -1,2 +1,2 @@\n-<old>\n+<new>\n---counter\n+++counter" } },
          { path: "assets/image.png", previousPath: null, changeType: "modified", additions: 0, deletions: 0, patch: { status: "unavailable", reason: "github_omitted" } },
        ],
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    const opener = screen.getByRole("button", { name: "Review changed files" });
    opener.focus();
    await user.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "Keep fictional paths tidy" });
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(true);
    expect(within(dialog).getByText("abc123def456")).toBeTruthy();
    expect(within(dialog).getByText("-<old>")).toBeTruthy();
    expect(within(dialog).queryByRole("strong")).toBeNull();
    expect(within(within(dialog).getByText("---counter").parentElement!).getByText("Removed line:")).toBeTruthy();
    expect(within(within(dialog).getByText("+++counter").parentElement!).getByText("Added line:")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /src\/first.ts/ }).getAttribute("aria-expanded")).toBe("true");
    const unavailableFile = within(dialog).getByRole("button", { name: /assets\/image.png/ });
    expect(unavailableFile.getAttribute("aria-expanded")).toBe("false");
    await user.click(unavailableFile);
    expect(within(dialog).getByText("GitHub did not provide patch text for this file.")).toBeTruthy();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.getByRole("heading", { name: "Now" })).toBeTruthy();
  });

  it("states partial, incomplete, budget-limited, and failed diff reads with a GitHub fallback", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({
        status: "partial",
        partialReason: "file_limit",
        headSha: "abc123",
        fileCount: 3000,
        rateLimit: { cost: 31, remaining: 4900, resetAt: "2026-08-24T12:00:00.000Z" },
        files: [
          { path: "src/incomplete.ts", previousPath: null, changeType: "modified", additions: 2, deletions: 0, patch: { status: "incomplete", reason: "count_mismatch", text: "@@ -0,0 +1 @@\n+one" } },
          { path: "src/bounded.ts", previousPath: null, changeType: "modified", additions: 1, deletions: 0, patch: { status: "unavailable", reason: "patch_budget" } },
        ],
      }))
      .mockResolvedValueOnce(response({ status: "unavailable", error: { code: "unavailable", message: "GitHub work data is unavailable." } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    expect(await screen.findByText(/GitHub limits this list to 3,000 changed files/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the pull request on GitHub" })).toBeTruthy();
    expect(screen.getByText("This patch may be incomplete because its lines do not match GitHub's file totals.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /src\/bounded.ts/ }));
    expect(screen.getByText("The 5 MiB patch limit was reached before this file.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close changed files" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    expect(await screen.findByText("Changed files could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open this pull request on GitHub" })).toBeTruthy();
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

  it("gives epics their own navigation, list, quick read, and Now preview", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    overview.queues[0]!.issues = [issue({ id: "I_1", number: 22, title: "Add a fictional seed" })];
    overview.epics = [
      epicIssue({ id: "I_epic_1", number: 2, title: "Epic: offline sync", subIssues: { completed: 5, total: 14 } }),
      epicIssue({ id: "I_epic_2", number: 3, title: "Onboarding pass" }),
      epicIssue({ id: "I_epic_3", number: 4, title: "Digest rework", subIssues: { completed: 9, total: 9 } }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(overview)));

    render(<App />);

    await screen.findByText("Add a fictional seed");
    expect(screen.getByRole("button", { name: "Epics 3" })).toBeTruthy();

    const nowSection = screen.getByRole("region", { name: "Epics" });
    expect(within(nowSection).getByText("Epic: offline sync")).toBeTruthy();
    expect(within(nowSection).getByText("5/14")).toBeTruthy();
    expect(within(nowSection).queryByText("Digest rework")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Epics 3" }));
    expect(screen.getByRole("heading", { name: "Epics" })).toBeTruthy();
    expect(screen.getByText("Epic: offline sync")).toBeTruthy();
    expect(screen.getByText("5/14")).toBeTruthy();
    expect(screen.getByText("No sampled progress")).toBeTruthy();
    expect(screen.queryByText("Add a fictional seed")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Select Epic: offline sync" }));
    expect(await screen.findByRole("heading", { name: "Epic: offline sync" })).toBeTruthy();
    expect(screen.getByText("5 of 14 children closed.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Now 8" }));
    const epicRows = within(screen.getByRole("region", { name: "Epics" })).getAllByRole("button", { name: /Select / });
    expect(epicRows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Select Epic: offline sync",
      "Select Onboarding pass",
    ]);
  });

  it("routes live updates of unqueued issues into the epics view", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(readyOverview()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", TestEventSource);

    render(<App />);
    await screen.findByText("Add a fictional seed");
    TestEventSource.last?.open();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    TestEventSource.last?.emit({ type: "updated", item: epicIssue({ id: "I_new_epic", number: 30, title: "Epic: fresh container", subIssues: { completed: 1, total: 4 } }) });

    fireEvent.click(await screen.findByRole("button", { name: "Epics 1" }));
    expect(screen.getByText("Epic: fresh container")).toBeTruthy();
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  it("marks work rows with static relationship pills that do not compete with status facts", async () => {
    const overview = readyOverview();
    overview.queues[0]!.issues = [
      {
        ...issue({ id: "I_1", number: 22, title: "Add a fictional seed" }),
        epic: {
          id: "I_epic_9",
          repositoryId: "R_2",
          repositoryNameWithOwner: "fictional-tools/garden",
          number: 9,
          title: "Epic: offline sync",
          url: "https://github.test/fictional-tools/garden/issues/9",
          subIssues: { completed: 5, total: 14 },
        },
      },
      {
        ...issue({ id: "I_2", number: 23, title: "Review fictional moss" }),
        epic: {
          id: "I_epic_10",
          repositoryId: "R_2",
          repositoryNameWithOwner: "fictional-tools/garden",
          number: 10,
          title: "Epic: a very long epic title spanning widely across the tracker",
          url: "https://github.test/fictional-tools/garden/issues/10",
          subIssues: null,
        },
      },
    ];
    overview.pullRequests = [{
      ...pullRequest({ id: "PR_1", number: 41, title: "Keep fictional paths tidy" }),
      closingIssues: {
        status: "complete" as const,
        items: [{
          id: "I_closing",
          repositoryId: "R_2",
          repositoryNameWithOwner: "fictional-tools/river",
          number: 44,
          title: "Close the river loop",
          url: "https://github.test/fictional-tools/river/issues/44",
        }],
      },
    }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(overview)));

    render(<App />);

    await screen.findByText("Add a fictional seed");
    const seedRow = screen.getByRole("button", { name: "Select Add a fictional seed" });
    const mossRow = screen.getByRole("button", { name: "Select Review fictional moss" });
    const pullRequestRow = screen.getByRole("button", { name: "Select Keep fictional paths tidy" });

    const offlinePill = within(seedRow).getByText("offline sync · 5/14");
    expect(offlinePill.tagName).toBe("SPAN");

    const truncatedPill = within(mossRow).getByText("a very long epic…");
    expect(truncatedPill.tagName).toBe("SPAN");

    const closingPill = within(pullRequestRow).getByText("fictional-tools/river#44");
    expect(closingPill.tagName).toBe("SPAN");
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
    epics: [],
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
    queue: "agent" as const,
    readiness: { kind: "unblocked" as const },
    epic: null,
    subIssues: null,
  };
}

function epicIssue({ id, number, title, subIssues }: { id: string; number: number; title: string; subIssues?: { completed: number; total: number } }) {
  return {
    ...issue({ id, number, title }),
    queue: null as string | null,
    subIssues: subIssues ?? null,
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
