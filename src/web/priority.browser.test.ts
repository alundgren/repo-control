import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { PriorityRead } from "../priority/types.js";

let server: ViteDevServer;
let origin: string;
let pageErrors: string[];
test.beforeEach(async ({ page }) => { pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message)); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });
test.beforeAll(async () => {
  server = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); origin = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { await server.close(); });

const paths = ["src/auth/verify.ts", "src/config/workspaceSecrets.ts", "src/workspaces/policies/limits/applyWorkspaceDeliveryPolicy.ts", "test/events.test.ts", "docs/events.md", "generated/events.ts"];
const files = paths.map((path) => ({ path, previousPath: null, changeType: "modified", additions: 1, deletions: 1,
  patch: { status: "available", text: "@@ -1 +1 @@\n-oldValue\n+verifiedValue" } }));
const completed: PriorityRead = { status: "completed", attempts: 1, enqueuedAt: "2026-08-24T12:00:00Z", result: { headSha: "abc123", evidence: [], policyStatus: "absent",
  files: paths.map((path, index) => ({ path, tier: [5, 5, 4, 3, 2, 1][index] as 1 | 2 | 3 | 4 | 5, reason: `Checks changed behavior for file ${index + 1}.` })) } };

async function open(page: Page, priority: PriorityRead = completed) {
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: {
    status: "ready", fetchedAt: "2026-08-24T12:00:00Z", repositories: [{ id: "R_fixture", nameWithOwner: "fern/tools" }],
    scope: { repositoryCount: 1, itemCount: 1, truncatedReason: null }, queues: [], epics: [], issues: [], pullRequests: [{
      id: "PR_fixture", type: "pull_request", repositoryId: "R_fixture", number: 42, title: "Keep workspace events private", url: "https://github.test/fern/tools/pull/42",
      excerpt: null, updatedAt: "2026-08-24T12:00:00Z", isDraft: false, additions: 6, deletions: 6, closingIssues: { status: "complete", items: [] },
    }],
  } }));
  await page.route("**/api/items/PR_fixture/diff", (route) => route.fulfill({ json: { status: "complete", headSha: "abc123", fileCount: files.length, files, groups: [{ name: "Changes", fileIndexes: files.map((_, index) => index) }], reviewEnabled: true, mergeEnabled: false, priority } }));
  await page.route("**/api/items/PR_fixture/priority?*", (route) => route.fulfill({ json: priority }));
  await page.goto(origin);
  await page.getByRole("button", { name: "Select Keep workspace events private" }).click();
  await expect(page.getByRole("combobox", { name: "Review aspect" })).toHaveValue("priority");
  return page.getByRole("dialog");
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`filters exact tiers with expanded files and no comment controls at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const dialog = await open(page);
    await expect(dialog.getByRole("article")).toHaveCount(2);
    await expect(dialog.getByRole("navigation", { name: "Changed files" })).toBeHidden();
    const code = await dialog.locator(".unifiedDiff").first().boundingBox();
    expect(code!.width).toBeGreaterThan(viewport.width * 0.95);
    expect(code!.y).toBeLessThan(viewport.width > 700 ? 220 : 340);
    await dialog.getByRole("button", { name: "Navigator", exact: true }).click();
    await expect(dialog.getByRole("link", { name: paths[0], exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Navigator", exact: true }).click();

    await expect(dialog.getByText("Some evidence is incomplete or unavailable. See Details above.")).toHaveCount(0);
    await dialog.getByText("Details", { exact: true }).click();
    await expect(dialog.getByText("Root AGENTS.md: absent.")).toBeVisible();
    await dialog.getByText("Details", { exact: true }).click();
    await expect(dialog.getByRole("button", { name: "5 Critical 2" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: /src\/auth\/verify.ts/ })).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByRole("button", { name: /workspaceSecrets.ts/ })).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByText("Checks changed behavior for file 2.", { exact: false })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(dialog.getByRole("button", { name: /Draft comment|Submit review/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "4 Important 1" }).click();
    await expect(dialog.getByRole("article")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: /applyWorkspaceDeliveryPolicy.ts/ })).toBeVisible();
    await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("files");
    await expect(dialog.getByRole("article")).toHaveCount(6);
    await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("priority");
    await expect(dialog.getByRole("button", { name: "5 Critical 2" })).toHaveAttribute("aria-pressed", "true");
    const filename = dialog.locator(".diffFileLabel").first();
    const pathBox = await filename.locator(".diffPath").boundingBox();
    const reasonBox = await filename.locator(".filePriorityReason").boundingBox();
    if (viewport.width > 700) expect(Math.abs(pathBox!.y - reasonBox!.y)).toBeLessThan(8);
    await dialog.getByRole("button", { name: /src\/auth\/verify.ts/ }).click();
    await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("files");
    await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("priority");
    await expect(dialog.getByRole("button", { name: /src\/auth\/verify.ts/ })).toHaveAttribute("aria-expanded", "false");
  });
}

test("shows the empty critical tier without opening lower tiers", async ({ page }) => {
  const empty = { ...completed, result: { ...completed.result!, files: completed.result!.files.map((file) => ({ ...file, tier: file.tier === 5 ? 4 as const : file.tier })) } };
  const dialog = await open(page, empty);
  await expect(dialog.getByText("No critical files")).toBeVisible();
  await expect(dialog.getByRole("article")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Review tier 4" }).click();
  await expect(dialog.getByRole("article")).toHaveCount(3);
});

for (const status of ["queued", "running", "failed", "expired", "stale", "ineligible", "disabled", "unavailable"] as const) {
  test(`keeps ${status} scores hidden and offers the existing Files view`, async ({ page }) => {
    const dialog = await open(page, { status, attempts: status === "failed" ? 2 : 1 });
    await expect(dialog.getByRole("article")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /5 Critical/ })).toBeDisabled();
    await dialog.getByRole("button", { name: "Review all files" }).click();
    await expect(dialog.getByRole("article")).toHaveCount(6);
  });
}

test("refreshes a waiting result and then hides scores when the head moves", async ({ page }) => {
  await page.clock.install();
  const dialog = await open(page, { status: "queued", attempts: 0 });
  await page.route("**/api/items/PR_fixture/priority?*", (route) => route.fulfill({ json: completed }));
  await page.clock.fastForward(15_000);
  await expect(dialog.getByRole("article")).toHaveCount(2);
  await page.route("**/api/items/PR_fixture/priority?*", (route) => route.fulfill({ json: { status: "stale", attempts: 1 } }));
  await page.clock.fastForward(15_000);
  await expect(dialog.getByRole("article")).toHaveCount(0);
  await expect(dialog.getByText("The pull request changed. Earlier priorities are hidden.", { exact: true }).last()).toBeVisible();
});
