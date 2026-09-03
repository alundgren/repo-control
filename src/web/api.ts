import type { ApiRepository, ApiScope, ItemRefreshResponse, OverviewResponse, SyncResponse } from "../api/read-models.js";
import type { PullRequestDiffRead } from "../github/read-client.js";

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

export async function getPullRequestDiff(nodeId: string): Promise<PullRequestDiffRead> {
  return request<PullRequestDiffRead>(`/api/items/${encodeURIComponent(nodeId)}/diff`);
}

async function request<Response>(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error("The work queue is unavailable.");
  }
  return response.json() as Promise<Response>;
}
