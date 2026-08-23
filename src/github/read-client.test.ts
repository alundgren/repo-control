import { describe, expect, it } from "vitest";

import { createGitHubReadClient } from "./client.js";

describe("GitHub work reads", () => {
  it("maps a bounded account snapshot, including rate limits and partial scope", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const request = JSON.parse(String(init.body)) as { operationName: string };
      expect(request.operationName).toBe("BoundedAccountSnapshot");
      return response(snapshotPayload({
        repositoriesPage: { hasNextPage: true, endCursor: "repo-page-2" },
        issuePage: { hasNextPage: true, endCursor: "issue-page-2" },
        pullRequestPage: { hasNextPage: true, endCursor: "pr-page-2" },
        labelPage: { hasNextPage: true, endCursor: "label-page-2" },
      }));
    });

    await expect(client.readAccountSnapshot()).resolves.toMatchObject({
      account: { id: "U_1", login: "octo" },
      fetchedAt: expect.any(String),
      rateLimit: { cost: 12, remaining: 4888, resetAt: "2026-08-24T12:00:00Z" },
      repositories: [{ id: "R_1", nameWithOwner: "octo/repo" }],
      items: [
        {
          id: "I_1",
          type: "issue",
          repositoryId: "R_1",
          number: 17,
          bodyExcerpt: "First line\nsecond line",
          labels: [{ id: "L_1", name: "ready-for-agent" }],
          relationships: [
            { sourceId: "I_1", targetId: "I_parent", type: "parent" },
            { sourceId: "I_1", targetId: "I_blocker", type: "blocker" },
          ],
        },
        {
          id: "PR_1",
          type: "pull_request",
          pullRequest: { isDraft: false, changedFiles: 4, additions: 21, deletions: 3 },
        },
      ],
      scope: {
        repositoryLimit: 50,
        repositoryCount: 1,
        itemLimit: 200,
        itemCount: 2,
        status: "partial",
        partialReasons: expect.arrayContaining([
          { kind: "repository_limit" },
          { kind: "item_limit", repositoryId: "R_1", itemType: "issue" },
          { kind: "item_limit", repositoryId: "R_1", itemType: "pull_request" },
          { kind: "label_limit", itemId: "I_1" },
        ]),
      },
    });
  });

  it("maps a focused open pull request and preserves unavailable GitHub fields", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const request = JSON.parse(String(init.body)) as {
        operationName: string;
        variables: { id: string };
      };
      expect(request).toMatchObject({ operationName: "FocusedWorkItem", variables: { id: "PR_1" } });
      return response({
        data: {
          node: {
            __typename: "PullRequest",
            state: "OPEN",
            ...workItem({
              id: "PR_1",
              number: 23,
              body: "A short description",
              labels: connection([{ id: "L_1", name: "ready-for-agent" }], true, "label-page-2"),
            }),
            isDraft: true,
            changedFiles: null,
            additions: null,
            deletions: null,
            closingIssuesReferences: connection([], false),
          },
          viewer: { id: "U_1" },
          rateLimit: { cost: 3, remaining: 4900, resetAt: "2026-08-24T12:00:00Z" },
        },
      });
    });

    await expect(client.readFocusedItem({ nodeId: "PR_1" })).resolves.toMatchObject({
      status: "open",
      item: {
        id: "PR_1",
        type: "pull_request",
        pullRequest: { isDraft: true, changedFiles: null, additions: null, deletions: null },
      },
      scope: {
        status: "partial",
        partialReasons: [{ kind: "label_limit", itemId: "PR_1" }],
      },
      rateLimit: { remaining: 4900 },
    });
  });

  it("keeps primary and secondary rate limits safe while preserving retry timing", async () => {
    const token = "github_pat_SENTINEL_SHOULD_NEVER_LEAVE_THE_SERVER";
    const primary = createGitHubReadClient(token, async () => response(
      { errors: [{ message: `API rate limit exceeded for ${token}` }] },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1787558400" },
    ));
    const secondary = createGitHubReadClient(token, async () => response(
      { message: `secondary limit for ${token}` },
      { "retry-after": "60" },
      403,
    ));

    await expect(primary.readAccountSnapshot()).resolves.toEqual({
      status: "unavailable",
      error: {
        code: "rate_limited",
        message: "GitHub rate limit prevented this read.",
        retryAt: "2026-08-24T08:00:00.000Z",
      },
    });
    await expect(secondary.readAccountSnapshot()).resolves.toEqual({
      status: "unavailable",
      error: {
        code: "rate_limited",
        message: "GitHub rate limit prevented this read.",
        retryAfterSeconds: 60,
      },
    });
  });

  it("does not treat a closed item with malformed ownership as proof that it left scope", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async () => response({
      data: {
        viewer: { id: "U_1" },
        node: {
          __typename: "Issue",
          ...workItem(),
          state: "CLOSED",
          repository: { id: "R_1", nameWithOwner: "octo/repo", owner: null },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-24T12:00:00Z" },
      },
    }));

    await expect(client.readFocusedItem({ nodeId: "I_1" })).resolves.toEqual({
      status: "unavailable",
      error: { code: "invalid_response", message: "GitHub did not return the required read data." },
    });
  });

  it("returns a redacted read failure without response details", async () => {
    const token = "github_pat_SENTINEL_SHOULD_NEVER_LEAVE_THE_SERVER";
    const client = createGitHubReadClient(token, async () =>
      response({ errors: [{ message: `Bad credentials: ${token}` }] }),
    );

    await expect(client.readAccountSnapshot()).resolves.toEqual({
      status: "unavailable",
      error: { code: "invalid_response", message: "GitHub did not return the required read data." },
    });
  });
});

function snapshotPayload({
  repositoriesPage,
  issuePage,
  pullRequestPage,
  labelPage,
}: {
  repositoriesPage: PageInfo;
  issuePage: PageInfo;
  pullRequestPage: PageInfo;
  labelPage: PageInfo;
}) {
  return {
    data: {
      viewer: {
        id: "U_1",
        login: "octo",
        repositories: {
          nodes: [{
            id: "R_1",
            nameWithOwner: "octo/repo",
            issues: {
              nodes: [{
                __typename: "Issue",
                ...workItem({ labels: connection([{ id: "L_1", name: "ready-for-agent" }], labelPage.hasNextPage, labelPage.endCursor) }),
                blockedBy: connection([{ id: "I_blocker", state: "OPEN" }, { id: "I_closed_blocker", state: "CLOSED" }], false),
                parent: { id: "I_parent" },
              }],
              pageInfo: issuePage,
            },
            pullRequests: {
              nodes: [{
                __typename: "PullRequest",
                ...workItem({ id: "PR_1", number: 22 }),
                isDraft: false,
                changedFiles: 4,
                additions: 21,
                deletions: 3,
                closingIssuesReferences: connection([{ id: "I_closed_by_pr" }], false),
              }],
              pageInfo: pullRequestPage,
            },
          }],
          pageInfo: repositoriesPage,
        },
      },
      rateLimit: { cost: 12, remaining: 4888, resetAt: "2026-08-24T12:00:00Z" },
    },
  };
}

function workItem({
  id = "I_1",
  number = 17,
  body = "First line\nsecond line",
  labels = connection([{ id: "L_1", name: "ready-for-agent" }], false),
}: {
  id?: string;
  number?: number;
  body?: string;
  labels?: ReturnType<typeof connection>;
} = {}) {
  return {
    id,
    number,
    title: "Ship it",
    body,
    url: "https://github.test/octo/repo/issues/17",
    updatedAt: "2026-08-23T10:00:00Z",
    repository: { id: "R_1", nameWithOwner: "octo/repo", owner: { id: "U_1" } },
    labels,
  };
}

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

function connection<T>(nodes: T[], hasNextPage: boolean, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function response(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}
