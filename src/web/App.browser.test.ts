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
  const headSha = "abc123def4567890abc123def4567890abc123de";
  await page.setViewportSize({ width: 375, height: 700 });
  await page.addInitScript(({ sha }) => {
    const drafts = Array.from({ length: 100 }, (_, index) => ({ id: `draft-${index}`, path: `src/pending-${index}.ts`, line: 1, side: "RIGHT", body: `Draft ${index}` }));
    window.sessionStorage.setItem(`repo-control:pull-request-drafts:PR_1:${sha}`, JSON.stringify({ pullRequestId: "PR_1", headSha: sha, drafts }));
  }, { sha: headSha });
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview(title) }));
  await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: diff(headSha) }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  await page.getByRole("button", { name: `Select ${title}`, exact: true }).click();
  await page.getByRole("button", { name: "Review changed files" }).click();
  const dialog = page.getByRole("dialog", { name: title });
  const lineComment = dialog.getByRole("button", { name: "Draft comment on new line 1" }).first();
  const lineCommentBox = await lineComment.boundingBox();
  expect(lineCommentBox).not.toBeNull();
  expect(lineCommentBox!.x + lineCommentBox!.width).toBeLessThanOrEqual(375);
  await expect(dialog.getByText("100 comments pending")).toBeVisible();
  await expect(dialog.locator(".pendingChip")).toContainText("100 pending");
  await expect(dialog.getByRole("button", { name: "Discard all" })).toBeVisible();
  const headerParts = [".diffIdentity", ".diffHeadSha", ".diffTitleDisclosure > button", ".diffClose", ".diffViewControls", ".pendingChip", ".diffDiscardAll"];
  const boxes = await Promise.all(headerParts.map((selector) => dialog.locator(selector).boundingBox()));
  for (const box of boxes) {
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
  }
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, `${headerParts[left]} overlaps ${headerParts[right]}`).toBe(false);
    }
  }
  await dialog.getByRole("button", { name: "Files", exact: true }).click();
  await dialog.getByRole("link", { name: "src/example-30.ts", exact: true }).click();
  let stickyBottom = await dialog.locator(".diffTop").evaluate((element) => element.getBoundingClientRect().bottom);
  let fileTop = await dialog.getByRole("button", { name: /src\/example-30.ts/ }).evaluate((element) => element.getBoundingClientRect().top);
  expect(fileTop).toBeGreaterThanOrEqual(stickyBottom);
  await dialog.getByRole("button", { name: "Grouped" }).click();
  await dialog.getByRole("link", { name: "src/example-30.ts", exact: true }).click();

  stickyBottom = await dialog.locator(".diffTop").evaluate((element) => element.getBoundingClientRect().bottom);
  fileTop = await dialog.getByRole("button", { name: /src\/example-30.ts/ }).evaluate((element) => element.getBoundingClientRect().top);
  expect(fileTop).toBeGreaterThanOrEqual(stickyBottom);
  expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(375);
});

test("keeps the review header compact and the review bar at the viewport bottom", async ({ page }) => {
  const title = "A fictional pull request title long enough to prove the compact laptop header truncates without hiding its controls";
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview(title) }));
  await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: { ...diff(), reviewEnabled: true, mergeEnabled: true } }));
  await page.route("**/api/items/PR_1/merge", (route) => route.fulfill({ json: { status: "ready", headSha: "abc123def456", sourceBranch: "fictional-branch" } }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  await page.getByRole("button", { name: `Select ${title}`, exact: true }).click();
  await page.getByRole("button", { name: "Review changed files" }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await dialog.getByRole("button", { name: "Draft comment on new line 1" }).first().click();
  await dialog.getByRole("textbox", { name: "New draft comment" }).fill("Keep this fictional name.");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  const header = dialog.locator(".diffHeader");
  const bar = dialog.getByLabel("Review and merge");

  await expect(header).toContainText("fictional-tools/garden · PR 1");
  await expect(header).toContainText("abc123def456");
  await expect(header).toContainText("30 files · +1 −1");
  await expect(dialog.getByRole("button", { name: "Grouped" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Files", exact: true })).toBeVisible();
  await expect(dialog.getByText("1 pending comment")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Discard all" })).toBeVisible();
  const disclosure = dialog.getByRole("button", { name: "Show full pull request title" });
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(dialog.locator(".diffTitleDisclosure > p")).toBeVisible();
  await disclosure.press("Enter");
  await expect(dialog.getByRole("button", { name: "Submit review…" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Squash and merge" })).toBeVisible();
  expect((await dialog.locator(".diffTop").boundingBox())!.height).toBeLessThanOrEqual(56);
  expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(1280);
  const barBox = (await bar.boundingBox())!;
  expect(barBox.height).toBeLessThanOrEqual(80);
  expect(Math.round(barBox.y + barBox.height)).toBe(720);
});

test("filters Ready work, discovers hidden issues, and clears a selection after focused refresh", async ({ page }) => {
  const loaded = readyFilteringOverview();
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: loaded }));
  await page.route("**/api/items/I_ready/refresh", (route) => route.fulfill({
    json: {
      status: "updated",
      item: {
        ...loaded.issues[0],
        readiness: { kind: "blocked", blockers: [{ status: "unknown", id: "I_blocker" }] },
        readyExclusion: "blocked",
      },
      fetchedAt: "2026-08-23T11:00:00.000Z",
      relationshipStatus: "fresh",
    },
  }));
  await page.goto(origin);

  const readyPreview = page.getByRole("region", { name: "Ready for agent" });
  await expect(readyPreview.getByText("Start fictional irrigation")).toBeVisible();
  await expect(readyPreview.getByText("Check fictional weather")).toBeVisible();
  await expect(readyPreview.getByText("Plant claimed bulbs")).toHaveCount(0);
  await expect(readyPreview.getByText("Repair blocked trellis")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ready for agent 2" })).toBeVisible();
  await expect(page.getByText("Dependency status unavailable")).toBeVisible();
  await expect(page.getByText("Unblocked")).toHaveCount(0);

  await page.getByRole("button", { name: "Ready for agent 2" }).click();
  const search = page.getByRole("searchbox", { name: "Filter pull requests and issues" });
  await search.fill("claimed bulbs");
  await expect(page.getByText("Plant claimed bulbs")).toBeVisible();
  await expect(page.getByText("Hidden from Ready: claimed")).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "Select Start fictional irrigation" }).click();
  await page.getByRole("button", { name: "Refresh this item" }).click();

  await expect(page.getByText("This issue left Ready for agent because it has an open blocker.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose an item" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready for agent 1" })).toBeVisible();
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
    issues: [],
    queues: [
      { name: "agent", issues: [] },
      { name: "human", issues: [] },
      { name: "triage", issues: [] },
    ],
    epics: [],
  };
}

function readyFilteringOverview() {
  const issue = (id: string, number: number, title: string, readiness: object, readyExclusion: string | null) => ({
    id,
    type: "issue",
    repositoryId: "R_1",
    number,
    title,
    excerpt: null,
    url: `https://github.test/fictional-tools/garden/issues/${number}`,
    updatedAt: "2026-08-20T10:00:00.000Z",
    queue: "agent",
    readiness,
    readyExclusion,
    epic: null,
    subIssues: null,
  });
  const ready = issue("I_ready", 30, "Start fictional irrigation", { kind: "unblocked" }, null);
  const unavailable = issue("I_unknown", 31, "Check fictional weather", { kind: "unavailable" }, null);
  const claimed = issue("I_claimed", 32, "Plant claimed bulbs", { kind: "unblocked" }, "claimed");
  const blocked = issue("I_blocked", 33, "Repair blocked trellis", { kind: "blocked", blockers: [{ status: "unknown", id: "I_blocker" }] }, "blocked");
  return {
    status: "ready",
    fetchedAt: "2026-08-23T10:00:00.000Z",
    repositories: [{ id: "R_1", nameWithOwner: "fictional-tools/garden" }],
    scope: { repositoryCount: 1, itemCount: 4, truncatedReason: null },
    pullRequests: [],
    issues: [ready, unavailable, claimed, blocked],
    queues: [
      { name: "agent", issues: [ready, unavailable] },
      { name: "human", issues: [] },
      { name: "triage", issues: [] },
    ],
    epics: [],
  };
}

function diff(headSha = "abc123def456") {
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
    headSha,
    fileCount: files.length,
    files,
    groups: [{ name: "src", fileIndexes: files.map((_, index) => index) }],
    rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-08-24T12:00:00.000Z" },
  };
}
