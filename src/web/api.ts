import type { ItemRefreshResponse, OverviewResponse, SyncResponse } from "../api/read-models.js";

export async function getOverview(): Promise<OverviewResponse> {
  return request<OverviewResponse>("/api/overview");
}

export async function syncOverview(): Promise<SyncResponse> {
  return request<SyncResponse>("/api/sync", { method: "POST" });
}

export async function refreshItem(nodeId: string): Promise<ItemRefreshResponse> {
  return request<ItemRefreshResponse>(`/api/items/${encodeURIComponent(nodeId)}/refresh`, { method: "POST" });
}

async function request<Response>(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error("The work queue is unavailable.");
  }
  return response.json() as Promise<Response>;
}
