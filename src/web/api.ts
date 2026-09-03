import type { ApiRepository, ApiScope, ItemRefreshResponse, OverviewResponse, SyncResponse } from "../api/read-models.js";
import type { PullRequestDiffRead } from "../github/read-client.js";
import type { PullRequestReviewComment, PullRequestReviewEvent } from "../github/write-client.js";

export type LiveItemEvent =
  | { type: "updated"; item: import("../api/read-models.js").ApiItem; repositories: ApiRepository[]; scope: ApiScope }
  | { type: "removed"; nodeId: string; itemType: "issue" | "pull_request"; number: number; reason: "issue_closed" | "pull_request_closed" | "pull_request_merged" | "repository_out_of_scope"; scope: ApiScope };

export async function getOverview(): Promise<OverviewResponse> {
  return request<OverviewResponse>("/api/overview");
}

export async function syncOverview(): Promise<SyncResponse> {
  return request<SyncResponse>("/api/sync", { method: "POST" });
}

export async function refreshItem(nodeId: string): Promise<ItemRefreshResponse> {
  return request<ItemRefreshResponse>(`/api/items/${encodeURIComponent(nodeId)}/refresh`, { method: "POST" });
}

export type PullRequestDiffResponse = PullRequestDiffRead & { reviewEnabled: boolean };

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

async function request<Response>(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error("The work queue is unavailable.");
  }
  return response.json() as Promise<Response>;
}
