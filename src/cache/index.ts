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
  scope: ReconciliationScope;
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
  createdAt?: string | null;
  updatedAt: string;
  observedAt?: string;
  labels: CacheLabel[];
  relationships: CacheRelationship[];
  relationshipCoverage: RelationshipCoverageByType;
  relatedItems?: RelatedItemSummary[];
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

export type RelatedItemSummary = {
  id: string;
  repositoryId: string;
  repositoryNameWithOwner: string;
  number: number;
  title: string;
  url: string;
};

export type RelationshipCoverage = "complete" | "unavailable" | "not_sampled";

export type RelationshipType = "blocker" | "parent" | "closing_issue";

export type RelationshipCoverageByType = Record<RelationshipType, RelationshipCoverage>;

export type PullRequestFacts = {
  additions: number | null;
  deletions: number | null;
  isDraft: boolean;
};

export type ReconciliationScope = {
  reconciliation?: "full" | "incremental";
  lastFullReconciliationAt?: string | null;
  inventoryComplete?: boolean;
  searchPageSize?: number;
  searchResultLimit?: number;
  repositoryCount: number;
  itemCount: number;
  /** @deprecated Reconciliation no longer stops at a repository or item budget. */
  repositoryLimit?: number;
  /** @deprecated Reconciliation no longer stops at a repository or item budget. */
  itemLimit?: number;
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
  getItem(nodeId: string): CacheItem | null;
  getRelatedItem(nodeId: string): RelatedItemSummary | null;
  replaceItem(item: CacheItem, observedAt: string): void;
  upsertItem(item: CacheItem, repository: CacheRepository, repositoryOwnerId: string, observedAt: string): void;
  removeItem(nodeId: string): void;
  replaceQueueMapping(mapping: QueueMapping): void;
  getQueueMapping(): QueueMapping;
  getStatus(): CacheStatus;
  close(): void;
};

export function openCache({ path }: CacheOptions): Cache {
  const database = new Database(path);
  database.pragma("busy_timeout = 5000");
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
             item_limit, item_count, truncated_reason, reconciliation_kind,
             last_full_reconciled_at, inventory_complete, search_page_size, search_result_limit
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.account.id,
          snapshot.fetchedAt,
          snapshot.scope.searchPageSize ?? 100,
          snapshot.scope.repositoryCount,
          snapshot.scope.searchResultLimit ?? 1_000,
          snapshot.scope.itemCount,
          snapshot.scope.truncatedReason,
          snapshot.scope.reconciliation ?? "full",
          snapshot.scope.lastFullReconciliationAt,
          Number(snapshot.scope.inventoryComplete ?? false),
          snapshot.scope.searchPageSize ?? 100,
          snapshot.scope.searchResultLimit ?? 1_000,
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

  getItem(nodeId: string): CacheItem | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT items.node_id AS id, items.repository_node_id AS repositoryId, items.type,
                  items.number, items.title, items.body, items.url,
                  items.github_created_at AS createdAt, items.github_updated_at AS updatedAt,
                  items.observed_at AS observedAt, pull_request_facts.is_draft AS isDraft,
                  pull_request_facts.additions, pull_request_facts.deletions
           FROM items
           LEFT JOIN pull_request_facts ON pull_request_facts.item_node_id = items.node_id
           WHERE items.node_id = ?`,
        )
        .get(nodeId) as ItemRow | undefined;
      return row ? this.readItem(row) : null;
    })();
  }

  getRelatedItem(nodeId: string): RelatedItemSummary | null {
    return this.database.prepare(
      `SELECT node_id AS id, repository_node_id AS repositoryId,
              repository_name_with_owner AS repositoryNameWithOwner,
              number, title, url
       FROM related_item_summaries WHERE node_id = ?`,
    ).get(nodeId) as RelatedItemSummary | undefined ?? null;
  }

  replaceItem(item: CacheItem, observedAt: string): void {
    this.database.transaction(() => {
      this.writeItem(item, observedAt);
    })();
  }

  upsertItem(item: CacheItem, repository: CacheRepository, repositoryOwnerId: string, observedAt: string): void {
    this.database.transaction(() => {
      const active = this.database
        .prepare(
          `SELECT cache_state.active_generation_id AS generationId,
                  snapshot_generations.account_node_id AS accountId
           FROM cache_state
           LEFT JOIN snapshot_generations
             ON snapshot_generations.id = cache_state.active_generation_id
           WHERE cache_state.singleton = 1`,
        )
        .get() as { generationId: number | null; accountId: string | null } | undefined;
      if (!active?.generationId || !active.accountId) {
        throw new Error("No active cache generation");
      }
      if (repositoryOwnerId !== active.accountId) {
        throw new Error("Repository owner is outside the active account");
      }

      this.database
        .prepare(
          `INSERT INTO repositories (node_id, account_node_id, name_with_owner, observed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
             account_node_id = excluded.account_node_id,
             name_with_owner = excluded.name_with_owner,
             observed_at = excluded.observed_at`,
        )
        .run(repository.id, active.accountId, repository.nameWithOwner, observedAt);
      this.database
        .prepare("INSERT OR IGNORE INTO snapshot_repositories (generation_id, repository_node_id) VALUES (?, ?)")
        .run(active.generationId, repository.id);
      this.writeItem(item, observedAt);
      this.database
        .prepare("INSERT OR IGNORE INTO snapshot_items (generation_id, item_node_id) VALUES (?, ?)")
        .run(active.generationId, item.id);
      this.database
        .prepare(
          `UPDATE snapshot_generations
           SET repository_count = (SELECT COUNT(*) FROM snapshot_repositories WHERE generation_id = ?),
               item_count = (SELECT COUNT(*) FROM snapshot_items WHERE generation_id = ?)
           WHERE id = ?`,
        )
        .run(active.generationId, active.generationId, active.generationId);
    })();
  }

  removeItem(nodeId: string): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM snapshot_items WHERE item_node_id = ?").run(nodeId);
      this.database.prepare("DELETE FROM items WHERE node_id = ?").run(nodeId);
      this.database
        .prepare(
          `UPDATE snapshot_generations
           SET repository_count = (SELECT COUNT(*) FROM snapshot_repositories AS memberships WHERE memberships.generation_id = snapshot_generations.id),
               item_count = (SELECT COUNT(*) FROM snapshot_items AS memberships WHERE memberships.generation_id = snapshot_generations.id)`,
        )
        .run();
      this.cleanupUnreferencedRelatedItems();
    })();
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
           node_id, repository_node_id, type, number, title, body, url, github_created_at, github_updated_at, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           repository_node_id = excluded.repository_node_id,
           type = excluded.type,
           number = excluded.number,
           title = excluded.title,
           body = excluded.body,
           url = excluded.url,
           github_created_at = excluded.github_created_at,
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
        item.createdAt,
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
        throw new Error("Relationship source must match its cached item");
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
    const relatedItems = (item as CacheItem & { relatedItems?: RelatedItemSummary[] }).relatedItems;
    if (relatedItems) {
      const upsertRelatedItem = this.database.prepare(
        `INSERT INTO related_item_summaries (
           node_id, repository_node_id, repository_name_with_owner, number, title, url, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           repository_node_id = excluded.repository_node_id,
           repository_name_with_owner = excluded.repository_name_with_owner,
           number = excluded.number,
           title = excluded.title,
           url = excluded.url,
           observed_at = excluded.observed_at`,
      );
      for (const relatedItem of relatedItems) {
        upsertRelatedItem.run(
          relatedItem.id,
          relatedItem.repositoryId,
          relatedItem.repositoryNameWithOwner,
          relatedItem.number,
          relatedItem.title,
          relatedItem.url,
          observedAt,
        );
      }
    }
    this.cleanupUnreferencedRelatedItems();
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
                generations.truncated_reason, generations.reconciliation_kind,
                generations.last_full_reconciled_at, generations.inventory_complete,
                generations.search_page_size, generations.search_result_limit,
                accounts.node_id AS account_id, accounts.login
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
                items.github_created_at AS createdAt, items.github_updated_at AS updatedAt,
                items.observed_at AS observedAt, pull_request_facts.is_draft AS isDraft,
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
        inventoryComplete: Boolean(generation.inventory_complete),
        lastFullReconciliationAt: generation.last_full_reconciled_at,
        reconciliation: generation.reconciliation_kind,
        repositoryCount: generation.repository_count,
        searchPageSize: generation.search_page_size,
        searchResultLimit: generation.search_result_limit,
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
      createdAt: row.createdAt,
      id: row.id,
      labels,
      number: row.number,
      relationshipCoverage,
      relationships,
      repositoryId: row.repositoryId,
      title: row.title,
      updatedAt: row.updatedAt,
      observedAt: row.observedAt,
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
    this.cleanupUnreferencedRelatedItems();
  }

  private cleanupUnreferencedRelatedItems() {
    this.database.prepare(
      `DELETE FROM related_item_summaries
       WHERE node_id NOT IN (SELECT DISTINCT target_node_id FROM relationships)`,
    ).run();
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
  reconciliation_kind: ReconciliationScope["reconciliation"];
  last_full_reconciled_at: string | null;
  inventory_complete: number;
  search_page_size: number;
  search_result_limit: number;
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
  createdAt: string | null;
  updatedAt: string;
  observedAt: string;
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

  if ((applied.version ?? 0) < 1) database.transaction(() => {
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
  if ((applied.version ?? 0) < 2) database.transaction(() => {
    database.exec(`
      CREATE TABLE related_item_summaries (
        node_id TEXT PRIMARY KEY,
        repository_node_id TEXT NOT NULL,
        repository_name_with_owner TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
    database
      .prepare("INSERT INTO cache_migrations (version, applied_at) VALUES (2, ?)")
      .run(new Date().toISOString());
  })();
  if ((applied.version ?? 0) < 3) database.transaction(() => {
    const columns = database.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "github_created_at")) {
      database.exec("ALTER TABLE items ADD COLUMN github_created_at TEXT");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS related_item_summaries (
        node_id TEXT PRIMARY KEY,
        repository_node_id TEXT NOT NULL,
        repository_name_with_owner TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
    const generationColumns = database.prepare("PRAGMA table_info(snapshot_generations)").all() as Array<{ name: string }>;
    const addColumn = (name: string, definition: string) => {
      if (!generationColumns.some((column) => column.name === name)) {
        database.exec(`ALTER TABLE snapshot_generations ADD COLUMN ${definition}`);
      }
    };
    addColumn("reconciliation_kind", "reconciliation_kind TEXT NOT NULL DEFAULT 'full'");
    addColumn("last_full_reconciled_at", "last_full_reconciled_at TEXT");
    addColumn("inventory_complete", "inventory_complete INTEGER NOT NULL DEFAULT 0");
    addColumn("search_page_size", "search_page_size INTEGER NOT NULL DEFAULT 100");
    addColumn("search_result_limit", "search_result_limit INTEGER NOT NULL DEFAULT 1000");
    database.prepare("INSERT INTO cache_migrations (version, applied_at) VALUES (3, ?)").run(new Date().toISOString());
  })();
}
