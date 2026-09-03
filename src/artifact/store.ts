import { randomInt } from "node:crypto";

import Database from "better-sqlite3";

export const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ARTIFACT_QUOTA_BYTES = 1024 * 1024 * 1024;

export type ArtifactType = "archify" | "presentation" | "mockup";
export type ArtifactAppearance = "light" | "dark";

export type StoredArtifact = {
  id: string;
  type: string;
  content: Buffer;
  appearance: ArtifactAppearance | null;
  createdAt: string;
  deleteAfter: string;
};

export type ArtifactStore = {
  publish(input: { type: ArtifactType; content: Buffer; appearance?: ArtifactAppearance }): Omit<StoredArtifact, "content">;
  find(id: string): StoredArtifact | null;
  cleanup(): number;
  close(): void;
};

export class ArtifactQuotaExceededError extends Error {
  readonly code = "artifact_quota_exceeded";

  constructor() {
    super("Artifact storage quota exceeded.");
  }
}

type ArtifactStoreOptions = {
  path: string;
  now?: () => Date;
  generateId?: () => string;
  quotaBytes?: number;
};

export function openArtifactStore({
  path,
  now = () => new Date(),
  generateId = generateArtifactId,
  quotaBytes = ARTIFACT_QUOTA_BYTES,
}: ArtifactStoreOptions): ArtifactStore {
  const database = new Database(path);
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content BLOB NOT NULL,
      created_at TEXT NOT NULL,
      delete_after TEXT NOT NULL,
      appearance TEXT CHECK (appearance IN ('light', 'dark'))
    )
  `);
  const columns = database.pragma("table_info(artifacts)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "appearance")) {
    database.exec("ALTER TABLE artifacts ADD COLUMN appearance TEXT CHECK (appearance IN ('light', 'dark'))");
  }

  const deleteExpired = database.prepare("DELETE FROM artifacts WHERE delete_after <= ?");
  const payloadBytes = database.prepare("SELECT COALESCE(SUM(length(content)), 0) AS total FROM artifacts");
  const insert = database.prepare(
    "INSERT INTO artifacts (id, type, content, created_at, delete_after, appearance) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const publish = database.transaction((input: { type: ArtifactType; content: Buffer; appearance?: ArtifactAppearance }) => {
    const createdAt = now();
    const createdAtText = createdAt.toISOString();
    const deleteAfter = new Date(createdAt.getTime() + ARTIFACT_RETENTION_MS).toISOString();
    deleteExpired.run(createdAtText);
    const { total } = payloadBytes.get() as { total: number };
    if (total + input.content.byteLength > quotaBytes) {
      throw new ArtifactQuotaExceededError();
    }

    for (;;) {
      const id = generateId();
      try {
        const appearance = input.appearance ?? null;
        insert.run(id, input.type, input.content, createdAtText, deleteAfter, appearance);
        return { id, type: input.type, appearance, createdAt: createdAtText, deleteAfter };
      } catch (error) {
        if (!isIdentityConflict(error)) throw error;
      }
    }
  });

  return {
    publish(input) {
      return publish.immediate(input);
    },
    find(id) {
      const row = database.prepare(
        "SELECT id, type, content, appearance, created_at AS createdAt, delete_after AS deleteAfter FROM artifacts WHERE id = ?",
      ).get(id) as StoredArtifact | undefined;
      return row ?? null;
    },
    cleanup() {
      return deleteExpired.run(now().toISOString()).changes;
    },
    close() {
      database.close();
    },
  };
}

export function generateArtifactId() {
  let id = "";
  for (let index = 0; index < 32; index += 1) {
    id += String.fromCharCode(97 + randomInt(26));
  }
  return id;
}

function isIdentityConflict(error: unknown) {
  return error instanceof Error && "code" in error && (
    error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
