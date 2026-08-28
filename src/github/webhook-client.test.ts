import { describe, expect, it } from "vitest";

import { createGitHubWebhookClient } from "./webhook-client.js";

describe("GitHub webhook client", () => {
  it("lists paged hooks without retaining GitHub response bodies", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createGitHubWebhookClient("github_pat_example_token_for_tests", async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify([{
        id: 17,
        active: true,
        events: ["issues", "pull_request", "sub_issues"],
        config: { url: "https://hooks.example.test/webhooks/github", content_type: "json" },
      }]), {
        headers: { Link: '<https://api.github.com/repos/octo/repo/hooks?page=2>; rel="next"' },
      });
    });

    await expect(client.listHooks({ repositoryNameWithOwner: "octo/repo", page: 1 })).resolves.toEqual({
      status: "complete",
      hooks: [{
        id: 17,
        callbackUrl: "https://hooks.example.test/webhooks/github",
        active: true,
        contentType: "json",
        events: ["issues", "pull_request", "sub_issues"],
      }],
      hasNextPage: true,
    });
    expect(requests[0]?.url).toContain("/repos/octo/repo/hooks?per_page=100&page=1");
    expect(requests[0]?.init.headers).toEqual(expect.objectContaining({ authorization: "Bearer github_pat_example_token_for_tests" }));
  });

  it("creates exactly the current active JSON webhook", async () => {
    let body: unknown;
    const client = createGitHubWebhookClient("github_pat_example_token_for_tests", async (_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(null, { status: 201 });
    });

    await expect(client.createHook({
      repositoryNameWithOwner: "octo/repo",
      callbackUrl: "https://hooks.example.test/webhooks/github",
      secret: "webhook-secret-for-tests",
      active: true,
      contentType: "json",
      events: ["issues", "pull_request", "sub_issues"],
    })).resolves.toEqual({ status: "created" });
    expect(body).toEqual({
      name: "web",
      active: true,
      events: ["issues", "pull_request", "sub_issues"],
      config: { url: "https://hooks.example.test/webhooks/github", content_type: "json", secret: "webhook-secret-for-tests" },
    });
  });

  it("updates one matching callback hook to the current specification", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createGitHubWebhookClient("github_pat_example_token_for_tests", async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    });

    await expect(client.updateHook({
      repositoryNameWithOwner: "octo/repo",
      hookId: 17,
      callbackUrl: "https://hooks.example.test/webhooks/github",
      secret: "webhook-secret-for-tests",
      active: true,
      contentType: "json",
      events: ["issues", "pull_request", "sub_issues"],
    })).resolves.toEqual({ status: "updated" });
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining("/repos/octo/repo/hooks/17"),
      init: { method: "PATCH" },
    });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      active: true,
      events: ["issues", "pull_request", "sub_issues"],
      config: { url: "https://hooks.example.test/webhooks/github", content_type: "json", secret: "webhook-secret-for-tests" },
    });
  });

  it("fails a malformed hook page instead of treating it as unrelated", async () => {
    const client = createGitHubWebhookClient("github_pat_example_token_for_tests", async () =>
      new Response(JSON.stringify([{ config: {} }])),
    );

    await expect(client.listHooks({ repositoryNameWithOwner: "octo/repo", page: 1 })).resolves.toEqual({
      status: "failed",
      code: "invalid_response",
    });
  });

  it("bounds stalled requests so a later sync can retry", async () => {
    const client = createGitHubWebhookClient("github_pat_example_token_for_tests", async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
      }), 1,
    );

    await expect(client.listHooks({ repositoryNameWithOwner: "octo/repo", page: 1 })).resolves.toEqual({
      status: "failed",
      code: "unavailable",
    });
  });

  it("keeps the timeout active while decoding a hook-list body", async () => {
    const client = createGitHubWebhookClient("github_pat_example_token_for_tests", async (_url, init) => ({
      ok: true,
      headers: new Headers(),
      json: () => new Promise((_, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
      }),
    } as unknown as Response), 1);

    await expect(client.listHooks({ repositoryNameWithOwner: "octo/repo", page: 1 })).resolves.toEqual({
      status: "failed",
      code: "unavailable",
    });
  });
});
