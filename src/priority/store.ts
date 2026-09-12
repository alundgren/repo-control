import Database from "better-sqlite3";

import type { PriorityResult, PriorityStatus } from "./types.js";

export const PRIORITY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PRIORITY_RETRY_DELAY_MS = 60_000;

export type PriorityJob = {
  nodeId: string;
  status: PriorityStatus;
  attempts: number;
  enqueuedAt: string;
  availableAt: string;
  result: PriorityResult | null;
};
export type PriorityStore = ReturnType<typeof openPriorityStore>;

export function openPriorityStore({ path }: { path: string }) {
  const database = new Database(path);
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS pull_request_priorities (
      node_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired', 'ineligible', 'stale')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
      enqueued_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      observed_ready INTEGER NOT NULL DEFAULT 0,
      observed_version TEXT NOT NULL DEFAULT '',
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS pull_request_priorities_pending
      ON pull_request_priorities(status, available_at);
  `);
  function read(nodeId: string): PriorityJob | null {
    const row = database.prepare(`SELECT node_id AS nodeId, status, attempts, enqueued_at AS enqueuedAt,
      available_at AS availableAt, result_json AS resultJson FROM pull_request_priorities WHERE node_id = ?`).get(nodeId) as
      (Omit<PriorityJob, "result"> & { resultJson: string | null }) | undefined;
    if (!row) return null;
    const { resultJson, ...job } = row;
    return { ...job, result: resultJson ? JSON.parse(resultJson) as PriorityResult : null };
  }
  return {
    read,
    observe(nodeId: string, eligible: boolean, now: number, version = "") {
      const timestamp = new Date(now).toISOString();
      if (eligible) {
        database.prepare(`INSERT OR IGNORE INTO pull_request_priorities
          (node_id, status, enqueued_at, available_at) VALUES (?, 'queued', ?, ?)`).run(nodeId, timestamp, timestamp);
        database.prepare(`UPDATE pull_request_priorities SET status = 'queued'
          WHERE node_id = ? AND status = 'ineligible' AND attempts < 2 AND (observed_ready = 0 OR observed_version != ?)`).run(nodeId, version);
      } else {
        database.prepare("UPDATE pull_request_priorities SET status = 'ineligible' WHERE node_id = ? AND status = 'queued'").run(nodeId);
      }
      database.prepare("UPDATE pull_request_priorities SET observed_ready = ?, observed_version = ? WHERE node_id = ?").run(eligible ? 1 : 0, version, nodeId);
    },
    take(now: number): PriorityJob | null {
      return database.transaction(() => {
        database.prepare(`UPDATE pull_request_priorities SET status = 'expired'
          WHERE status = 'queued' AND enqueued_at < ?`).run(new Date(now - PRIORITY_MAX_AGE_MS).toISOString());
        const row = database.prepare(`SELECT node_id AS nodeId FROM pull_request_priorities
          WHERE status = 'queued' AND attempts < 2 AND available_at <= ? ORDER BY enqueued_at, node_id LIMIT 1`)
          .get(new Date(now).toISOString()) as { nodeId: string } | undefined;
        if (!row) return null;
        database.prepare("UPDATE pull_request_priorities SET status = 'running', attempts = attempts + 1 WHERE node_id = ?").run(row.nodeId);
        return read(row.nodeId);
      }).immediate();
    },
    finish(job: PriorityJob, status: Exclude<PriorityStatus, "queued" | "running">, result: PriorityResult | null = null) {
      return database.prepare(`UPDATE pull_request_priorities SET status = ?, result_json = ?
        WHERE node_id = ? AND status = 'running' AND attempts = ?`)
        .run(status, result ? JSON.stringify(result) : null, job.nodeId, job.attempts).changes === 1;
    },
    fail(job: PriorityJob, now: number, exhaustedStatus: "failed" | "stale" = "failed") {
      database.prepare(`UPDATE pull_request_priorities SET status = ?, available_at = ?
        WHERE node_id = ? AND status = 'running' AND attempts = ?`)
        .run(job.attempts < 2 ? "queued" : exhaustedStatus, new Date(now + PRIORITY_RETRY_DELAY_MS).toISOString(), job.nodeId, job.attempts);
    },
    recover() {
      // A crashed try may already have sent a request. Its reservation remains spent.
      database.prepare(`UPDATE pull_request_priorities SET status = CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END
        WHERE status = 'running'`).run();
    },
    stale(nodeId: string) {
      database.prepare("UPDATE pull_request_priorities SET status = 'stale' WHERE node_id = ? AND status = 'completed'").run(nodeId);
    },
    nextAvailableAt(): number | null {
      const row = database.prepare("SELECT MIN(available_at) AS availableAt FROM pull_request_priorities WHERE status = 'queued'").get() as { availableAt: string | null };
      return row.availableAt === null ? null : Date.parse(row.availableAt);
    },
    close() { database.close(); },
  };
}
