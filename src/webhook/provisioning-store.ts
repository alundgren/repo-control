import Database from "better-sqlite3";

import type { OwnedRepository } from "../github/read-client.js";

export type TerminalProvisioningOutcome = "created" | "already_present";

export type WebhookProvisioningStore = {
  replaceInventory(accountId: string, repositories: OwnedRepository[], observedAt: string): void;
  getTerminalOutcome(accountId: string, repositoryId: string): { outcome: TerminalProvisioningOutcome; recordedAt: string } | null;
  recordTerminalOutcome(accountId: string, repositoryId: string, outcome: TerminalProvisioningOutcome, recordedAt: string): void;
  close(): void;
};

export function openWebhookProvisioningStore({ path }: { path: string }): WebhookProvisioningStore {
  const database = new Database(path);
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_repository_inventory (
      account_node_id TEXT NOT NULL,
      repository_node_id TEXT NOT NULL,
      name_with_owner TEXT NOT NULL,
      is_fork INTEGER NOT NULL CHECK (is_fork IN (0, 1)),
      is_archived INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
      observed_at TEXT NOT NULL,
      PRIMARY KEY (account_node_id, repository_node_id)
    );
    CREATE TABLE IF NOT EXISTS webhook_provisioning_ledger (
      account_node_id TEXT NOT NULL,
      repository_node_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('created', 'already_present')),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (account_node_id, repository_node_id)
    );
  `);

  return {
    replaceInventory(accountId, repositories, observedAt) {
      database.transaction(() => {
        database.prepare("DELETE FROM webhook_repository_inventory WHERE account_node_id = ?").run(accountId);
        const insert = database.prepare(
          `INSERT INTO webhook_repository_inventory (
             account_node_id, repository_node_id, name_with_owner, is_fork, is_archived, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const repository of repositories) {
          insert.run(accountId, repository.id, repository.nameWithOwner, Number(repository.isFork), Number(repository.isArchived), observedAt);
        }
      })();
    },
    getTerminalOutcome(accountId, repositoryId) {
      return database.prepare(
        `SELECT outcome, recorded_at AS recordedAt
         FROM webhook_provisioning_ledger
         WHERE account_node_id = ? AND repository_node_id = ?`,
      ).get(accountId, repositoryId) as { outcome: TerminalProvisioningOutcome; recordedAt: string } | undefined ?? null;
    },
    recordTerminalOutcome(accountId, repositoryId, outcome, recordedAt) {
      database.prepare(
        `INSERT INTO webhook_provisioning_ledger (account_node_id, repository_node_id, outcome, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_node_id, repository_node_id) DO NOTHING`,
      ).run(accountId, repositoryId, outcome, recordedAt);
    },
    close() {
      database.close();
    },
  };
}
