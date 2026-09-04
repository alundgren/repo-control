import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
});

test.afterAll(async () => {
  await server.close();
});

test("restores queue view, selection, filter, and browser scroll after closing changed files", async ({ page }) => {
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview() }));
  await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: diff() }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  await page.getByRole("button", { name: "Select Fictional pull request 1", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Filter pull requests and issues" });
  await search.fill("Fictional");
  await page.evaluate(() => window.scrollTo(0, 700));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(500);

  await page.getByRole("button", { name: "Review changed files" }).click();
  const dialog = page.getByRole("dialog", { name: "Fictional pull request 1" });
  const firstFile = dialog.getByRole("button", { name: /src\/example-1.ts/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Grouped" })).toHaveAttribute("aria-pressed", "true");
  await expect(firstFile).toHaveAttribute("aria-expanded", "true");
  await firstFile.click();
  await dialog.getByRole("button", { name: "Files", exact: true }).click();
  await expect(firstFile).toHaveAttribute("aria-expanded", "true");
  await dialog.getByRole("button", { name: "Grouped" }).click();
  await expect(firstFile).toHaveAttribute("aria-expanded", "false");

  await dialog.evaluate((element) => { element.scrollTop = 300; });
  await dialog.getByRole("button", { name: "Files", exact: true }).click();
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(0);
  await dialog.evaluate((element) => { element.scrollTop = 500; });
  await dialog.getByRole("button", { name: "Grouped" }).click();
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(300);
  await dialog.getByRole("button", { name: "Files", exact: true }).click();
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(500);
  await page.getByRole("button", { name: "Close changed files" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
  await expect(search).toHaveValue("Fictional");
  await expect(page.getByRole("button", { name: "Select Fictional pull request 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Review changed files" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});

test("keeps a linked file below the sticky review controls at a narrow width", async ({ page }) => {
  const title = "A fictional pull request with a long title that wraps across several lines on a narrow screen";
  await page.setViewportSize({ width: 375, height: 700 });
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview(title) }));
  await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: diff() }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  await page.getByRole("button", { name: `Select ${title}`, exact: true }).click();
  await page.getByRole("button", { name: "Review changed files" }).click();
  const dialog = page.getByRole("dialog", { name: title });
  const lineComment = dialog.getByRole("button", { name: "Draft comment on new line 1" }).first();
  const lineCommentBox = await lineComment.boundingBox();
  expect(lineCommentBox).not.toBeNull();
  expect(lineCommentBox!.x + lineCommentBox!.width).toBeLessThanOrEqual(375);
  await lineComment.click();
  await dialog.getByRole("textbox", { name: "New draft comment" }).fill("Keep this fictional name.");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog.getByText("1 comment pending")).toBeVisible();
  await dialog.getByRole("button", { name: "Files", exact: true }).click();
  const savedDraft = dialog.getByRole("textbox", { name: "Edit draft comment on src/example-1.ts, new line 1" });
  await expect(savedDraft).toHaveValue("Keep this fictional name.");
  await savedDraft.fill("Use this clearer fictional name.");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(savedDraft).toHaveValue("Use this clearer fictional name.");
  await dialog.getByRole("button", { name: "Grouped" }).click();
  await dialog.getByRole("link", { name: "src/example-30.ts", exact: true }).click();

  const stickyBottom = await dialog.locator(".diffTop").evaluate((element) => element.getBoundingClientRect().bottom);
  const fileTop = await dialog.getByRole("button", { name: /src\/example-30.ts/ }).evaluate((element) => element.getBoundingClientRect().top);
  expect(fileTop).toBeGreaterThanOrEqual(stickyBottom);
});

test("keeps the review header compact and the review bar at the viewport bottom", async ({ page }) => {
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview() }));
  await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: { ...diff(), reviewEnabled: true, mergeEnabled: true } }));
  await page.route("**/api/items/PR_1/merge", (route) => route.fulfill({ json: { status: "ready", headSha: "abc123def456", sourceBranch: "fictional-branch" } }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  await page.getByRole("button", { name: "Select Fictional pull request 1", exact: true }).click();
  await page.getByRole("button", { name: "Review changed files" }).click();
  const dialog = page.getByRole("dialog", { name: "Fictional pull request 1" });
  const header = dialog.locator(".diffHeader");
  const bar = dialog.getByLabel("Review and merge");

  await expect(header).toContainText("fictional-tools/garden · PR 1");
  await expect(header).toContainText("30 files · +1 −1");
  await expect(dialog.getByRole("button", { name: "Submit review…" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Squash and merge" })).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(72);
  const barBox = (await bar.boundingBox())!;
  expect(barBox.height).toBeLessThanOrEqual(80);
  expect(Math.round(barBox.y + barBox.height)).toBe(720);
});

function overview(firstTitle = "Fictional pull request 1") {
  return {
    status: "ready",
    fetchedAt: "2026-08-23T10:00:00.000Z",
    repositories: [{ id: "R_1", nameWithOwner: "fictional-tools/garden" }],
    scope: { repositoryCount: 1, itemCount: 40, truncatedReason: null },
    pullRequests: Array.from({ length: 40 }, (_, index) => ({
      id: `PR_${index + 1}`,
      type: "pull_request",
      repositoryId: "R_1",
      number: index + 1,
      title: index === 0 ? firstTitle : `Fictional pull request ${index + 1}`,
      excerpt: "A fictional change for browser validation.",
      url: `https://github.test/fictional-tools/garden/pull/${index + 1}`,
      updatedAt: new Date(Date.UTC(2026, 7, 23, 10, index)).toISOString(),
      isDraft: false,
      additions: 1,
      deletions: 1,
      closingIssues: { status: "complete", items: [] },
    })),
    queues: [
      { name: "agent", issues: [] },
      { name: "human", issues: [] },
      { name: "triage", issues: [] },
    ],
    epics: [],
  };
}

function diff() {
  const files = Array.from({ length: 30 }, (_, index) => ({
    path: `src/example-${index + 1}.ts`,
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 1,
    patch: { status: "available", text: `@@ -1 +1 @@\n-old\n+const fictionalValue = "${"long-value-".repeat(18)}";` },
  }));
  return {
    status: "complete",
    headSha: "abc123def456",
    fileCount: files.length,
    files,
    groups: [{ name: "src", fileIndexes: files.map((_, index) => index) }],
    rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-08-24T12:00:00.000Z" },
  };
}
