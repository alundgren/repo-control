import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openCache, type CacheItem } from "./index.js";

describe("active cache upserts", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("adds uncached work to the active generation and keeps counts current on removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-cache-upsert-"));
    temporaryDirectories.push(directory);
    const cache = openCache({ path: join(directory, "cache.sqlite") });
    cache.replaceActiveSnapshot({
      account: { id: "U_fixture", login: "fixture" },
      fetchedAt: "2026-08-23T20:00:00.000Z",
      repositories: [{ id: "R_one", nameWithOwner: "fixture/one" }],
      items: [item("I_one", "R_one")],
      scope: { repositoryCount: 1, itemCount: 1, truncatedReason: null },
    });

    cache.upsertItem(item("I_two", "R_two"), { id: "R_two", nameWithOwner: "fixture/two" }, "U_fixture", "2026-08-23T20:01:00.000Z");
    expect(cache.getActiveSnapshot()?.items.map((entry) => entry.id)).toEqual(["I_one", "I_two"]);
    expect(cache.getActiveSnapshot()?.scope).toMatchObject({ repositoryCount: 2, itemCount: 2 });

    cache.removeItem("I_two");
    expect(cache.getActiveSnapshot()?.scope).toMatchObject({ repositoryCount: 2, itemCount: 1 });
    cache.close();
  });
});

function item(id: string, repositoryId: string): CacheItem {
  return {
    id,
    repositoryId,
    number: id === "I_one" ? 1 : 2,
    title: id,
    body: null,
    url: `https://github.test/fixture/issues/${id}`,
    updatedAt: "2026-08-23T20:00:00.000Z",
    labels: [],
    relationships: [],
    relationshipCoverage: { blocker: "not_sampled", closing_issue: "not_sampled", parent: "not_sampled" },
    type: "issue",
  };
}
