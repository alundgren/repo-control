// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewResponse } from "../api/read-models.js";
import { App } from "./App.js";

describe("work queue overview", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the sampled Now view with complete queue counts", async () => {
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
    expect(screen.getByText(/Sampled .* · 6 items from 2 repositories · Partial result/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync sampled view" })).toBeTruthy();
    expect(screen.queryByText("Current work")).toBeNull();
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
    const search = screen.getByRole("searchbox", { name: "Search loaded work" });

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
    const refreshButton = screen.getByRole("button", { name: "Sync sampled view" });
    await user.click(refreshButton);

    const syncingButton = screen.getByRole("button", { name: "Syncing sampled view…" });
    expect(syncingButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();

    refresh.resolve(response({
      status: "complete",
      fetchedAt: "2026-08-23T11:00:00.000Z",
      scope: readyOverview().scope,
    }));

    expect(await screen.findByText("Sample synced just now.")).toBeTruthy();
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
    await user.click(screen.getByRole("button", { name: "Sync sampled view" }));

    expect(await screen.findByText("Sync failed. Showing the previous sample. Try again.")).toBeTruthy();
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

    await user.click(screen.getByRole("button", { name: "See all open pull requests" }));
    expect(screen.getByText("Water the fictional garden")).toBeTruthy();
  });

  it("shows partial sampled sync as a warning without clearing the queue", async () => {
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
    await user.click(screen.getByRole("button", { name: "Sync sampled view" }));

    expect(await screen.findByText("Sample synced with a partial result.")).toBeTruthy();
    expect(screen.getByText(/Partial result/)).toBeTruthy();
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
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
  };
}
