// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ApiIssue } from "../api/read-models.js";
import { IssueOverlay } from "./IssueOverlay.js";

const item = { id: "I_1", number: 1, title: "Keep fictional preferences", url: "https://github.com/example/garden/issues/1" } as ApiIssue;
function show() { return render(<IssueOverlay item={item} repository="example/garden" onClose={() => {}} opener={null} fallback={null}><button>Refresh this item</button></IssueOverlay>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("renders full GFM text and blocks executable HTML and URL schemes", async () => {
  const body = "## Expected behavior\n\n**Keep preferences**\n\n" + "Long text. ".repeat(100) + "\n\nEnd of full body.\n\n- [x] Saved\n\n| Setting | Value |\n| --- | --- |\n| Hidden | Kept |\n\n```sh\nrun --check\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n[safe](https://example.com)\n\n[Related issue](/example/garden/issues/2)\n\n![Screenshot](../assets/example.png)";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "read", body }) }));
  const { container } = show();
  expect(await screen.findByRole("heading", { name: "Expected behavior" })).toBeTruthy();
  expect(screen.getByText("End of full body.")).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("Keep preferences");
  expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("table")).toBeTruthy();
  expect(container.querySelector("pre code")?.textContent).toContain("run --check");
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("unsafe").getAttribute("href")).toBeFalsy();
  expect(screen.getByRole("link", { name: "safe" }).getAttribute("rel")).toContain("noopener");
  expect(screen.getByRole("link", { name: "Related issue" }).getAttribute("href")).toBe("https://github.com/example/garden/issues/2");
  expect(screen.getByRole("img", { name: "Screenshot" }).getAttribute("src")).toBe("https://github.com/example/garden/assets/example.png");
});

it.each([null, "", "  \n"])("shows an empty body without using the cached excerpt", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "read", body }) }));
  show();
  expect(await screen.findByText("No description provided.")).toBeTruthy();
});

it("shows loading, recovers from failure, and keeps keyboard focus inside", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValueOnce({ ok: true, json: async () => ({ status: "read", body: "Recovered body" }) }));
  show();
  expect(screen.getByRole("status").textContent).toBe("Loading issue body…");
  await act(async () => resolve({ ok: false }));
  expect(screen.getByRole("alert").textContent).toContain("unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Recovered body")).toBeTruthy();
  screen.getByRole("button", { name: "Refresh this item" }).focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "GitHub ↗" }));
});

it("aborts a closed body's request and ignores its late response", async () => {
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce((_url, options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); }).mockResolvedValueOnce({ ok: true, json: async () => ({ status: "read", body: "New body" }) }));
  const first = show();
  first.unmount();
  expect(signal.aborted).toBe(true);
  show();
  expect(await screen.findByText("New body")).toBeTruthy();
  await act(async () => resolve({ ok: true, json: async () => ({ status: "read", body: "Stale body" }) }));
  await waitFor(() => expect(screen.queryByText("Stale body")).toBeNull());
});
