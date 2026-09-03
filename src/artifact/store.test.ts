import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactQuotaExceededError, type ArtifactType, openArtifactStore } from "./store.js";

describe("artifact store", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("keeps each supported type, original bytes, and UTC timestamps across reopen", async () => {
    const path = await databasePath();
    const content = Buffer.from([0, 255, 60, 104, 116, 109, 108, 62]);
    const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
    const publishing = openArtifactStore({
      path,
      now: () => new Date("2026-08-31T10:00:00.000Z"),
      generateId: () => ids.shift()!,
    });

    const types: ArtifactType[] = ["archify", "presentation", "mockup"];
    const appearances = [undefined, "light", "dark"] as const;
    const published = types.map((type, index) =>
      publishing.publish({ type, content, appearance: appearances[index] }),
    );

    expect(published.map(({ type }) => type)).toEqual(["archify", "presentation", "mockup"]);
    expect(published[0]!.createdAt).toBe("2026-08-31T10:00:00.000Z");
    expect(published[0]!.deleteAfter).toBe("2026-09-30T10:00:00.000Z");
    publishing.close();

    const reopened = openArtifactStore({ path });
    for (const artifact of published) {
      expect(reopened.find(artifact.id)).toEqual({ ...artifact, content });
    }
    reopened.close();
  });

  it("migrates existing rows to neutral and remains writable by the earlier schema", async () => {
    const path = await databasePath();
    const original = new Database(path);
    original.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content BLOB NOT NULL,
        created_at TEXT NOT NULL,
        delete_after TEXT NOT NULL
      )
    `);
    original.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?)").run(
      "a".repeat(32),
      "archify",
      Buffer.from([0, 255, 1]),
      "2026-08-31T10:00:00.000Z",
      "2026-09-30T10:00:00.000Z",
    );
    original.close();

    const migrated = openArtifactStore({ path, generateId: () => "b".repeat(32) });
    expect(migrated.find("a".repeat(32))).toMatchObject({ appearance: null, content: Buffer.from([0, 255, 1]) });
    const hinted = migrated.publish({ type: "mockup", content: Buffer.from([2, 0, 254]), appearance: "dark" });
    migrated.close();

    const reopened = openArtifactStore({ path });
    expect(reopened.find(hinted.id)).toMatchObject({ appearance: "dark", content: Buffer.from([2, 0, 254]) });
    reopened.close();

    const earlierSchema = new Database(path);
    expect(earlierSchema.prepare(
      "SELECT id, type, content, created_at, delete_after FROM artifacts WHERE id = ?",
    ).get(hinted.id)).toMatchObject({ id: hinted.id, content: Buffer.from([2, 0, 254]) });
    expect(() => earlierSchema.prepare(
      "INSERT INTO artifacts (id, type, content, created_at, delete_after) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "c".repeat(32),
      "presentation",
      Buffer.from("earlier binary"),
      "2026-09-01T10:00:00.000Z",
      "2026-10-01T10:00:00.000Z",
    )).not.toThrow();
    earlierSchema.close();
  });

  it("retries a generated ID after a uniqueness conflict", async () => {
    const path = await databasePath();
    const ids = ["a".repeat(32), "a".repeat(32), "b".repeat(32)];
    const store = openArtifactStore({ path, generateId: () => ids.shift()! });

    expect(store.publish({ type: "archify", content: Buffer.from("first") }).id).toBe("a".repeat(32));
    expect(store.publish({ type: "archify", content: Buffer.from("second") }).id).toBe("b".repeat(32));
    store.close();
  });

  it("deletes the cutoff row but keeps later and already-expired rows until cleanup", async () => {
    const path = await databasePath();
    let now = new Date("2026-08-31T10:00:00.000Z");
    const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
    const store = openArtifactStore({ path, now: () => now, generateId: () => ids.shift()! });
    const expired = store.publish({ type: "archify", content: Buffer.from("expired") });
    now = new Date("2026-08-31T10:00:00.001Z");
    const later = store.publish({ type: "archify", content: Buffer.from("later") });
    now = new Date(expired.deleteAfter);

    expect(store.find(expired.id)?.content.toString()).toBe("expired");
    expect(store.cleanup()).toBe(1);
    expect(store.find(expired.id)).toBeNull();
    expect(store.find(later.id)?.content.toString()).toBe("later");
    store.close();
  });

  it("reclaims expired bytes before quota enforcement and leaves no row after rejection", async () => {
    const path = await databasePath();
    let now = new Date("2026-08-31T10:00:00.000Z");
    const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
    const store = openArtifactStore({ path, now: () => now, generateId: () => ids.shift()!, quotaBytes: 8 });
    const first = store.publish({ type: "archify", content: Buffer.from("12345678") });

    expect(() => store.publish({ type: "archify", content: Buffer.from("x") })).toThrow(ArtifactQuotaExceededError);
    expect(store.find("b".repeat(32))).toBeNull();

    now = new Date(first.deleteAfter);
    const replacement = store.publish({ type: "archify", content: Buffer.from("abcdefgh") });
    expect(store.find(first.id)).toBeNull();
    expect(store.find(replacement.id)?.content.toString()).toBe("abcdefgh");
    store.close();
  });

  it("serializes concurrent quota checks from independently opened stores", async () => {
    const path = await databasePath();
    const workers = ["a", "b"].map((letter) => artifactPublisherWorker({ path, letter }));
    await Promise.all(workers.map((worker) => nextWorkerMessage(worker)));
    const results = workers.map((worker) => nextWorkerMessage(worker));
    workers.forEach((worker) => worker.postMessage("start"));

    expect((await Promise.all(results)).sort()).toEqual(["published", "quota"]);

    const reopened = openArtifactStore({ path });
    expect([reopened.find("a".repeat(32)), reopened.find("b".repeat(32))].filter(Boolean)).toHaveLength(1);
    reopened.close();
  });

  async function databasePath() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-artifact-"));
    temporaryDirectories.push(directory);
    return join(directory, "repo-control.sqlite");
  }
});

function artifactPublisherWorker({ path, letter }: { path: string; letter: string }) {
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    const { ArtifactQuotaExceededError, openArtifactStore } = await import(workerData.storeUrl);
    const store = openArtifactStore({
      path: workerData.path,
      generateId: () => workerData.letter.repeat(32),
      quotaBytes: 8,
    });
    parentPort.postMessage("ready");
    parentPort.once("message", () => {
      try {
        store.publish({ type: "archify", content: Buffer.from("12345") });
        parentPort.postMessage("published");
      } catch (error) {
        if (!(error instanceof ArtifactQuotaExceededError)) throw error;
        parentPort.postMessage("quota");
      } finally {
        store.close();
        parentPort.close();
      }
    });
  `;
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { path, letter, storeUrl: new URL("./store.ts", import.meta.url).href },
  });
}

function nextWorkerMessage(worker: Worker) {
  return new Promise<string>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}
