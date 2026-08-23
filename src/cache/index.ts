import Database from "better-sqlite3";

import type { QueueMapping } from "../domain/workflow.js";

export type { QueueMapping } from "../domain/workflow.js";

const RETAINED_GENERATIONS = 3;
const STALE_FACT_RETENTION_DAYS = 30;
const relationshipTypes: RelationshipType[] = ["blocker", "parent", "closing_issue"];

export type CacheOptions = {
  path: string;
};

export type SuccessfulSnapshot = {
  account: CacheAccount;
  fetchedAt: string;
  repositories: CacheRepository[];
  items: CacheItem[];
  scope: SampledScope;
};

export type CacheAccount = {
  id: string;
  login: string;
};

export type CacheRepository = {
  id: string;
  nameWithOwner: string;
};

type BaseCacheItem = {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  updatedAt: string;
  labels: CacheLabel[];
  relationships: CacheRelationship[];
  relationshipCoverage: RelationshipCoverageByType;
};

export type CacheItem =
  | (BaseCacheItem & { type: "issue"; pullRequest?: never })
  | (BaseCacheItem & { type: "pull_request"; pullRequest: PullRequestFacts });

export type CacheLabel = {
  id: string;
  name: string;
};

export type CacheRelationship = {
  sourceId: string;
  targetId: string;
  type: RelationshipType;
};

export type RelationshipCoverage = "complete" | "unavailable" | "not_sampled";

export type RelationshipType = "blocker" | "parent" | "closing_issue";

export type RelationshipCoverageByType = Record<RelationshipType, RelationshipCoverage>;

export type PullRequestFacts = {
  additions: number | null;
  deletions: number | null;
  isDraft: boolean;
};

export type SampledScope = {
  repositoryLimit: number;
  repositoryCount: number;
  itemLimit: number;
  itemCount: number;
  truncatedReason: string | null;
};

export type ActiveSnapshot = SuccessfulSnapshot & {
  generationId: number;
};

export type CacheStatus = {
  schemaVersion: number;
  activeGenerationId: number | null;
  retainedGenerationCount: number;
  storedItemCount: number;
  storedAccountCount: number;
};

export type Cache = {
  replaceActiveSnapshot(snapshot: SuccessfulSnapshot): number;
  getActiveSnapshot(): ActiveSnapshot | null;
  replaceQueueMapping(mapping: QueueMapping): void;
  getQueueMapping(): QueueMapping;
  getStatus(): CacheStatus;
  close(): void;
};

export function openCache({ path }: CacheOptions): Cache {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  migrate(database);

  return new SqliteCache(database);
}

class SqliteCache implements Cache {
  constructor(private readonly database: Database.Database) {}

  replaceActiveSnapshot(snapshot: SuccessfulSnapshot): number {
    return this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO accounts (node_id, login, observed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET login = excluded.login, observed_at = excluded.observed_at`,
        )
        .run(snapshot.account.id, snapshot.account.login, snapshot.fetchedAt);

      const generation = this.database
        .prepare(
          `INSERT INTO snapshot_generations (
             account_node_id, fetched_at, repository_limit, repository_count,
             item_limit, item_count, truncated_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.account.id,
          snapshot.fetchedAt,
          snapshot.scope.repositoryLimit,
          snapshot.scope.repositoryCount,
          snapshot.scope.itemLimit,
          snapshot.scope.itemCount,
          snapshot.scope.truncatedReason,
        );
      const generationId = Number(generation.lastInsertRowid);

      for (const repository of snapshot.repositories) {
        this.database
          .prepare(
            `INSERT INTO repositories (node_id, account_node_id, name_with_owner, observed_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(node_id) DO UPDATE SET
               account_node_id = excluded.account_node_id,
               name_with_owner = excluded.name_with_owner,
               observed_at = excluded.observed_at`,
          )
          .run(
            repository.id,
            snapshot.account.id,
            repository.nameWithOwner,
            snapshot.fetchedAt,
          );
        this.database
          .prepare(
            "INSERT INTO snapshot_repositories (generation_id, repository_node_id) VALUES (?, ?)",
          )
          .run(generationId, repository.id);
      }

      for (const item of snapshot.items) {
        this.writeItem(item, snapshot.fetchedAt);
        this.database
          .prepare("INSERT INTO snapshot_items (generation_id, item_node_id) VALUES (?, ?)")
          .run(generationId, item.id);
      }

      this.database
        .prepare(
          `INSERT INTO cache_state (singleton, active_generation_id)
           VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET active_generation_id = excluded.active_generation_id`,
        )
        .run(generationId);

      this.prune(snapshot.fetchedAt);
      return generationId;
    })();
  }

  getActiveSnapshot(): ActiveSnapshot | null {
    return this.database.transaction(() => this.readActiveSnapshot())();
  }

  replaceQueueMapping(mapping: QueueMapping) {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO instance_configuration (singleton, default_queue)
           VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET default_queue = excluded.default_queue`,
        )
        .run(mapping.defaultQueue);
      this.database.prepare("DELETE FROM queue_label_mappings").run();
      const insert = this.database.prepare(
        "INSERT INTO queue_label_mappings (label_name, queue) VALUES (?, ?)",
      );
      for (const mappingEntry of mapping.labels) {
        insert.run(mappingEntry.label, mappingEntry.queue);
      }
    })();
  }

  getQueueMapping(): QueueMapping {
    const configuration = this.database
      .prepare("SELECT default_queue FROM instance_configuration WHERE singleton = 1")
      .get() as { default_queue: string } | undefined;
    const labels = this.database
      .prepare("SELECT label_name AS label, queue FROM queue_label_mappings ORDER BY label_name")
      .all() as Array<{ label: string; queue: string }>;

    return { defaultQueue: configuration?.default_queue ?? "triage", labels };
  }

  getStatus(): CacheStatus {
    const active = this.database
      .prepare("SELECT active_generation_id FROM cache_state WHERE singleton = 1")
      .get() as { active_generation_id: number | null } | undefined;
    const migrations = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM cache_migrations")
      .get() as { version: number };
    const generations = this.database
      .prepare("SELECT COUNT(*) AS count FROM snapshot_generations")
      .get() as { count: number };
    const items = this.database
      .prepare("SELECT COUNT(*) AS count FROM items")
      .get() as { count: number };
    const accounts = this.database
      .prepare("SELECT COUNT(*) AS count FROM accounts")
      .get() as { count: number };

    return {
      activeGenerationId: active?.active_generation_id ?? null,
      retainedGenerationCount: generations.count,
      schemaVersion: migrations.version,
      storedAccountCount: accounts.count,
      storedItemCount: items.count,
    };
  }

  close() {
    this.database.close();
  }

  private writeItem(item: CacheItem, observedAt: string) {
    const hasPullRequestFacts = "pullRequest" in item && item.pullRequest !== undefined;
    if (item.type === "pull_request" && !hasPullRequestFacts) {
      throw new Error("Pull requests require pull-request facts");
    }
    if (item.type === "issue" && hasPullRequestFacts) {
      throw new Error("Issues cannot have pull-request facts");
    }

    this.database
      .prepare(
        `INSERT INTO items (
           node_id, repository_node_id, type, number, title, body, url, github_updated_at, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           repository_node_id = excluded.repository_node_id,
           type = excluded.type,
           number = excluded.number,
           title = excluded.title,
           body = excluded.body,
           url = excluded.url,
           github_updated_at = excluded.github_updated_at,
           observed_at = excluded.observed_at`,
    )
      .run(
        item.id,
        item.repositoryId,
        item.type,
        item.number,
        item.title,
        item.body,
        item.url,
        item.updatedAt,
        observedAt,
      );
    this.database.prepare("DELETE FROM item_labels WHERE item_node_id = ?").run(item.id);

    const insertLabel = this.database.prepare(
      `INSERT INTO labels (node_id, name, observed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET name = excluded.name, observed_at = excluded.observed_at`,
    );
    const assignLabel = this.database.prepare(
      "INSERT INTO item_labels (item_node_id, label_node_id) VALUES (?, ?)",
    );
    for (const label of item.labels) {
      insertLabel.run(label.id, label.name, observedAt);
      assignLabel.run(item.id, label.id);
    }

    const replaceRelationships = this.database.prepare(
      `DELETE FROM relationships
       WHERE source_node_id = ? AND relationship_type = ?`,
    );
    const insertRelationship = this.database.prepare(
      `INSERT INTO relationships (source_node_id, target_node_id, relationship_type, observed_at)
       VALUES (?, ?, ?, ?)`,
    );
    const insertCoverage = this.database.prepare(
      `INSERT INTO relationship_coverage (
         subject_node_id, relationship_type, coverage, observed_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(subject_node_id, relationship_type) DO UPDATE SET
         coverage = excluded.coverage,
         observed_at = excluded.observed_at`,
    );
    for (const type of relationshipTypes) {
      const coverage = item.relationshipCoverage[type];
      if (coverage === "complete") {
        replaceRelationships.run(item.id, type);
      }
      insertCoverage.run(item.id, type, coverage, observedAt);
    }
    for (const relationship of item.relationships) {
      if (relationship.sourceId !== item.id) {
        throw new Error("Relationship source must match its sampled item");
      }
      if (item.relationshipCoverage[relationship.type] !== "complete") {
        throw new Error("Only complete relationship sets can contain relationship facts");
      }
      insertRelationship.run(
        relationship.sourceId,
        relationship.targetId,
        relationship.type,
        observedAt,
      );
    }
    if (item.type === "pull_request") {
      this.database
        .prepare(
          `INSERT INTO pull_request_facts (item_node_id, is_draft, additions, deletions)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(item_node_id) DO UPDATE SET
             is_draft = excluded.is_draft,
             additions = excluded.additions,
             deletions = excluded.deletions`,
        )
        .run(
          item.id,
          Number(item.pullRequest.isDraft),
          item.pullRequest.additions,
          item.pullRequest.deletions,
        );
    } else {
      this.database.prepare("DELETE FROM pull_request_facts WHERE item_node_id = ?").run(item.id);
    }
  }

  private readActiveSnapshot(): ActiveSnapshot | null {
    const generation = this.database
      .prepare(
        `SELECT generations.id, generations.fetched_at, generations.repository_limit,
                generations.repository_count, generations.item_limit, generations.item_count,
                generations.truncated_reason, accounts.node_id AS account_id, accounts.login
         FROM cache_state
         JOIN snapshot_generations AS generations
           ON generations.id = cache_state.active_generation_id
         JOIN accounts ON accounts.node_id = generations.account_node_id
         WHERE cache_state.singleton = 1`,
      )
      .get() as GenerationRow | undefined;

    if (!generation) {
      return null;
    }

    const repositories = this.database
      .prepare(
        `SELECT repositories.node_id AS id, repositories.name_with_owner AS nameWithOwner
         FROM snapshot_repositories
         JOIN repositories ON repositories.node_id = snapshot_repositories.repository_node_id
         WHERE snapshot_repositories.generation_id = ?
         ORDER BY repositories.name_with_owner`,
      )
      .all(generation.id) as CacheRepository[];
    const rows = this.database
      .prepare(
        `SELECT items.node_id AS id, items.repository_node_id AS repositoryId, items.type,
                items.number, items.title, items.body, items.url,
                items.github_updated_at AS updatedAt, pull_request_facts.is_draft AS isDraft,
                pull_request_facts.additions, pull_request_facts.deletions
         FROM snapshot_items
         JOIN items ON items.node_id = snapshot_items.item_node_id
         LEFT JOIN pull_request_facts ON pull_request_facts.item_node_id = items.node_id
         WHERE snapshot_items.generation_id = ?
         ORDER BY items.repository_node_id, items.type, items.number`,
      )
      .all(generation.id) as ItemRow[];

    return {
      account: { id: generation.account_id, login: generation.login },
      fetchedAt: generation.fetched_at,
      generationId: generation.id,
      items: rows.map((row) => this.readItem(row)),
      repositories,
      scope: {
        itemCount: generation.item_count,
        itemLimit: generation.item_limit,
        repositoryCount: generation.repository_count,
        repositoryLimit: generation.repository_limit,
        truncatedReason: generation.truncated_reason,
      },
    };
  }

  private readItem(row: ItemRow): CacheItem {
    const labels = this.database
      .prepare(
        `SELECT labels.node_id AS id, labels.name
         FROM item_labels
         JOIN labels ON labels.node_id = item_labels.label_node_id
         WHERE item_labels.item_node_id = ?
         ORDER BY labels.name`,
      )
      .all(row.id) as CacheLabel[];
    const relationships = this.database
      .prepare(
        `SELECT source_node_id AS sourceId, target_node_id AS targetId, relationship_type AS type
         FROM relationships
         WHERE source_node_id = ?
         ORDER BY relationship_type, target_node_id`,
      )
      .all(row.id) as CacheRelationship[];
    const coverageRows = this.database
      .prepare(
        `SELECT relationship_type, coverage FROM relationship_coverage
         WHERE subject_node_id = ?`,
      )
      .all(row.id) as Array<{
      relationship_type: RelationshipType;
      coverage: RelationshipCoverage;
    }>;
    const relationshipCoverage = Object.fromEntries(
      relationshipTypes.map((type) => [
        type,
        coverageRows.find((row) => row.relationship_type === type)?.coverage ?? "not_sampled",
      ]),
    ) as RelationshipCoverageByType;

    const item = {
      body: row.body,
      id: row.id,
      labels,
      number: row.number,
      relationshipCoverage,
      relationships,
      repositoryId: row.repositoryId,
      title: row.title,
      updatedAt: row.updatedAt,
      url: row.url,
    };
    if (row.type === "issue") {
      return { ...item, type: "issue" };
    }
    if (row.isDraft === null) {
      throw new Error("Cached pull request is missing pull-request facts");
    }

    return {
      ...item,
      pullRequest: {
        additions: row.additions,
        deletions: row.deletions,
        isDraft: Boolean(row.isDraft),
      },
      type: "pull_request",
    };
  }

  private prune(fetchedAt: string) {
    this.database
      .prepare(
        `DELETE FROM snapshot_generations
         WHERE id NOT IN (
           SELECT id FROM snapshot_generations ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(RETAINED_GENERATIONS);

    const staleBefore = new Date(
      new Date(fetchedAt).getTime() - STALE_FACT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    this.database
      .prepare(
        `DELETE FROM relationships
         WHERE observed_at < ?
           AND source_node_id NOT IN (SELECT item_node_id FROM snapshot_items)`,
      )
      .run(staleBefore);
    this.database
      .prepare(
        `DELETE FROM relationship_coverage
         WHERE observed_at < ?
           AND subject_node_id NOT IN (SELECT item_node_id FROM snapshot_items)`,
      )
      .run(staleBefore);
    this.database
      .prepare(
        `DELETE FROM items
         WHERE observed_at < ?
           AND node_id NOT IN (SELECT item_node_id FROM snapshot_items)`,
      )
      .run(staleBefore);
    this.database
      .prepare(
        `DELETE FROM repositories
         WHERE observed_at < ?
           AND node_id NOT IN (SELECT repository_node_id FROM snapshot_repositories)`,
      )
      .run(staleBefore);
    this.database
      .prepare(
        `DELETE FROM accounts
         WHERE node_id NOT IN (SELECT account_node_id FROM snapshot_generations)
           AND node_id NOT IN (SELECT account_node_id FROM repositories)`,
      )
      .run();
    this.database
      .prepare(
        `DELETE FROM labels
         WHERE observed_at < ?
           AND node_id NOT IN (SELECT label_node_id FROM item_labels)`,
      )
      .run(staleBefore);
  }
}

type GenerationRow = {
  id: number;
  fetched_at: string;
  repository_limit: number;
  repository_count: number;
  item_limit: number;
  item_count: number;
  truncated_reason: string | null;
  account_id: string;
  login: string;
};

type ItemRow = {
  id: string;
  repositoryId: string;
  type: CacheItem["type"];
  number: number;
  title: string;
  body: string | null;
  url: string;
  updatedAt: string;
  isDraft: number | null;
  additions: number | null;
  deletions: number | null;
};

function migrate(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cache_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = database
    .prepare("SELECT MAX(version) AS version FROM cache_migrations")
    .get() as { version: number | null };

  if ((applied.version ?? 0) >= 1) {
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE accounts (
        node_id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE repositories (
        node_id TEXT PRIMARY KEY,
        account_node_id TEXT NOT NULL REFERENCES accounts(node_id),
        name_with_owner TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE items (
        node_id TEXT PRIMARY KEY,
        repository_node_id TEXT NOT NULL REFERENCES repositories(node_id),
        type TEXT NOT NULL CHECK (type IN ('issue', 'pull_request')),
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        url TEXT NOT NULL,
        github_updated_at TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE pull_request_facts (
        item_node_id TEXT PRIMARY KEY REFERENCES items(node_id) ON DELETE CASCADE,
        is_draft INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
        additions INTEGER,
        deletions INTEGER
      );
      CREATE TABLE labels (
        node_id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) > 0),
        observed_at TEXT NOT NULL
      );
      CREATE TABLE item_labels (
        item_node_id TEXT NOT NULL REFERENCES items(node_id) ON DELETE CASCADE,
        label_node_id TEXT NOT NULL REFERENCES labels(node_id),
        PRIMARY KEY (item_node_id, label_node_id)
      );
      CREATE TABLE relationships (
        source_node_id TEXT NOT NULL REFERENCES items(node_id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (source_node_id, target_node_id, relationship_type)
      );
      CREATE TABLE relationship_coverage (
        subject_node_id TEXT NOT NULL REFERENCES items(node_id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL,
        coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'unavailable', 'not_sampled')),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (subject_node_id, relationship_type)
      );
      CREATE TABLE snapshot_generations (
        id INTEGER PRIMARY KEY,
        account_node_id TEXT NOT NULL REFERENCES accounts(node_id),
        fetched_at TEXT NOT NULL,
        repository_limit INTEGER NOT NULL,
        repository_count INTEGER NOT NULL,
        item_limit INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        truncated_reason TEXT
      );
      CREATE TABLE snapshot_repositories (
        generation_id INTEGER NOT NULL REFERENCES snapshot_generations(id) ON DELETE CASCADE,
        repository_node_id TEXT NOT NULL REFERENCES repositories(node_id),
        PRIMARY KEY (generation_id, repository_node_id)
      );
      CREATE TABLE snapshot_items (
        generation_id INTEGER NOT NULL REFERENCES snapshot_generations(id) ON DELETE CASCADE,
        item_node_id TEXT NOT NULL REFERENCES items(node_id),
        PRIMARY KEY (generation_id, item_node_id)
      );
      CREATE TABLE cache_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_generation_id INTEGER REFERENCES snapshot_generations(id)
      );
      CREATE TABLE instance_configuration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        default_queue TEXT NOT NULL
      );
      CREATE TABLE queue_label_mappings (
        label_name TEXT PRIMARY KEY,
        queue TEXT NOT NULL
      );
    `);
    database
      .prepare("INSERT INTO cache_migrations (version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());
  })();
}
