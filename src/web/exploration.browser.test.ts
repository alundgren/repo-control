import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { ExplorationTurn } from "../exploration/contracts.js";
let server: ViteDevServer;
let origin: string;
const headSha = "a".repeat(40);
test.beforeAll(async () => { server = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } }); await server.listen(); origin = server.resolvedUrls!.local[0]!; });
test.afterAll(async () => { await server.close(); });
const source = { id: "s1", path: "src/shipping/delivery.ts", side: "RIGHT", startLine: 1, endLine: 2, code: "export function deliveryDate(order) {\n  return nextWorkingDay(order);" };
async function open(page: Page) {
  await page.route("**/events", route => route.abort());
  await page.route("**/api/overview", route => route.fulfill({ json: {
    status: "ready", fetchedAt: "2026-09-01T12:00:00Z", repositories: [{ id: "R_fixture", nameWithOwner: "sample/orchard" }], scope: { repositoryCount: 1, itemCount: 1, truncatedReason: null }, queues: [], epics: [], issues: [], pullRequests: [{ id: "PR_fixture", type: "pull_request", repositoryId: "R_fixture", number: 42, title: "Correct late delivery dates", url: "https://github.test/sample/orchard/pull/42", excerpt: null, updatedAt: "2026-09-01T12:00:00Z", isDraft: false, additions: 2, deletions: 1, closingIssues: { status: "complete", items: [] } }],
  } }));
  await page.route("**/api/items/PR_fixture/diff", route => route.fulfill({ json: { status: "complete", headSha, explorationEnabled: true, mergeEnabled: false, reviewEnabled: false, fileCount: 1, files: [{ path: source.path, previousPath: null, changeType: "modified", additions: 2, deletions: 1, patch: { status: "available", text: "@@ -1 +1,2 @@\n-old\n+export function deliveryDate(order) {\n+  return nextWorkingDay(order);" } }], groups: [{ name: "Shipping", fileIndexes: [0] }], priority: { status: "disabled" } } }));
  await page.route("**/api/exploration/sessions", route => route.fulfill({ json: { sessionId: "session-fictional", headSha } }));
  await page.route("**/api/exploration/sessions/session-fictional", route => route.fulfill({ json: { status: "closed" } }));
  await page.route("**/api/exploration/sessions/session-fictional/cancel", route => route.fulfill({ json: { status: "cancelled" } }));
  await page.goto(origin);
  await page.getByRole("button", { name: "Select Correct late delivery dates" }).click();
  await page.getByRole("combobox", { name: "Review aspect" }).selectOption("files");
}
for (const width of [1440, 1024, 390]) {
  test(`combines guided review and code-attached freeform questions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const turns: ExplorationTurn[] = [];
    await page.route("**/api/exploration/sessions/*/turns", async route => {
      const turn = route.request().postDataJSON() as ExplorationTurn; turns.push(turn);
      await route.fulfill({ json: { turnId: turn.turnId, headSha, sources: [source], notices: ["Partial text search: 1 file inspected."], answer: { version: 1, kind: "answer", message: turn.guided ? "Start with the cutoff calculation." : "This advances the order to the next working day.", actions: turn.guided ? [{ kind: "guide", items: [{ sourceId: "s1", label: "Check the cutoff", explanation: "Check how a Friday order advances past the weekend." }] }] : [{ kind: "explain", sourceId: "s1", text: "The caller advances past non-working days." }], question: null } } });
    });
    await open(page);
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start guided review" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Question for the review agent" })).toBeFocused();
    await page.getByRole("button", { name: "Start guided review" }).click();
    await page.getByRole("button", { name: /1. Check the cutoff/ }).click();
    await expect(page.getByRole("article", { name: "Agent code location" })).toContainText("Check how a Friday order");
    await page.screenshot({ path: `/tmp/exploration-${width}-${testInfo.project.name}.png` });
    await page.getByRole("button", { name: "Ask about this code" }).click();
    await page.getByRole("textbox", { name: "Question for the review agent" }).fill("What happens on Friday?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("This advances the order to the next working day.", { exact: true })).toBeVisible();
    expect(turns[0]?.guided).toBe(true);
    expect(turns[1]?.selection).toEqual({ path: source.path, side: "RIGHT", startLine: 1, endLine: 2 });
    await page.getByRole("button", { name: "Close agent chat" }).click();
    await page.getByRole("button", { name: "Back to review" }).click();
    await expect(page.getByRole("article", { name: source.path })).toBeVisible();
    expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
}
test("starts freeform from selected lines and retains the question after invalid output", async ({ page }) => {
  let fail = true;
  const turns: ExplorationTurn[] = [];
  await page.route("**/api/exploration/sessions/*/turns", async route => {
    const turn = route.request().postDataJSON() as ExplorationTurn; turns.push(turn);
    if (fail) await route.fulfill({ status: 503, json: { status: "error", code: "invalid_response" } });
    else await route.fulfill({ json: { turnId: turn.turnId, headSha, sources: [], notices: [], answer: { version: 1, kind: "answer", message: "Which behavior should we inspect?", actions: [], question: { text: "Choose a focus", options: ["Weekend handling", "Warehouse cutoff"] } } } });
  });
  await open(page);
  await page.getByRole("button", { name: "Select head line 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Question for the review agent" }).fill("Explain this function");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No actions were applied");
  await expect(page.getByRole("textbox")).toHaveValue("Explain this function");
  expect(turns[0]?.guided).toBe(false);
  expect(turns[0]?.selection?.startLine).toBe(1);
  fail = false;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Weekend handling" })).toBeVisible();
  await page.getByRole("button", { name: "Remove code selection" }).click();
  await expect(page.getByText("Context: this PR")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ask agent", exact: true })).toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("discards stopped responses and disables navigation after a revision change", async ({ page }) => {
  let requestNumber = 0;
  let release!: () => void;
  await page.route("**/api/exploration/sessions/*/turns", async route => {
    requestNumber++;
    const turn = route.request().postDataJSON() as ExplorationTurn;
    if (requestNumber === 1) {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: { turnId: turn.turnId, headSha, sources: [], notices: [], answer: { version: 1, kind: "answer", message: "Late answer must be discarded", actions: [], question: null } } }).catch(() => {});
    } else if (requestNumber === 2) {
      await route.fulfill({ json: { turnId: turn.turnId, headSha, sources: [source], notices: [], answer: { version: 1, kind: "answer", message: "Inspect the caller", actions: [{ kind: "explain", sourceId: "s1", text: "A pinned explanation" }], question: null } } });
    } else await route.fulfill({ status: 409, json: { status: "error", code: "head_changed" } });
  });
  await open(page);
  await page.getByRole("button", { name: "Ask agent", exact: true }).click();
  await page.getByRole("textbox").fill("Explain the caller");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestNumber).toBe(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click(); release();
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Inspect the caller", { exact: true })).toBeVisible();
  await expect(page.getByText("Late answer must be discarded")).toHaveCount(0);
  await page.getByRole("textbox").fill("What else?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("This PR changed");
  await expect(page.getByRole("button", { name: "Read explanation at the code" })).toBeDisabled();
});

for (const outcome of ["success", "failure", "guided"] as const) {
  test(`preserves a newer composer draft after delayed ${outcome}`, async ({ page }) => {
    let release!: () => void;
    let started = false;
    await page.route("**/api/exploration/sessions/*/turns", async route => {
      const turn = route.request().postDataJSON() as ExplorationTurn;
      started = true;
      await new Promise<void>(resolve => { release = resolve; });
      if (outcome === "failure") await route.fulfill({ status: 503, json: { status: "error", code: "invalid_response" } });
      else await route.fulfill({ json: { turnId: turn.turnId, headSha, sources: [], notices: [], answer: { version: 1, kind: "answer", message: "The submitted question is answered.", actions: [], question: null } } });
    });
    await open(page);
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    if (outcome === "guided") await page.getByRole("button", { name: "Start guided review" }).click();
    else {
      await page.getByRole("textbox").fill("Question A");
      await page.getByRole("button", { name: "Send", exact: true }).click();
    }
    await expect.poll(() => started).toBe(true);
    await page.getByRole("textbox").fill("Question B, typed while waiting");
    release();
    if (outcome === "failure") await expect(page.getByRole("alert")).toBeVisible();
    else await expect(page.getByText("The submitted question is answered.", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("Question B, typed while waiting");
  });
}
