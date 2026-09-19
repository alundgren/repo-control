import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite-plus";

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

for (const viewport of [{ name: "laptop", width: 1280, height: 720 }, { name: "narrow", width: 390, height: 844 }]) {
  test(`applies staged repository settings at ${viewport.name} width`, async ({ page }) => {
    let revision = 4;
    let ignoredRepositoryIds = ["R_field"];
    const replacements: string[][] = [];
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.route("**/events", (route) => route.abort());
    await page.route("**/api/overview", (route) => route.fulfill({ json: settingsOverview() }));
    await page.route("**/api/settings/repository-visibility", async (route) => {
      if (route.request().method() === "PUT") {
        const payload = route.request().postDataJSON() as { ignoredRepositoryIds: string[] };
        ignoredRepositoryIds = payload.ignoredRepositoryIds;
        replacements.push([...ignoredRepositoryIds]);
        revision += 1;
        await route.fulfill({ json: { status: "updated", ...visibilitySettings(revision, new Set(ignoredRepositoryIds)) } });
        return;
      }
      await route.fulfill({ json: { status: "ready", ...visibilitySettings(revision, new Set(ignoredRepositoryIds)) } });
    });
    await page.goto(origin);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("searchbox", { name: "Search settings and repositories" }).fill("repository");
    await page.getByRole("button", { name: "Hide" }).first().click();

    expect(await page.locator(".appShell").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    await page.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeFocused();
    await page.getByRole("searchbox", { name: "Search settings and repositories" }).fill("orbit");
    await page.getByRole("button", { name: "Restore" }).click();
    await page.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByText("Repository visibility saved.")).toBeVisible();
    expect(replacements).toEqual([["R_field", "R_orbit"], ["R_field"]]);
  });
}

for (const width of [1280, 390]) {
  test(`keeps the queue and selected text readable at ${width}px`, async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-08-24T12:00:00Z"));
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/events", (route) => route.abort());
    await page.route("**/api/overview", (route) => route.fulfill({ json: readyFilteringOverview() }));
    await page.route("**/api/items/*/body", (route) => route.fulfill({ json: { status: "read", body: null } }));
    await page.goto(origin);
    await page.getByRole("button", { name: "Ready for agent 2" }).click();
    const syncTotals = page.getByText(/4 loaded items from 1 repositories/);
    await expect(syncTotals).toBeHidden();
    await page.getByText("Synced 1 day ago", { exact: true }).click();
    await expect(syncTotals).toBeVisible();
    await page.getByText("Synced 1 day ago", { exact: true }).click();
    await page.getByRole("button", { name: "Select Start fictional irrigation" }).click();
    const dialog = page.getByRole("dialog", { name: "Start fictional irrigation" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("No description provided.");
    expect(await page.locator(".appShell").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Select Start fictional irrigation" })).toBeFocused();
    await expect(page.getByRole("searchbox")).toBeVisible();
  });
}

for (const width of [1280, 390]) {
  test(`reads a long formatted issue body without page overflow at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/events", (route) => route.abort());
    await page.route("**/api/overview", (route) => route.fulfill({ json: readyFilteringOverview() }));
    const body = "## Expected behavior\n\nKeep **workspace preferences** after an upgrade.\n\n| Setting | After upgrade |\n| --- | --- |\n| Hidden repositories | Remain hidden |\n\n- [x] Preserve preferences\n- [ ] Verify recovery\n\n> Keep the previous settings when an upgrade fails.\n\n```text\n" + "long-path/".repeat(40) + "\n```\n\n" + "More issue context. ".repeat(200) + "\n\nEnd of full body.";
    await page.route("**/api/items/*/body", (route) => route.fulfill({ json: { status: "read", body } }));
    await page.goto(origin);
    await page.getByRole("button", { name: "Select Start fictional irrigation" }).click();
    const dialog = page.getByRole("dialog", { name: "Start fictional irrigation" });
    await expect(dialog.getByRole("heading", { name: "Expected behavior" })).toBeVisible();
    await expect(dialog.getByRole("table")).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThan(width);
    expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil(box.width));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const scroll = dialog.locator(".issueScroll");
    expect(await scroll.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe("thin");
    expect(await scroll.evaluate((element) => getComputedStyle(element).scrollbarColor)).toContain("193, 175, 154");
    await scroll.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await scroll.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: `/tmp/issue-reading-window-${width}-${testInfo.project.name}.png` });
    await dialog.getByText("End of full body.").scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Close issue" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Select Start fictional irrigation" })).toBeFocused();
  });
}

test("restores queue view, selection, filter, and browser scroll after closing changed files", async ({ page }) => {
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview() }));
  await page.route("**/api/items/PR_10/diff", (route) => route.fulfill({ json: diff() }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  const search = page.getByRole("searchbox", { name: "Filter pull requests and issues" });
  await search.fill("Fictional");
  await page.getByRole("button", { name: "Select Fictional pull request 10", exact: true }).scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(500);
  await page.getByRole("button", { name: "Select Fictional pull request 10", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Fictional pull request 10" });
  const firstFile = dialog.getByRole("button", { name: /src\/example-1.ts/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Review aspect" })).toHaveValue("priority");
  await expect(dialog.getByRole("button", { name: "Review all files" })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("grouped");
  await expect(firstFile).toHaveAttribute("aria-expanded", "true");
  await firstFile.click();
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("files");
  await expect(firstFile).toHaveAttribute("aria-expanded", "true");
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("grouped");
  await expect(firstFile).toHaveAttribute("aria-expanded", "false");

  await dialog.evaluate((element) => { element.scrollTop = 300; });
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("files");
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(0);
  await dialog.evaluate((element) => { element.scrollTop = 500; });
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("grouped");
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(300);
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("files");
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(500);
  await page.getByRole("button", { name: "Close changed files" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
  await expect(search).toHaveValue("Fictional");
  await expect(page.getByRole("button", { name: "Select Fictional pull request 10", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Select Fictional pull request 10", exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});

test("keeps a linked file below the sticky review controls at a narrow width", async ({ page }) => {
  const title = "A fictional pull request with a long title that wraps across several lines on a narrow screen";
  const headSha = "abc123def4567890abc123def4567890abc123de";
  await page.setViewportSize({ width: 375, height: 700 });
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview(title) }));
  await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: diff(headSha) }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  await page.getByRole("button", { name: `Select ${title}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog.getByRole("button", { name: /Draft comment|Submit review|Discard all/ })).toHaveCount(0);
  const headerParts = [".diffIdentity", ".diffTitleDisclosure > button", ".diffClose", ".diffViewControls"];
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
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("files");
  await dialog.getByRole("button", { name: "Navigator", exact: true }).click();
  await dialog.getByRole("link", { name: "src/example-30.ts", exact: true }).click();
  let stickyBottom = await dialog.locator(".diffTop").evaluate((element) => element.getBoundingClientRect().bottom);
  let fileTop = await dialog.getByRole("button", { name: /src\/example-30.ts/ }).evaluate((element) => element.getBoundingClientRect().top);
  expect(fileTop).toBeGreaterThanOrEqual(stickyBottom);
  await dialog.getByRole("combobox", { name: "Review aspect" }).selectOption("grouped");
  await dialog.getByRole("link", { name: "src/example-30.ts", exact: true }).click();

  stickyBottom = await dialog.locator(".diffTop").evaluate((element) => element.getBoundingClientRect().bottom);
  fileTop = await dialog.getByRole("button", { name: /src\/example-30.ts/ }).evaluate((element) => element.getBoundingClientRect().top);
  expect(fileTop).toBeGreaterThanOrEqual(stickyBottom);
  expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(375);
});

test("keeps the header compact with an isolated merge button and no bottom bar", async ({ page }) => {
  const title = "A fictional pull request title long enough to prove the compact laptop header truncates without hiding its controls";
  await page.route("**/events", (route) => route.abort());
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview(title) }));
  await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: { ...diff(), reviewEnabled: true, mergeEnabled: true } }));
  await page.route("**/api/items/PR_1/merge", (route) => route.fulfill({ json: { status: "ready", headSha: "abc123def456", sourceBranch: "fictional-branch" } }));
  await page.goto(origin);

  await page.getByRole("button", { name: "Pull requests 40" }).click();
  await page.getByRole("button", { name: `Select ${title}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title });
  const header = dialog.locator(".diffHeader");
  await expect(header).toContainText("fictional-tools/garden · PR 1");
  await expect(header).not.toContainText("abc123def456");
  await expect(dialog.getByRole("combobox", { name: "Review aspect" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Draft comment|Submit review/ })).toHaveCount(0);
  await expect(dialog.locator(".reviewDock")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Review all files" }).click();
  await expect(dialog.locator(".diffFileToggle[aria-expanded=true]")).toHaveCount(30);
  const disclosure = dialog.getByRole("button", { name: "Show full pull request title" });
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(dialog.locator(".diffTitleDisclosure > p")).toBeVisible();
  await disclosure.press("Enter");
  await expect(dialog.getByRole("button", { name: "Unlock merge" })).toHaveText("Merge");
  expect((await dialog.locator(".diffTop").boundingBox())!.height).toBeLessThanOrEqual(56);
  expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(1280);
  const mergeBox = (await dialog.getByRole("button", { name: "Unlock merge" }).boundingBox())!;
  const closeBox = (await dialog.getByRole("button", { name: "Close changed files" }).boundingBox())!;
  expect(mergeBox.y).toBeLessThan(56);
  expect(closeBox.x - mergeBox.x - mergeBox.width).toBeGreaterThanOrEqual(24);
  await dialog.getByRole("button", { name: "Unlock merge" }).click();
  await expect(dialog.getByText("Press Merge again within 3 seconds.", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "Unlock merge" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole("combobox", { name: "Review aspect" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Unlock merge" })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);

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
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

function settingsOverview() {
  return {
    status: "ready",
    fetchedAt: "2026-08-23T10:00:00.000Z",
    repositories: [
      { id: "R_orbit", nameWithOwner: "fictional-labs/orbit-tools" },
      { id: "R_trail", nameWithOwner: "fictional-labs/trail-notes" },
    ],
    scope: { repositoryCount: 2, itemCount: 9, visibleRepositoryCount: 2, visibleItemCount: 9, ignoredRepositoryCount: 1, truncatedReason: null },
    pullRequests: [], issues: [], epics: [],
    queues: [{ name: "agent", issues: [] }, { name: "human", issues: [] }, { name: "triage", issues: [] }],
  };
}

function visibilitySettings(revision = 4, ignored = new Set(["R_field"])) {
  return {
    revision,
    repositories: [
      { id: "R_orbit", nameWithOwner: "fictional-labs/orbit-tools", ignored: ignored.has("R_orbit"), inActiveSnapshot: true, activeItemCount: 6, counts: { now: 6, pullRequests: 1, agent: 3, human: 1, triage: 1, epics: 0 } },
      { id: "R_trail", nameWithOwner: "fictional-labs/trail-notes", ignored: ignored.has("R_trail"), inActiveSnapshot: true, activeItemCount: 3, counts: { now: 3, pullRequests: 1, agent: 0, human: 1, triage: 0, epics: 1 } },
      { id: "R_field", nameWithOwner: "fictional-labs/field-journal", ignored: ignored.has("R_field"), inActiveSnapshot: false, activeItemCount: 0, counts: { now: 0, pullRequests: 0, agent: 0, human: 0, triage: 0, epics: 0 } },
    ],
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

for (const width of [1280, 390]) {
  test(`reads the PR Description inside the slim review at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/events", (route) => route.abort());
    await page.route("**/api/overview", (route) => route.fulfill({ json: overview() }));
    await page.route("**/api/items/PR_1/diff", (route) => route.fulfill({ json: { ...diff(), mergeEnabled: true } }));
    await page.route("**/api/items/PR_1/merge", (route) => route.fulfill({ json: { status: "blocked", reason: "conflicts" } }));
    const body = "## Summary\n\nKeep **fictional preferences**.\n\n- [x] Saved\n\n| Setting | Value |\n| --- | --- |\n| Mode | Kept |\n\n```text\n" + "long-path/".repeat(40) + "\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n" + "More PR context. ".repeat(400) + "\n\nEnd of PR body.";
    await page.route("**/api/items/PR_1/body", (route) => route.fulfill({ json: { status: "read", body } }));
    await page.goto(origin);
    const opener = page.getByRole("button", { name: "Select Fictional pull request 1", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog");
    const aspect = dialog.getByRole("combobox", { name: "Review aspect" });
    await expect(aspect).toHaveValue("priority");
    await aspect.selectOption("description");
    const description = dialog.getByRole("article", { name: "Pull request description" });
    await expect(description.getByRole("heading", { name: "Fictional pull request 1" })).toBeVisible();
    await expect(description.getByRole("heading", { name: "Summary" })).toBeVisible();
    await expect(description.getByRole("table")).toBeVisible();
    await expect(description.getByRole("checkbox")).toBeDisabled();
    await expect(description.getByText("This pull request has merge conflicts.", { exact: false })).toBeVisible();
    await expect(description.getByRole("link", { name: "GitHub ↗", exact: true })).toHaveAttribute("href", "https://github.test/fictional-tools/garden/pull/1");
    await expect(description.locator("script")).toHaveCount(0);
    expect(await description.getByText("unsafe", { exact: true }).getAttribute("href")).toBeFalsy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe("thin");
    await page.screenshot({ path: `/tmp/pr-description-${width}-${testInfo.project.name}.png` });
    await dialog.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await dialog.evaluate((element) => { element.scrollTop = 400; });
    await aspect.selectOption("priority");
    await aspect.selectOption("description");
    await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(400);
    await description.getByText("End of PR body.").scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Close changed files" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(page.getByRole("combobox", { name: "Review aspect" })).toHaveValue("priority");
  });
}
