import Database from "better-sqlite3";

export type WorkItemDeliveryTarget = {
  nodeId: string;
  repositoryId: string | null;
  itemType: "issue" | "pull_request";
  number: number;
  action: string;
};

export type SubIssueDeliveryTarget = {
  kind: "sub_issue";
  parentNodeId: string;
  childNodeId: string;
  action: string;
};

export type DeliveryTarget = WorkItemDeliveryTarget | SubIssueDeliveryTarget;

export type DeliveryRecord = {
  deliveryId: string;
  eventName: string;
  target: DeliveryTarget | null;
};

export type PendingDelivery = DeliveryRecord & { attempts: number };

export type DeliveryStatus = "pending" | "processing" | "succeeded" | "failed" | "manual_reconciliation";

export type DeliveryStore = {
  accept(record: DeliveryRecord, receivedAt: string): boolean;
  takePending(now: string): PendingDelivery[];
  nextAvailableAt(): string | null;
  recoverProcessing(now?: string): void;
  finish(deliveryId: string, status: DeliveryStatus, detail: string | null, now: string): void;
  retry(deliveryId: string, detail: string, availableAt: string, now: string): void;
  resolveManualReconciliation(now: string): void;
  prune(before: string): void;
  close(): void;
};

export function openDeliveryStore({ path }: { path: string }): DeliveryStore {
  const database = new Database(path);
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      target_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'manual_reconciliation')),
      detail TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      available_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx
      ON webhook_deliveries(status, received_at);
  `);
  const columns = database.prepare("PRAGMA table_info(webhook_deliveries)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "available_at")) {
    database.exec("ALTER TABLE webhook_deliveries ADD COLUMN available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  }

  return {
    accept(record, receivedAt) {
      const result = database
        .prepare(
          `INSERT OR IGNORE INTO webhook_deliveries (
             delivery_id, event_name, target_json, status, received_at, updated_at, available_at
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(record.deliveryId, record.eventName, record.target ? JSON.stringify(record.target) : null, receivedAt, receivedAt, receivedAt);
      return result.changes === 1;
    },
    takePending(now) {
      return database.transaction(() => {
        const rows = database
          .prepare(
            `SELECT delivery_id AS deliveryId, event_name AS eventName, target_json AS targetJson, attempts
             FROM webhook_deliveries
             WHERE status = 'pending' AND available_at <= ?
             ORDER BY received_at
             LIMIT 25`,
          )
          .all(now) as Array<{ deliveryId: string; eventName: string; targetJson: string | null; attempts: number }>;
        const claim = database.prepare(
          `UPDATE webhook_deliveries
           SET status = 'processing', attempts = attempts + 1, updated_at = ?
           WHERE delivery_id = ? AND status = 'pending'`,
        );
        for (const row of rows) claim.run(now, row.deliveryId);
        return rows.map((row) => ({
          deliveryId: row.deliveryId,
          eventName: row.eventName,
          target: row.targetJson ? JSON.parse(row.targetJson) as DeliveryTarget : null,
          attempts: row.attempts + 1,
        }));
      })();
    },
    nextAvailableAt() {
      const row = database.prepare("SELECT MIN(available_at) AS availableAt FROM webhook_deliveries WHERE status = 'pending'").get() as { availableAt: string | null };
      return row.availableAt;
    },
    recoverProcessing(current = new Date().toISOString()) {
      const now = current;
      database.prepare("UPDATE webhook_deliveries SET status = 'pending', available_at = ?, updated_at = ? WHERE status = 'processing'").run(now, now);
    },
    finish(deliveryId, status, detail, now) {
      database
        .prepare("UPDATE webhook_deliveries SET status = ?, detail = ?, updated_at = ? WHERE delivery_id = ?")
        .run(status, detail, now, deliveryId);
    },
    retry(deliveryId, detail, availableAt, now) {
      database
        .prepare("UPDATE webhook_deliveries SET status = 'pending', detail = ?, available_at = ?, updated_at = ? WHERE delivery_id = ?")
        .run(detail, availableAt, now, deliveryId);
    },
    resolveManualReconciliation(now) {
      database
        .prepare("UPDATE webhook_deliveries SET status = 'succeeded', detail = 'resolved_by_full_sync', updated_at = ? WHERE status = 'manual_reconciliation'")
        .run(now);
    },
    prune(before) {
      database
        .prepare("DELETE FROM webhook_deliveries WHERE received_at < ? AND status IN ('succeeded', 'failed', 'manual_reconciliation')")
        .run(before);
    },
    close() {
      database.close();
    },
  };
}
