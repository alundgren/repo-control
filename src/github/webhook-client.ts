import type { GitHubWebhookClient } from "../webhook/provisioning.js";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const GITHUB_WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;

export function createGitHubWebhookClient(
  token: string,
  fetch: Fetch = globalThis.fetch,
  timeoutMs = GITHUB_WEBHOOK_REQUEST_TIMEOUT_MS,
): GitHubWebhookClient {
  return {
    async listHooks({ repositoryNameWithOwner, page }) {
      try {
        return await requestWithTimeout(fetch, hooksUrl(repositoryNameWithOwner, page), {
          method: "GET",
          headers: headers(token),
        }, timeoutMs, async (response) => {
          if (!response.ok) return { status: "failed" as const, code: response.status === 401 || response.status === 403 ? "authentication_failed" as const : "unavailable" as const };
          const body: unknown = await response.json();
          if (!Array.isArray(body)) return { status: "failed" as const, code: "invalid_response" as const };
          const hooks = body.map(repositoryHook);
          if (hooks.some((hook) => hook === null)) return { status: "failed" as const, code: "invalid_response" as const };
          return {
            status: "complete" as const,
            hooks: hooks as Array<NonNullable<ReturnType<typeof repositoryHook>>>,
            hasNextPage: /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? ""),
          };
        });
      } catch {
        return { status: "failed", code: "unavailable" };
      }
    },
    async createHook({ repositoryNameWithOwner, callbackUrl: url, secret, active, contentType, events }) {
      try {
        return await requestWithTimeout(fetch, hooksUrl(repositoryNameWithOwner), {
          method: "POST",
          headers: { ...headers(token), "content-type": "application/json" },
          body: JSON.stringify({ name: "web", active, events, config: { url, content_type: contentType, secret } }),
        }, timeoutMs, async (response) => response.ok
          ? { status: "created" as const }
          : { status: "failed" as const, code: response.status === 401 || response.status === 403 ? "authentication_failed" as const : "unavailable" as const });
      } catch {
        return { status: "failed", code: "unavailable" };
      }
    },
    async updateHook({ repositoryNameWithOwner, hookId, callbackUrl: url, secret, active, contentType, events }) {
      try {
        return await requestWithTimeout(fetch, hookUrl(repositoryNameWithOwner, hookId), {
          method: "PATCH",
          headers: { ...headers(token), "content-type": "application/json" },
          body: JSON.stringify({ active, events, config: { url, content_type: contentType, secret } }),
        }, timeoutMs, async (response) => response.ok
          ? { status: "updated" as const }
          : { status: "failed" as const, code: response.status === 401 || response.status === 403 ? "authentication_failed" as const : "unavailable" as const });
      } catch {
        return { status: "failed", code: "unavailable" };
      }
    },
  };
}

async function requestWithTimeout<T>(
  fetch: Fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  operation: (response: Response) => Promise<T>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(await fetch(input, { ...init, signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}

function hooksUrl(repositoryNameWithOwner: string, page?: number) {
  const [owner, repository, ...remaining] = repositoryNameWithOwner.split("/");
  if (!owner || !repository || remaining.length > 0) throw new Error("invalid repository name");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/hooks`;
  return page === undefined ? url : `${url}?per_page=100&page=${page}`;
}

function hookUrl(repositoryNameWithOwner: string, hookId: number) {
  return `${hooksUrl(repositoryNameWithOwner)}/${hookId}`;
}

function headers(token: string) {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}` };
}

function repositoryHook(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  const hook = value as Record<string, unknown>;
  const config = hook.config;
  if (!Number.isInteger(hook.id) || typeof hook.active !== "boolean" || !Array.isArray(hook.events) || !hook.events.every((event) => typeof event === "string") || typeof config !== "object" || config === null) return null;
  const webhookConfig = config as Record<string, unknown>;
  if (typeof webhookConfig.url !== "string" || typeof webhookConfig.content_type !== "string") return null;
  return {
    id: hook.id as number,
    callbackUrl: webhookConfig.url,
    active: hook.active,
    contentType: webhookConfig.content_type,
    events: hook.events as string[],
  };
}
