import { describe, expect, it } from "vitest";

import { DraftCommentStore, maxDraftBodyBytes, maxDraftComments, maxSavedDraftBytes, type DraftComment } from "./draft-comments.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const draft = (overrides: Partial<DraftComment> = {}): DraftComment => ({
  id: "draft-1",
  path: "src/example.ts",
  line: 12,
  side: "RIGHT",
  body: "Please rename this fictional value.",
  ...overrides,
});

describe("DraftCommentStore", () => {
  it("restores drafts by pull request and head commit", () => {
    const storage = new MemoryStorage();
    const first = new DraftCommentStore(storage);
    expect(first.save("PR_1", "head-one", draft())).toEqual({ status: "saved" });

    const restored = new DraftCommentStore(storage);
    expect(restored.collectionsFor("PR_1")).toEqual([{
      pullRequestId: "PR_1",
      headSha: "head-one",
      drafts: [draft()],
    }]);
  });

  it("rejects an oversized UTF-8 body without changing an existing draft", () => {
    const store = new DraftCommentStore(new MemoryStorage());
    expect(store.save("PR_1", "head-one", draft())).toEqual({ status: "saved" });
    const oversized = "å".repeat(maxDraftBodyBytes / 2 + 1);

    expect(store.save("PR_1", "head-one", draft({ body: oversized }))).toEqual({ status: "rejected", reason: "body_limit" });
    expect(store.collectionsFor("PR_1")[0]?.drafts).toEqual([draft()]);
  });

  it("rejects comment 101 without losing the first 100", () => {
    const store = new DraftCommentStore(new MemoryStorage());
    for (let index = 0; index < maxDraftComments; index += 1) {
      expect(store.save("PR_1", "head-one", draft({ id: `draft-${index}` }))).toEqual({ status: "saved" });
    }

    expect(store.save("PR_1", "head-one", draft({ id: "draft-101" }))).toEqual({ status: "rejected", reason: "comment_limit" });
    expect(store.collectionsFor("PR_1")[0]?.drafts).toHaveLength(maxDraftComments);
  });

  it("rejects an aggregate overflow without losing saved collections", () => {
    const store = new DraftCommentStore(new MemoryStorage());
    const body = "x".repeat(maxDraftBodyBytes);
    let saved = 0;
    for (let index = 0; index < 100; index += 1) {
      const result = store.save(`PR_${index}`, "head-one", draft({ id: `draft-${index}`, body }));
      if (result.status === "rejected") {
        expect(result.reason).toBe("tab_limit");
        break;
      }
      saved += 1;
    }

    expect(saved).toBeGreaterThan(0);
    expect(store.collectionsFor(`PR_${saved - 1}`)).toHaveLength(1);
    expect(store.collectionsFor(`PR_${saved}`)).toHaveLength(0);
    const serializedBytes = [...store.collections.values()].reduce((total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0);
    expect(serializedBytes).toBeLessThanOrEqual(maxSavedDraftBytes);
  });

  it("keeps drafts in memory when storage writes fail", () => {
    const storage = new MemoryStorage();
    storage.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
    const store = new DraftCommentStore(storage);

    expect(store.save("PR_1", "head-one", draft())).toEqual({ status: "saved" });
    expect(store.recoveryAvailable).toBe(false);
    expect(store.collectionsFor("PR_1")[0]?.drafts).toEqual([draft()]);
  });

  it("removes an older persisted copy after a later storage write fails", () => {
    const storage = new MemoryStorage();
    const store = new DraftCommentStore(storage);
    store.save("PR_1", "head-one", draft({ body: "Persisted body." }));
    storage.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
    store.save("PR_1", "head-one", draft({ body: "Submitted in-memory body." }));

    expect(store.discardCollection("PR_1", "head-one")).toEqual({ persistenceCleared: true });
    expect(new DraftCommentStore(storage).collectionsFor("PR_1")).toEqual([]);
  });

  it("reports when a persisted draft cannot be removed", () => {
    const storage = new MemoryStorage();
    const store = new DraftCommentStore(storage);
    store.save("PR_1", "head-one", draft());
    storage.removeItem = () => { throw new DOMException("Blocked", "SecurityError"); };

    expect(store.discardCollection("PR_1", "head-one")).toEqual({ persistenceCleared: false });
    expect(store.collectionsFor("PR_1")).toEqual([]);
  });

  it("keeps drafts in memory when storage is unavailable", () => {
    const store = new DraftCommentStore(null);

    expect(store.save("PR_1", "head-one", draft())).toEqual({ status: "saved" });
    expect(store.recoveryAvailable).toBe(false);
    expect(store.collectionsFor("PR_1")[0]?.drafts).toEqual([draft()]);
  });

  it("falls back to empty memory when reading storage fails", () => {
    const storage = new MemoryStorage();
    Object.defineProperty(storage, "length", { get: () => { throw new DOMException("Blocked", "SecurityError"); } });

    const store = new DraftCommentStore(storage);

    expect(store.recoveryAvailable).toBe(false);
    expect(store.save("PR_1", "head-one", draft())).toEqual({ status: "saved" });
    expect(store.collectionsFor("PR_1")[0]?.drafts).toEqual([draft()]);
  });

  it("does not claim persistent cleanup after storage access was lost", () => {
    const storage = new MemoryStorage();
    new DraftCommentStore(storage).save("PR_1", "head-one", draft({ body: "Older saved copy." }));
    Object.defineProperty(storage, "length", {
      configurable: true,
      get: () => { throw new DOMException("Blocked", "SecurityError"); },
    });
    const store = new DraftCommentStore(storage);
    expect(store.save("PR_1", "head-one", draft({ body: "Submitted in-memory copy." }))).toEqual({ status: "saved" });

    expect(store.discardCollection("PR_1", "head-one")).toEqual({ persistenceCleared: false });

    delete (storage as unknown as { length?: number }).length;
    expect(new DraftCommentStore(storage).collectionsFor("PR_1")[0]?.drafts[0]?.body).toBe("Older saved copy.");
  });

  it("keeps individual and bulk discards in memory when storage removal fails", () => {
    const storage = new MemoryStorage();
    const store = new DraftCommentStore(storage);
    store.save("PR_1", "head-one", draft());
    store.save("PR_1", "head-two", draft({ id: "draft-2" }));
    storage.removeItem = () => { throw new DOMException("Blocked", "SecurityError"); };

    store.delete("PR_1", "head-one", "draft-1");
    expect(store.collectionsFor("PR_1").map((collection) => collection.headSha)).toEqual(["head-two"]);
    expect(store.recoveryAvailable).toBe(false);

    store.discardPullRequest("PR_1");
    expect(store.collectionsFor("PR_1")).toEqual([]);
  });
});
