// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewResponse } from "../api/read-models.js";
import { App } from "./App.js";
import { DraftCommentStore, maxDraftBodyBytes } from "./draft-comments.js";

describe("work queue overview", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
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

  it("filters Ready everywhere but lets Ready and Now searches find hidden work with a reason", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    const eligible = issue({ id: "I_ready", number: 30, title: "Start fictional irrigation" });
    const unavailable = { ...issue({ id: "I_unknown", number: 31, title: "Check fictional weather" }), readiness: { kind: "unavailable" as const } };
    const claimed = { ...issue({ id: "I_claimed", number: 32, title: "Plant claimed bulbs" }), readyExclusion: "claimed" as const };
    const blocked = {
      ...issue({ id: "I_blocked", number: 33, title: "Repair blocked trellis" }),
      readiness: { kind: "blocked" as const, blockers: [{ status: "unknown" as const, id: "I_blocker" }] },
      readyExclusion: "blocked" as const,
    };
    const humanClaimed = { ...overview.queues[1]!.issues[0]!, title: "Review human claim", readyExclusion: null };
    overview.queues[1]!.issues = [humanClaimed];
    overview.issues = [eligible, unavailable, claimed, blocked, humanClaimed, ...overview.queues.slice(2).flatMap((queue) => queue.issues)];
    overview.queues[0]!.issues = [eligible, unavailable];
    overview.scope.itemCount = overview.pullRequests.length + overview.issues.length;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(overview)));

    render(<App />);

    await screen.findByText("Start fictional irrigation");
    const readyPreview = screen.getByRole("region", { name: "Ready for agent" });
    expect(within(readyPreview).getByText("Check fictional weather")).toBeTruthy();
    expect(within(readyPreview).queryByText("Plant claimed bulbs")).toBeNull();
    expect(within(readyPreview).queryByText("Repair blocked trellis")).toBeNull();
    expect(screen.getByRole("button", { name: "Ready for agent 2" })).toBeTruthy();
    expect(screen.queryByText("Unblocked")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Ready for agent 2" }));
    const search = screen.getByRole("searchbox", { name: "Filter pull requests and issues" });
    await user.type(search, "claimed bulbs");
    expect(screen.getByText("Plant claimed bulbs")).toBeTruthy();
    expect(screen.getByText("Hidden from Ready: claimed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: `Now ${overview.scope.itemCount - 2}` }));
    await user.type(search, "blocked trellis");
    expect(screen.getByText("Repair blocked trellis")).toBeTruthy();
    expect(screen.getByText("Hidden from Ready: blocked")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "human claim");
    expect(screen.getByText("Review human claim")).toBeTruthy();
    expect(screen.queryByText(/Hidden from Ready:/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Needs me 1" }));
    await user.type(search, "blocked trellis");
    expect(screen.queryByText("Repair blocked trellis")).toBeNull();
  });

  it("keeps an already-hidden Ready search result selected after focused refresh", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    const claimed = { ...overview.issues[0]!, title: "Claimed fictional seed", readyExclusion: "claimed" as const };
    overview.issues = overview.issues.map((item) => item.id === claimed.id ? claimed : item);
    overview.queues[0]!.issues = overview.queues[0]!.issues.filter((item) => item.id !== claimed.id);
    const refreshed = { ...claimed, title: "Refreshed claimed fictional seed" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(overview))
      .mockResolvedValueOnce(response({ status: "updated", item: refreshed, fetchedAt: "2026-08-23T11:00:00.000Z", relationshipStatus: "fresh" })));

    render(<App />);
    await screen.findByText("Review fictional moss");
    await user.click(screen.getByRole("button", { name: "Ready for agent 1" }));
    const search = screen.getByRole("searchbox", { name: "Filter pull requests and issues" });
    await user.type(search, "claimed fictional");
    await user.click(screen.getByRole("button", { name: "Select Claimed fictional seed" }));
    await user.click(screen.getByRole("button", { name: "Refresh this item" }));

    expect(await screen.findByRole("heading", { name: "Refreshed claimed fictional seed" })).toBeTruthy();
    expect(screen.getByText("Hidden from Ready: claimed")).toBeTruthy();
    expect(screen.queryByText(/left Ready for agent/)).toBeNull();
  });

  it("removes a Ready issue selected from Now when focused refresh marks it claimed", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    const refreshed = { ...overview.issues[0]!, readyExclusion: "claimed" as const };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(overview))
      .mockResolvedValueOnce(response({ status: "updated", item: refreshed, fetchedAt: "2026-08-23T11:00:00.000Z", relationshipStatus: "fresh" })));

    render(<App />);
    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    await user.click(screen.getByRole("button", { name: "Refresh this item" }));

    expect(await screen.findByText("This issue left Ready for agent because it is claimed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ready for agent 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose an item" })).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: "Filter pull requests and issues" });
    await user.type(search, "fictional seed");
    expect(screen.getByText("Hidden from Ready: claimed")).toBeTruthy();
  });

  it("keeps a Now search selection when focused refresh hides the issue from Ready", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    const refreshed = { ...overview.issues[0]!, readyExclusion: "claimed" as const };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(overview))
      .mockResolvedValueOnce(response({ status: "updated", item: refreshed, fetchedAt: "2026-08-23T11:00:00.000Z", relationshipStatus: "fresh" })));

    render(<App />);
    await screen.findByText("Add a fictional seed");
    const search = screen.getByRole("searchbox", { name: "Filter pull requests and issues" });
    await user.type(search, "fictional seed");
    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    await user.click(screen.getByRole("button", { name: "Refresh this item" }));

    expect(await screen.findByRole("heading", { name: "Add a fictional seed" })).toBeTruthy();
    expect(screen.getByText("Hidden from Ready: claimed")).toBeTruthy();
    expect(screen.queryByText(/left Ready for agent/)).toBeNull();
    expect(screen.getByRole("button", { name: "Ready for agent 1" })).toBeTruthy();
  });

  it("reconciles a Ready issue selected from Now after account sync without restoring stale data", async () => {
    const user = userEvent.setup();
    const before = readyOverview();
    const after = readyOverview();
    const claimed = { ...after.issues[0]!, readyExclusion: "claimed" as const };
    after.issues = after.issues.map((item) => item.id === claimed.id ? claimed : item);
    after.queues[0]!.issues = after.queues[0]!.issues.filter((item) => item.id !== claimed.id);
    const sync = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(before))
      .mockImplementationOnce(() => sync.promise)
      .mockResolvedValueOnce(response(after));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", TestEventSource);

    render(<App />);
    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    await user.click(screen.getByRole("button", { name: "Sync account" }));
    sync.resolve(response({ status: "complete", fetchedAt: after.fetchedAt, scope: after.scope }));

    expect(await screen.findByText("This issue left Ready for agent because it is claimed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ready for agent 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Add a fictional seed" })).toBeNull();

    TestEventSource.last?.emit({
      type: "updated",
      item: { ...after.issues[1]!, title: "Updated fictional moss" },
      repositories: after.repositories,
      scope: after.scope,
    });
    expect(await screen.findByText("Updated fictional moss")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ready for agent 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Add a fictional seed" })).toBeNull();
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
        groups: [
          { name: "Assets", fileIndexes: [1] },
          { name: "src", fileIndexes: [0] },
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
    const overlay = dialog as HTMLDivElement;
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Grouped" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("heading", { name: "Assets" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "src" })).toBeTruthy();
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
    overlay.scrollTop = 140;
    await user.click(within(dialog).getByRole("button", { name: "Files" }));
    expect(overlay.scrollTop).toBe(0);
    expect(within(dialog).getByRole("button", { name: /assets\/image.png/ }).getAttribute("aria-expanded")).toBe("false");
    expect(within(dialog).getByRole("button", { name: /src\/first.ts/ }).getAttribute("aria-expanded")).toBe("true");
    overlay.scrollTop = 260;
    await user.click(within(dialog).getByRole("button", { name: "Grouped" }));
    expect(overlay.scrollTop).toBe(140);
    expect(within(dialog).getByRole("button", { name: /assets\/image.png/ }).getAttribute("aria-expanded")).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: "Files" }));
    expect(overlay.scrollTop).toBe(260);
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
        groups: [{ name: "src", fileIndexes: [0, 1] }],
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

  it("creates, edits, restores, and deletes a line draft across both arrangements", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff()))
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff()));
    vi.stubGlobal("fetch", fetchMock);

    const firstRender = render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    const dialog = await screen.findByRole("dialog", { name: "Keep fictional paths tidy" });
    await user.click(within(dialog).getByRole("button", { name: "Draft comment on new line 1" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "New draft comment" }), { target: { value: "Please keep this fictional name." } });
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));

    expect(within(dialog).getByText("1 pending")).toBeTruthy();
    const groupedDraft = within(dialog).getByRole("textbox", { name: "Edit draft comment on src/first.ts, new line 1" });
    expect((groupedDraft as HTMLTextAreaElement).value).toBe("Please keep this fictional name.");
    await user.click(within(dialog).getByRole("button", { name: "Files" }));
    expect(within(dialog).getByText("1 pending")).toBeTruthy();
    expect(within(dialog).getAllByRole("textbox", { name: "Edit draft comment on src/first.ts, new line 1" })).toHaveLength(1);
    const filesDraft = within(dialog).getByRole("textbox", { name: "Edit draft comment on src/first.ts, new line 1" });
    fireEvent.change(filesDraft, { target: { value: "Use the clearer fictional name." } });
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));

    firstRender.unmount();
    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    const restoredDialog = await screen.findByRole("dialog", { name: "Keep fictional paths tidy" });
    expect((within(restoredDialog).getByRole("textbox", { name: "Edit draft comment on src/first.ts, new line 1" }) as HTMLTextAreaElement).value).toBe("Use the clearer fictional name.");
    await user.click(within(restoredDialog).getByRole("button", { name: "Discard draft" }));
    expect(within(restoredDialog).getByText("0 pending")).toBeTruthy();
    expect(within(restoredDialog).queryByRole("textbox", { name: "Edit draft comment on src/first.ts, new line 1" })).toBeNull();
  });

  it("waits for confirmation, submits all current-head comments once, and clears only that draft collection", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const store = new DraftCommentStore(window.sessionStorage);
    store.save("PR_1", "older-head", { id: "stale", path: "src/old.ts", line: 2, side: "LEFT", body: "Keep this stale draft." });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), reviewEnabled: true }))
      .mockResolvedValueOnce(response({ status: "submitted", reviewUrl: null, refresh: { status: "not_found" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Draft comment on new line 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New draft comment" }), { target: { value: "Use the fictional helper." } });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Summary, optional" }), { target: { value: "A short review summary." } });

    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("2 pending")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(await screen.findByText("Review submitted. Drafts for this head commit were cleared.")).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, request] = fetchMock.mock.calls[2]!;
    expect(request).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(request.body))).toEqual({
      expectedHeadSha: "abc123def456",
      summary: "A short review summary.",
      event: "COMMENT",
      comments: [{ path: "src/first.ts", line: 1, side: "RIGHT", body: "Use the fictional helper." }],
    });
    expect(screen.getByText("1 pending")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value).toBe("Keep this stale draft.");
  });

  it("preserves drafts and directs an ambiguous submission to GitHub without retrying", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), reviewEnabled: true }))
      .mockResolvedValueOnce(response({ status: "unknown" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Draft comment on new line 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New draft comment" }), { target: { value: "Keep this until the outcome is known." } });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(await screen.findByText("Submission outcome unknown.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Verify on GitHub before retrying." })).toBeTruthy();
    expect(screen.getByText("1 pending")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears submitted drafts while stating that the follow-up queue refresh failed", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    new DraftCommentStore(window.sessionStorage).save("PR_1", "abc123def456", {
      id: "draft-1",
      path: "src/first.ts",
      line: 1,
      side: "RIGHT",
      body: "A submitted fictional comment.",
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), reviewEnabled: true }))
      .mockResolvedValueOnce(response({ status: "submitted", reviewUrl: null, refresh: { status: "failed" } })));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Submit review" }));

    expect(await screen.findByText("Review submitted and drafts were cleared, but the queue could not refresh. Close the review and use Refresh this item.")).toBeTruthy();
    expect(screen.getByText("0 pending")).toBeTruthy();
    expect(screen.queryByText("The review was not submitted. Drafts were kept.")).toBeNull();
  });

  it("treats post-submission refresh permission denial as a queue refresh failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    new DraftCommentStore(window.sessionStorage).save("PR_1", "abc123def456", {
      id: "draft-1",
      path: "src/first.ts",
      line: 1,
      side: "RIGHT",
      body: "A submitted fictional comment.",
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), reviewEnabled: true }))
      .mockResolvedValueOnce(response({
        status: "submitted",
        reviewUrl: null,
        refresh: { status: "permission_denied", error: { code: "authentication_failed" }, item: readyOverview().pullRequests[0] },
      })));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    const dialog = await screen.findByRole("dialog", { name: "Keep fictional paths tidy" });
    await user.click(within(dialog).getByRole("button", { name: "Submit review" }));

    expect(await within(dialog).findByText("Review submitted and drafts were cleared, but the queue could not refresh. Close the review and use Refresh this item.")).toBeTruthy();
    expect(within(dialog).getByText("0 pending")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Keep fictional paths tidy" })).toBeTruthy();
  });

  it("warns against retry when a submitted draft's saved copy cannot be removed", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    new DraftCommentStore(window.sessionStorage).save("PR_1", "abc123def456", {
      id: "draft-1",
      path: "src/first.ts",
      line: 1,
      side: "RIGHT",
      body: "A submitted fictional comment.",
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), reviewEnabled: true }))
      .mockResolvedValueOnce(response({ status: "submitted", reviewUrl: null, refresh: { status: "not_found" } })));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Submit review" }));

    expect(await screen.findByText("Review submitted, but Repo Control could not confirm that its saved reload copy was cleared. Do not submit it again. If it returns after reload, discard it.")).toBeTruthy();
    expect(screen.getByText("0 pending")).toBeTruthy();
  });

  it("does not show review submission controls when the operator action is disabled", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), reviewEnabled: false })));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    expect(await screen.findByRole("dialog", { name: "Keep fictional paths tidy" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Submit review" })).toBeNull();
  });

  it("shows merge only when currently ready and confirms the pull request and source branch", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), reviewEnabled: true, mergeEnabled: true }))
      .mockResolvedValueOnce(response({ status: "ready", headSha: "abc123def456", sourceBranch: "fictional-branch" }))
      .mockResolvedValueOnce(response({ status: "merged", alreadyMerged: false, refresh: { status: "removed", reason: "pull_request_merged" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", TestEventSource);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    const mergeButton = await screen.findByRole("button", { name: "Squash and merge" });
    const mergeSection = mergeButton.closest("section");
    expect(mergeSection).not.toBeNull();
    expect(within(mergeSection!).getByRole("heading", { name: "Merge pull request" })).toBeTruthy();
    expect(within(mergeSection!).queryByRole("heading", { name: "Submit review" })).toBeNull();

    await user.click(mergeButton);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await user.click(mergeButton);

    expect(confirm).toHaveBeenLastCalledWith('Squash-merge PR41 "Keep fictional paths tidy" from source branch fictional-branch? This cannot be undone in Repo Control. Version one leaves the source branch in place.');
    expect(await screen.findByText("Merged. The source branch was left in place.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [url, request] = fetchMock.mock.calls[3]!;
    expect(url).toBe("/api/items/PR_1/merge");
    expect(request).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(request.body))).toEqual({ expectedHeadSha: "abc123def456" });
    TestEventSource.last?.emit({ type: "removed", nodeId: "PR_1", itemType: "pull_request", number: 41, reason: "pull_request_merged", scope: readyOverview().scope });
    await waitFor(() => expect(document.querySelector('[aria-label="Select Keep fictional paths tidy"]')).toBeNull());
    expect(screen.getByText("Merged. The source branch was left in place.")).toBeTruthy();
  });

  it("does not offer or request merge when readiness belongs to a newer head", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff("head-one"), mergeEnabled: true }))
      .mockResolvedValueOnce(response({ status: "ready", headSha: "head-two", sourceBranch: "fictional-branch" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));

    expect(await screen.findByText("The pull request changed or was no longer ready. Nothing was merged. Close and reopen the review to inspect current state.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Squash and merge" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not offer merge while checks are pending", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), mergeEnabled: true }))
      .mockResolvedValueOnce(response({ status: "checks_pending" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    expect(await screen.findByText("Required checks are still running.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Squash and merge" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("lets a person recheck unknown mergeability until GitHub reports ready", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), mergeEnabled: true }))
      .mockResolvedValueOnce(response({ status: "checking" }))
      .mockResolvedValueOnce(response({ status: "ready", headSha: "abc123def456", sourceBranch: "fictional-branch" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("button", { name: "Squash and merge" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("sends an ambiguous merge result to GitHub and does not retry", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response({ ...draftDiff(), mergeEnabled: true }))
      .mockResolvedValueOnce(response({ status: "ready", headSha: "abc123def456", sourceBranch: "fictional-branch" }))
      .mockResolvedValueOnce(response({ status: "failed", reason: "ambiguous" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Squash and merge" }));

    expect(await screen.findByText("Merge outcome unknown.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Verify on GitHub before trying again." })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Squash and merge" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps a moved-head draft visible until confirmed discard", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff("old-head")))
      .mockResolvedValueOnce(response(draftDiff("new-head"))));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Draft comment on new line 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New draft comment" }), { target: { value: "Copy this draft before discarding it." } });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.click(screen.getByRole("button", { name: "Draft comment on old line 1" }));
    const secondDraft = screen.getByRole("textbox", { name: "New draft comment" });
    fireEvent.change(secondDraft, { target: { value: "A second stale draft." } });
    await user.click(within(secondDraft.closest("form")!).getByRole("button", { name: "Save draft" }));
    await user.click(screen.getByRole("button", { name: "Close changed files" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));

    expect(await screen.findByRole("heading", { name: "Drafts from an earlier head commit" })).toBeTruthy();
    expect(screen.getByText("old-head")).toBeTruthy();
    expect(screen.getAllByRole("textbox", { name: "Draft body" }).map((element) => (element as HTMLTextAreaElement).value)).toEqual([
      "Copy this draft before discarding it.",
      "A second stale draft.",
    ]);
    await user.click(screen.getAllByRole("button", { name: "Discard draft" })[0]!);
    expect(screen.getByText("1 pending")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard all" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 pending")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard all" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByText("0 pending")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Drafts from an earlier head commit" })).toBeNull();
  }, 15_000);

  it("warns when a quota failure leaves drafts in memory only", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff())));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Draft comment on new line 1" }));
    await user.type(screen.getByRole("textbox", { name: "New draft comment" }), "Keep this in memory.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(screen.getByText("Reload recovery is unavailable. Drafts remain in memory while this page stays open.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Edit draft comment on src/first.ts, new line 1" }) as HTMLTextAreaElement).value).toBe("Keep this in memory.");
  });

  it("warns immediately when session storage is unavailable and keeps a draft in memory", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff())));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    expect(await screen.findByText("Reload recovery is unavailable. Drafts remain in memory while this page stays open.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Draft comment on new line 1" }));
    await user.type(screen.getByRole("textbox", { name: "New draft comment" }), "Keep this without storage.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(screen.getByText("1 pending")).toBeTruthy();
  });

  it("states the UTF-8 body limit without saving the rejected draft", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff())));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Draft comment on new line 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New draft comment" }), { target: { value: "å".repeat(maxDraftBodyBytes / 2 + 1) } });
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(screen.getByText("This comment is larger than the 16 KiB UTF-8 limit. The existing draft was kept.")).toBeTruthy();
    expect(screen.getByText("0 pending")).toBeTruthy();
  });

  it("states the 100-comment limit without losing saved drafts", async () => {
    const user = userEvent.setup();
    const store = new DraftCommentStore(window.sessionStorage);
    for (let index = 0; index < 100; index += 1) {
      store.save("PR_1", "abc123def456", { id: `draft-${index}`, path: "src/first.ts", line: 1, side: "RIGHT", body: `Draft ${index}` });
    }
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff())));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    expect(await screen.findByText("100 pending")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Draft comment on new line 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New draft comment" }), { target: { value: "One draft too many." } });
    await user.click(screen.getAllByRole("button", { name: "Save draft" }).at(-1)!);

    expect(screen.getByText("This head commit already has 100 draft comments. Existing drafts were kept.")).toBeTruthy();
    expect(screen.getByText("100 pending")).toBeTruthy();
  }, 15_000);

  it("states the aggregate tab limit without saving the rejected draft", async () => {
    const user = userEvent.setup();
    const store = new DraftCommentStore(window.sessionStorage);
    const fullBody = "x".repeat(maxDraftBodyBytes);
    let index = 0;
    while (store.save(`OTHER_PR_${index}`, "head", { id: `draft-${index}`, path: "src/example.ts", line: 1, side: "RIGHT", body: fullBody }).status === "saved") index += 1;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(readyOverview()))
      .mockResolvedValueOnce(response(draftDiff())));

    render(<App />);
    await screen.findByText("Keep fictional paths tidy");
    await user.click(screen.getByRole("button", { name: "Select Keep fictional paths tidy" }));
    await user.click(screen.getByRole("button", { name: "Review changed files" }));
    await user.click(await screen.findByRole("button", { name: "Draft comment on new line 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New draft comment" }), { target: { value: fullBody } });
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(screen.getByText("Saved drafts in this tab would exceed 1 MiB. Existing drafts were kept.")).toBeTruthy();
    expect(screen.getByText("0 pending")).toBeTruthy();
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

  it("removes and announces a Ready issue selected from Now that becomes blocked in a live update", async () => {
    const user = userEvent.setup();
    const overview = readyOverview();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(overview)));
    vi.stubGlobal("EventSource", TestEventSource);

    render(<App />);
    await screen.findByText("Add a fictional seed");
    await user.click(screen.getByRole("button", { name: "Select Add a fictional seed" }));
    TestEventSource.last?.emit({
      type: "updated",
      item: {
        ...overview.issues[0]!,
        readiness: { kind: "blocked", blockers: [{ status: "unknown", id: "I_blocker" }] },
        readyExclusion: "blocked",
      },
      repositories: overview.repositories,
      scope: overview.scope,
    });

    expect(await screen.findByText("This issue left Ready for agent because it has an open blocker.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ready for agent 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose an item" })).toBeTruthy();
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
    issues: [
      issue({ id: "I_1", number: 22, title: "Add a fictional seed" }),
      issue({ id: "I_2", number: 23, title: "Review fictional moss" }),
      issue({ id: "I_3", number: 24, title: "Choose a garden name" }),
      issue({ id: "I_4", number: 25, title: "Clarify fictional soil" }),
      issue({ id: "I_5", number: 26, title: "Sort fictional leaves" }),
    ],
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

function draftDiff(headSha = "abc123def456") {
  return {
    status: "complete",
    headSha,
    fileCount: 1,
    rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-24T12:00:00.000Z" },
    files: [{
      path: "src/first.ts",
      previousPath: null,
      changeType: "modified",
      additions: 1,
      deletions: 1,
      patch: { status: "available", text: "@@ -1 +1 @@\n-old\n+new" },
    }],
    groups: [{ name: "src", fileIndexes: [0] }],
  };
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
    readyExclusion: null,
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
