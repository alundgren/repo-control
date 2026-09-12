import { afterEach, describe, expect, it } from "vitest";
import { openCache, type Cache } from "../cache/index.js";
import { createExplorationRepository } from "./github.js";
import type { GitHubReadClient } from "../github/read-client.js";
const head = "a".repeat(40), base = "b".repeat(40), mergeBase = "c".repeat(40), blob = "d".repeat(40);
const caches: Cache[] = [];
afterEach(() => { for (const cache of caches.splice(0)) cache.close(); });
function cacheFixture() {
  const cache = openCache({ path: ":memory:" }); caches.push(cache);
  cache.replaceActiveSnapshot({ account: { id: "U_fixture", login: "sample" }, fetchedAt: "2026-09-01T12:00:00Z", repositories: [{ id: "R_fixture", nameWithOwner: "sample/orchard" }], items: [{ id: "PR_fixture", type: "pull_request", repositoryId: "R_fixture", number: 42, title: "Delivery date", body: null, url: "https://github.test/sample/orchard/pull/42", updatedAt: "2026-09-01T12:00:00Z", labels: [], relationships: [], relationshipCoverage: { blocker: "not_sampled", parent: "not_sampled", closing_issue: "complete" }, pullRequest: { additions: 1, deletions: 1, isDraft: false } }], scope: { itemCount: 1, repositoryCount: 1, truncatedReason: null } });
  return cache;
}
const diffClient: Pick<GitHubReadClient, "readPullRequestDiff"> = { async readPullRequestDiff() { return { status: "complete", headSha: head, fileCount: 1, groups: [], rateLimit: { cost: 1, remaining: 10, resetAt: "2026-09-01T12:00:00Z" }, files: [{ path: "delivery.ts", previousPath: "old.ts", changeType: "renamed", additions: 1, deletions: 1, patch: { status: "available", text: "@@ -1 +1 @@\n-oldDate()\n+deliveryDate()" } }] }; } };
const signal = () => new AbortController().signal;
function fetchFixture(options: { mode?: string; currentBase?: string; count?: number } = {}) {
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/pulls/42")) return Response.json({ head: { sha: head }, base: { sha: options.currentBase ?? base }, body: "Handle late orders" });
    if (url.includes("/compare/")) return Response.json({ merge_base_commit: { sha: mergeBase } });
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: Array.from({ length: options.count ?? 1 }, (_, index) => ({ path: url.includes(mergeBase) ? "old.ts" : options.count ? `file-${index}.ts` : "delivery.ts", type: "blob", mode: options.mode ?? "100644", sha: blob, size: 20 })) });
    if (url.endsWith(`/git/blobs/${blob}`)) return Response.json({ encoding: "base64", size: 20, content: Buffer.from("deliveryDate(order)\nreturn date").toString("base64") });
    throw new Error("Unexpected fictional route");
  };
  return { fetcher, urls };
}
describe("GitHub exploration adapter", () => {
  it("reads a renamed deleted-side selection at the merge base", async () => {
    const fixture = fetchFixture(); const repo = createExplorationRepository(cacheFixture(), diffClient, "fictional-token", fixture.fetcher);
    const evidence = await repo.read("PR_fixture", head, { path: "delivery.ts", side: "LEFT", startLine: 1, endLine: 1 }, signal(), base);
    expect(evidence.sources).toEqual([{ path: "delivery.ts", side: "LEFT", startLine: 1, endLine: 1, code: "deliveryDate(order)" }]);
    expect(fixture.urls.some(url => url.includes(`/git/trees/${mergeBase}`))).toBe(true);
  });
  it("rejects a changed base even when the head remains unchanged", async () => {
    const fixture = fetchFixture({ currentBase: "e".repeat(40) }); const repo = createExplorationRepository(cacheFixture(), diffClient, "fictional-token", fixture.fetcher);
    await expect(repo.verify("PR_fixture", head, signal(), base)).rejects.toMatchObject({ code: "head_changed" });
  });
  it("never dereferences symlinks or excluded paths", async () => {
    const fixture = fetchFixture({ mode: "120000" }); const repo = createExplorationRepository(cacheFixture(), diffClient, "fictional-token", fixture.fetcher);
    for (const path of ["delivery.ts", ".env", "../delivery.ts"]) {
      const result = await repo.read("PR_fixture", head, { path, side: "RIGHT", startLine: 1, endLine: 1 }, signal(), base);
      expect(result.sources).toEqual([]);
      expect(result.notices.length).toBeGreaterThan(0);
    }
    expect(fixture.urls.some(url => url.includes("/git/blobs/"))).toBe(false);
  });
  it("reports partial search coverage and supports continuation offsets", async () => {
    const fixture = fetchFixture({ count: 42 }); const repo = createExplorationRepository(cacheFixture(), diffClient, "fictional-token", fixture.fetcher);
    const result = await repo.search("PR_fixture", head, "notPresent", null, 0, signal(), base);
    expect(result.sources).toEqual([]);
    expect(result.notices[0]).toContain("40 files");
    expect(result.notices[0]).toContain("offset 40");
    const continued = await repo.search("PR_fixture", head, "deliveryDate", null, 40, signal(), base);
    expect(continued.sources.map(source => source.path)).toEqual(["file-40.ts", "file-41.ts"]);
  });
  it("refuses evidence when the repository becomes hidden", async () => {
    const cache = cacheFixture(); const fixture = fetchFixture(); const repo = createExplorationRepository(cache, diffClient, "fictional-token", fixture.fetcher);
    cache.replaceIgnoredRepositories(["R_fixture"], cache.getRepositoryVisibility().revision);
    await expect(repo.prepare("PR_fixture", head, signal())).rejects.toMatchObject({ code: "unavailable" });
    expect(fixture.urls).toEqual([]);
  });
});

it("continues at the first uninspected file after stopping inside a match-heavy file", async () => {
  const fixture = fetchFixture({ count: 42 });
  let blobs = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes("/git/blobs/")) {
      blobs++;
      const text = blobs === 1 ? "deliveryDate(order)\n".repeat(50) : "deliveryDate(nextOrder)";
      return Response.json({ encoding: "base64", size: text.length, content: Buffer.from(text).toString("base64") });
    }
    return fixture.fetcher(input, init);
  };
  const repo = createExplorationRepository(cacheFixture(), diffClient, "fictional-token", fetcher);
  const first = await repo.search("PR_fixture", head, "deliveryDate", null, 0, signal(), base);
  expect(first.sources).toHaveLength(30);
  expect(first.notices.join(" ")).toContain("offset 1");
  expect(first.notices.join(" ")).toContain("Remaining lines were not searched");
  const next = await repo.search("PR_fixture", head, "deliveryDate", null, 1, signal(), base);
  expect(next.sources[0]?.path).toBe("file-1.ts");
});
