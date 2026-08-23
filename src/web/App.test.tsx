// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(screen.getByRole("link", { name: "Pull requests 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ready for agent 2" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Needs me 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Triage 2" })).toBeTruthy();
    expect(screen.getByText(/Sample of 6 items from 2 repositories\. Refreshed .*\. Partial result\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh sample" })).toBeTruthy();
  });

  it("opens full lists and searches the loaded work with keyboard navigation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(readyOverview())),
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Now" });
    const agentNavigation = screen.getByRole("link", { name: "Ready for agent 2" });
    agentNavigation.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("heading", { name: "Ready for agent" })).toBeTruthy();
    expect(agentNavigation.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
    expect(screen.getByText("Review fictional moss")).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Now 6" }));
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
    const refreshButton = screen.getByRole("button", { name: "Refresh sample" });
    await user.click(refreshButton);

    expect(refreshButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
    expect(screen.getByText("Refreshing sample…")).toBeTruthy();

    refresh.resolve(response({
      status: "complete",
      fetchedAt: "2026-08-23T11:00:00.000Z",
      scope: readyOverview().scope,
    }));

    expect(await screen.findByText("Sample refreshed just now.")).toBeTruthy();
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
    await user.click(screen.getByRole("button", { name: "Refresh sample" }));

    expect(await screen.findByText("Refresh failed. Showing the current sample. Try again.")).toBeTruthy();
    expect(screen.getByText("Add a fictional seed")).toBeTruthy();
  });
});

function readyOverview() {
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
