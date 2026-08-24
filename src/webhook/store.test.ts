import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDeliveryStore } from "./store.js";

describe("webhook delivery ledger", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("persists delivery identity and minimal target data across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-delivery-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cache.sqlite");
    const first = openDeliveryStore({ path });
    const record = {
      deliveryId: "delivery-1",
      eventName: "issues",
      target: { nodeId: "I_fixture", repositoryId: "R_fixture", itemType: "issue" as const, number: 7, action: "edited" },
    };

    expect(first.accept(record, "2026-08-23T20:00:00.000Z")).toBe(true);
    expect(first.accept(record, "2026-08-23T20:00:01.000Z")).toBe(false);
    const claimed = first.takePending("2026-08-23T20:00:02.000Z");
    expect(claimed).toEqual([{ ...record, attempts: 1 }]);
    first.close();

    const restarted = openDeliveryStore({ path });
    restarted.recoverProcessing("2026-08-23T20:00:30.000Z");
    expect(restarted.takePending("2026-08-23T20:01:00.000Z")).toEqual([{ ...record, attempts: 2 }]);
    restarted.finish(record.deliveryId, "manual_reconciliation", "manual", "2026-08-23T20:02:00.000Z");
    expect(restarted.takePending("2026-08-23T20:03:00.000Z")).toEqual([]);
    restarted.close();
  });
});
