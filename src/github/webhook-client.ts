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
          const callbackUrls = body.map(callbackUrl);
          if (callbackUrls.some((url) => url === null)) return { status: "failed" as const, code: "invalid_response" as const };
          return {
            status: "complete" as const,
            hooks: callbackUrls.map((url) => ({ callbackUrl: url })),
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

function headers(token: string) {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}` };
}

function callbackUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "config")) return null;
  const config = (value as Record<string, unknown>).config;
  return typeof config === "object" && config !== null && Object.hasOwn(config, "url") && typeof (config as Record<string, unknown>).url === "string"
    ? (config as Record<string, string>).url
    : null;
}
