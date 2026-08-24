import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OwnedRepositoryInventory } from "../github/read-client.js";
import { openWebhookProvisioningStore } from "./provisioning-store.js";
import { createWebhookProvisioner, readWebhookProvisioningConfiguration } from "./provisioning.js";

describe("webhook provisioning", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it("records a created hook once after committing a complete inventory", async () => {
    const store = openWebhookProvisioningStore({ path: await createStorePath() });
    const createCalls: unknown[] = [];
    const provisioner = createWebhookProvisioner({
      store,
      client: {
        async listHooks() { return { status: "complete" as const, hooks: [{ callbackUrl: "https://hooks.example.test/other" }] }; },
        async createHook(input) { createCalls.push(input); return { status: "created" as const }; },
      },
      configuration: configuration(),
      now: () => "2026-08-24T12:00:00.000Z",
    });

    try {
      await expect(provisioner.reconcile(inventory())).resolves.toEqual({ eligible: 1, created: 1, alreadyPresent: 0, failed: 0 });
      await expect(provisioner.reconcile(inventory())).resolves.toEqual({ eligible: 0, created: 0, alreadyPresent: 0, failed: 0 });
      expect(createCalls).toEqual([expect.objectContaining({ events: ["issues", "pull_request"], active: true, contentType: "json" })]);
      expect(store.getTerminalOutcome("U_fixture", "R_1")).toEqual({ outcome: "created", recordedAt: "2026-08-24T12:00:00.000Z" });
    } finally {
      store.close();
    }
  });

  it("paginates hooks and leaves an exact matching malformed hook untouched", async () => {
    const store = openWebhookProvisioningStore({ path: await createStorePath() });
    const pages: number[] = [];
    const provisioner = createWebhookProvisioner({
      store,
      client: {
        async listHooks({ page }) {
          pages.push(page);
          return page === 1
            ? { status: "complete" as const, hooks: [], hasNextPage: true }
            : { status: "complete" as const, hooks: [{ callbackUrl: configuration().callbackUrl }], hasNextPage: false };
        },
        async createHook() { throw new Error("must not create"); },
      },
      configuration: configuration(),
    });

    try {
      await expect(provisioner.reconcile(inventory())).resolves.toMatchObject({ alreadyPresent: 1 });
      expect(pages).toEqual([1, 2]);
      expect(store.getTerminalOutcome("U_fixture", "R_1")?.outcome).toBe("already_present");
    } finally {
      store.close();
    }
  });

  it("excludes forked and archived repositories", async () => {
    const store = openWebhookProvisioningStore({ path: await createStorePath() });
    const provisioner = createWebhookProvisioner({
      store,
      client: { async listHooks() { return { status: "complete" as const, hooks: [] }; }, async createHook() { return { status: "created" as const }; } },
      configuration: configuration(),
    });

    try {
      await expect(provisioner.reconcile(inventory({ repositories: [
        { id: "R_fork", nameWithOwner: "octo/fork", isFork: true, isArchived: false },
        { id: "R_archive", nameWithOwner: "octo/archive", isFork: false, isArchived: true },
      ] }))).resolves.toEqual({ eligible: 0, created: 0, alreadyPresent: 0, failed: 0 });
    } finally {
      store.close();
    }
  });

  it("does not record a terminal outcome after list or create failures, then retries", async () => {
    const store = openWebhookProvisioningStore({ path: await createStorePath() });
    let attempt = 0;
    const provisioner = createWebhookProvisioner({
      store,
      client: {
        async listHooks() { return attempt++ === 0 ? { status: "failed" as const, code: "unavailable" } : { status: "complete" as const, hooks: [] }; },
        async createHook() { return attempt++ === 2 ? { status: "failed" as const, code: "unavailable" } : { status: "created" as const }; },
      },
      configuration: configuration(),
    });

    try {
      await provisioner.reconcile(inventory());
      expect(store.getTerminalOutcome("U_fixture", "R_1")).toBeNull();
      await provisioner.reconcile(inventory());
      expect(store.getTerminalOutcome("U_fixture", "R_1")).toBeNull();
      await provisioner.reconcile(inventory());
      expect(store.getTerminalOutcome("U_fixture", "R_1")?.outcome).toBe("created");
    } finally {
      store.close();
    }
  });

  it("recovers after a remote create completes before local persistence", async () => {
    const store = openWebhookProvisioningStore({ path: await createStorePath() });
    let remoteExists = false;
    let failWrite = true;
    const backingStore = { ...store, recordTerminalOutcome(accountId: string, repositoryId: string, outcome: "created" | "already_present", recordedAt: string) {
      if (failWrite) {
        failWrite = false;
        throw new Error("local write interrupted");
      }
      store.recordTerminalOutcome(accountId, repositoryId, outcome, recordedAt);
    } };
    const provisioner = createWebhookProvisioner({
      store: backingStore,
      client: {
        async listHooks() { return { status: "complete" as const, hooks: remoteExists ? [{ callbackUrl: configuration().callbackUrl }] : [] }; },
        async createHook() { remoteExists = true; return { status: "created" as const }; },
      },
      configuration: configuration(),
    });

    try {
      await expect(provisioner.reconcile(inventory())).rejects.toThrow("local write interrupted");
      await expect(provisioner.reconcile(inventory())).resolves.toMatchObject({ alreadyPresent: 1 });
      expect(store.getTerminalOutcome("U_fixture", "R_1")?.outcome).toBe("already_present");
    } finally {
      store.close();
    }
  });

  it("keeps the terminal ledger across a restart without persisting webhook secrets or URLs", async () => {
    const path = await createStorePath();
    const firstStore = openWebhookProvisioningStore({ path });
    const firstProvisioner = createWebhookProvisioner({
      store: firstStore,
      client: { async listHooks() { return { status: "complete" as const, hooks: [] }; }, async createHook() { return { status: "created" as const }; } },
      configuration: configuration(),
    });
    await firstProvisioner.reconcile(inventory());
    firstStore.close();

    const persisted = await readFile(path);
    expect(persisted.includes(Buffer.from(configuration().secret))).toBe(false);
    expect(persisted.includes(Buffer.from(configuration().callbackUrl))).toBe(false);

    const restartedStore = openWebhookProvisioningStore({ path });
    const restartedProvisioner = createWebhookProvisioner({
      store: restartedStore,
      client: { async listHooks() { throw new Error("must not call GitHub"); }, async createHook() { throw new Error("must not create"); } },
      configuration: configuration(),
    });
    try {
      await expect(restartedProvisioner.reconcile(inventory())).resolves.toEqual({ eligible: 0, created: 0, alreadyPresent: 0, failed: 0 });
    } finally {
      restartedStore.close();
    }
  });

  it("requires a secret and an exact HTTPS receiver URL with no credentials, query, or fragment", () => {
    expect(readWebhookProvisioningConfiguration({ REPO_CONTROL_GITHUB_WEBHOOK_SECRET: "secret", REPO_CONTROL_GITHUB_WEBHOOK_CALLBACK_URL: "https://hooks.example.test/webhooks/github" })).toEqual({
      secret: "secret",
      callbackUrl: "https://hooks.example.test/webhooks/github",
    });
    for (const callbackUrl of [
      "http://hooks.example.test/webhooks/github",
      "https://user@hooks.example.test/webhooks/github",
      "https://hooks.example.test/webhooks/github?debug=true",
      "https://hooks.example.test/webhooks/github#fragment",
      "https://hooks.example.test/another-path",
    ]) {
      expect(readWebhookProvisioningConfiguration({ REPO_CONTROL_GITHUB_WEBHOOK_SECRET: "secret", REPO_CONTROL_GITHUB_WEBHOOK_CALLBACK_URL: callbackUrl })).toBeNull();
    }
  });

  async function createStorePath() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-provisioning-"));
    temporaryDirectories.push(directory);
    return join(directory, "cache.sqlite");
  }
});

function configuration() {
  return { secret: "webhook-secret-for-tests", callbackUrl: "https://hooks.example.test/webhooks/github" };
}

function inventory(overrides: Partial<OwnedRepositoryInventory> = {}): OwnedRepositoryInventory {
  return {
    account: { id: "U_fixture", login: "octo" },
    fetchedAt: "2026-08-24T11:00:00.000Z",
    repositories: [{ id: "R_1", nameWithOwner: "octo/repo", isFork: false, isArchived: false }],
    ...overrides,
  };
}
