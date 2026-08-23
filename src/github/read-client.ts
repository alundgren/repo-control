export const RECONCILIATION_PAGE_SIZE = 100;
export const SEARCH_RESULT_LIMIT = 1_000;
export const INCREMENTAL_RECONCILIATION_OVERLAP_MINUTES = 5;
export const BODY_EXCERPT_LIMIT = 500;
export const LABEL_LIMIT = 20;
export const RELATIONSHIP_LIMIT = 25;
export const RELATIONSHIP_SUBJECT_LIMIT = 10;

export type GitHubViewer = {
  id: string;
  login: string;
  type: "User" | "Organization";
};

export type RepositoryCapability = {
  id: string;
  nameWithOwner: string;
  owner: { id: string; login: string };
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
};

export type GitHubReadClient = {
  getViewer(): Promise<GitHubViewer>;
  readOwnedRepositoryCapabilities(): Promise<RepositoryCapability[]>;
  readAccountSnapshot(input?: { updatedSince: string | null }): Promise<AccountSnapshotRead>;
  readFocusedItem(input: { nodeId: string }): Promise<FocusedItemRead>;
  readRelationshipEnrichment(input: { nodeIds: string[] }): Promise<RelationshipEnrichmentRead>;
};

export type AccountSnapshot = {
  account: { id: string; login: string };
  fetchedAt: string;
  rateLimit: GitHubRateLimit;
  repositories: GitHubRepository[];
  items: GitHubWorkItem[];
  scope: SnapshotScope;
};

export type AccountSnapshotRead = AccountSnapshot | UnavailableRead;

export type FocusedItemRead =
  | { status: "open"; item: GitHubWorkItem; fetchedAt: string; rateLimit: GitHubRateLimit; scope: FocusedReadScope }
  | { status: "out_of_scope"; reason: "closed" | "repository_not_owned"; rateLimit: GitHubRateLimit }
  | UnavailableRead;

export type RelationshipEnrichmentRead = {
  requestedCount: number;
  readCount: number;
  subjectLimit: number;
  status: "complete" | "partial";
  rateLimit?: GitHubRateLimit;
  subjects: RelationshipEnrichmentSubject[];
} | UnavailableRead;

export type RelationshipEnrichmentSubject = {
  nodeId: string;
  coverage: Pick<RelationshipCoverageByType, "blocker" | "closing_issue">;
  relationships: GitHubRelationship[];
  relatedItems: RelatedWorkItem[];
  status: "read" | "not_sampled";
};

export type RelatedWorkItem = {
  id: string;
  repositoryId: string;
  repositoryNameWithOwner: string;
  number: number;
  title: string;
  url: string;
};

export type GitHubRateLimit = {
  cost: number;
  remaining: number;
  resetAt: string;
};

export type GitHubRepository = {
  id: string;
  nameWithOwner: string;
};

type BaseWorkItem = {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  bodyExcerpt: string | null;
  url: string;
  createdAt?: string;
  updatedAt: string;
  labels: GitHubLabel[];
  relationships: GitHubRelationship[];
  relationshipCoverage: RelationshipCoverageByType;
  relatedItems?: RelatedWorkItem[];
};

export type GitHubWorkItem =
  | (BaseWorkItem & { type: "issue"; pullRequest?: never })
  | (BaseWorkItem & { type: "pull_request"; pullRequest: GitHubPullRequestFacts });

export type GitHubLabel = { id: string; name: string };

export type GitHubRelationship = {
  sourceId: string;
  targetId: string;
  type: RelationshipType;
};

export type RelationshipType = "blocker" | "parent" | "closing_issue";
export type RelationshipCoverage = "complete" | "unavailable" | "not_sampled";
export type RelationshipCoverageByType = Record<RelationshipType, RelationshipCoverage>;

export type GitHubPullRequestFacts = {
  isDraft: boolean;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
};

export type SnapshotScope = {
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
  status: "complete" | "partial";
  partialReasons: SnapshotPartialReason[];
};

export type SnapshotPartialReason =
  | { kind: "search_result_limit"; itemType: "issue" | "pull_request" }
  | { kind: "repository_limit" }
  | { kind: "item_limit"; repositoryId: string; itemType: "issue" | "pull_request" }
  | { kind: "label_limit"; itemId: string }
  | { kind: "relationship_limit"; itemId: string; relationshipType: RelationshipType }
  | { kind: "relationship_enrichment_failed" };

export type FocusedReadScope = {
  status: "complete" | "partial";
  partialReasons: SnapshotPartialReason[];
};

export type UnavailableRead = {
  status: "unavailable";
  error: GitHubReadError;
  rateLimit?: GitHubRateLimit;
};

export type GitHubReadError = {
  code: "authentication_failed" | "rate_limited" | "unavailable" | "invalid_response";
  message: string;
  retryAfterSeconds?: number;
  retryAt?: string;
};
