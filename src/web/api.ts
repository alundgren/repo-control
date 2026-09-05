import type { ApiRepository, ApiScope, ItemRefreshResponse, OverviewResponse, SyncResponse } from "../api/read-models.js";
import type { PullRequestDiffRead } from "../github/read-client.js";
import type { PullRequestReviewComment, PullRequestReviewEvent } from "../github/write-client.js";
import type { MergeReadiness } from "../merge/index.js";

export type LiveItemEvent =
  | { type: "updated"; item: import("../api/read-models.js").ApiItem; repositories: ApiRepository[]; scope: ApiScope }
  | { type: "removed"; nodeId: string; itemType: "issue" | "pull_request"; number: number; reason: "issue_closed" | "pull_request_closed" | "pull_request_merged" | "repository_out_of_scope"; scope: ApiScope }
  | { type: "reconcile" };

export type LiveSettingsEvent = {
  type: "settings";
  revision: number;
  visibleItemCount: number;
  visibleRepositoryCount: number;
  ignoredRepositoryCount: number;
};

export type RepositoryVisibilitySettings = {
  revision: number;
  repositories: Array<{
    id: string;
    nameWithOwner: string;
    ignored: boolean;
    inActiveSnapshot: boolean;
    activeItemCount: number;
    counts: {
      now: number;
      pullRequests: number;
      agent: number;
      human: number;
      triage: number;
      epics: number;
    };
  }>;
};

export async function getRepositoryVisibility(): Promise<RepositoryVisibilitySettings> {
  const response = await request<{ status: "ready" } & RepositoryVisibilitySettings>("/api/settings/repository-visibility");
  return response;
}

export type ReplaceRepositoryVisibilityResponse =
  | ({ status: "updated" } & RepositoryVisibilitySettings)
  | ({ status: "conflict" } & RepositoryVisibilitySettings)
  | { status: "invalid"; error: { code: "duplicate_repository" | "unknown_repository" | "invalid_request" } }
  | { status: "failed" };

export async function replaceRepositoryVisibility(revision: number, ignoredRepositoryIds: string[]): Promise<ReplaceRepositoryVisibilityResponse> {
  try {
    const response = await fetch("/api/settings/repository-visibility", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, ignoredRepositoryIds }),
    });
    return await response.json() as ReplaceRepositoryVisibilityResponse;
  } catch {
    return { status: "failed" };
  }
}

export async function getOverview(): Promise<OverviewResponse> {
  return request<OverviewResponse>("/api/overview");
}

export async function syncOverview(): Promise<SyncResponse> {
  return request<SyncResponse>("/api/sync", { method: "POST" });
}

export async function refreshItem(nodeId: string): Promise<ItemRefreshResponse> {
  return request<ItemRefreshResponse>(`/api/items/${encodeURIComponent(nodeId)}/refresh`, { method: "POST" });
}

export type PullRequestDiffResponse = PullRequestDiffRead & { reviewEnabled: boolean; mergeEnabled: boolean };

export type ReviewSubmissionResponse =
  | { status: "submitted"; reviewUrl: string | null; refresh: ItemRefreshResponse | { status: "failed" } }
  | { status: "head_changed"; currentHeadSha: string }
  | { status: "disabled" | "invalid" | "not_found" | "not_pull_request" | "verification_failed" | "rejected" | "unknown" };

export async function getPullRequestDiff(nodeId: string): Promise<PullRequestDiffResponse> {
  return request<PullRequestDiffResponse>(`/api/items/${encodeURIComponent(nodeId)}/diff`);
}

export async function submitPullRequestReview(nodeId: string, input: {
  expectedHeadSha: string;
  summary?: string;
  event: PullRequestReviewEvent;
  comments: PullRequestReviewComment[];
}): Promise<ReviewSubmissionResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/items/${encodeURIComponent(nodeId)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return { status: "unknown" };
  }
  try {
    return await response.json() as ReviewSubmissionResponse;
  } catch {
    return { status: "unknown" };
  }
}

export async function getPullRequestMergeReadiness(nodeId: string): Promise<MergeReadiness> {
  try {
    return await request<MergeReadiness>(`/api/items/${encodeURIComponent(nodeId)}/merge`);
  } catch {
    return { status: "unavailable" };
  }
}

export type MergeResponse =
  | { status: "merged"; alreadyMerged: boolean; refresh: ItemRefreshResponse | { status: "failed" } }
  | { status: "failed"; reason: "permission" | "policy" | "validation" | "ambiguous"; currentHeadSha?: string }
  | Exclude<MergeReadiness, { status: "ready" } | { status: "merged" }>;

export async function mergePullRequest(nodeId: string, expectedHeadSha: string): Promise<MergeResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/items/${encodeURIComponent(nodeId)}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedHeadSha }),
    });
  } catch {
    return { status: "failed", reason: "ambiguous" };
  }
  try {
    return await response.json() as MergeResponse;
  } catch {
    return { status: "failed", reason: "ambiguous" };
  }
}

async function request<Response>(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error("The work queue is unavailable.");
  }
  return response.json() as Promise<Response>;
}
