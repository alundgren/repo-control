import { describe, expect, it } from "vitest";

import { createGitHubReadClient } from "./client.js";
import { RELATIONSHIP_SUBJECT_LIMIT } from "./read-client.js";

describe("GitHub work reads", () => {
  it("reads pull-request files through bounded REST pages and reports patch fidelity", async () => {
    const urls: string[] = [];
    const oversizedPatch = `@@ -0,0 +1,1 @@\n+${"x".repeat(5 * 1024 * 1024)}`;
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (url) => {
      urls.push(url);
      if (!url.endsWith("/files?per_page=100&page=1")) {
        return response({ head: { sha: "abc123" } }, restRateLimitHeaders());
      }
      return response([
        restFile({ filename: "src/complete.ts", additions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }),
        restFile({ filename: "src/renamed.ts", previous_filename: "src/old.ts", status: "renamed", additions: 2, patch: "@@ -1 +1 @@\n-old\n+new" }),
        restFile({ filename: "assets/image.png", additions: 0 }),
        restFile({ filename: "src/large.ts", additions: 1, patch: oversizedPatch }),
        restFile({ filename: "src/after-budget.ts", additions: 1, patch: "@@ -0,0 +1 @@\n+later" }),
      ], restRateLimitHeaders("4998"));
    });

    await expect(client.readPullRequestDiff({ repositoryNameWithOwner: "fictional-tools/garden", number: 17 })).resolves.toEqual({
      status: "complete",
      headSha: "abc123",
      fileCount: 5,
      files: [
        expect.objectContaining({ path: "src/complete.ts", previousPath: null, patch: { status: "available", text: "@@ -1 +1 @@\n-old\n+new" } }),
        expect.objectContaining({ path: "src/renamed.ts", previousPath: "src/old.ts", patch: { status: "incomplete", reason: "count_mismatch", text: "@@ -1 +1 @@\n-old\n+new" } }),
        expect.objectContaining({ path: "assets/image.png", patch: { status: "unavailable", reason: "github_omitted" } }),
        expect.objectContaining({ path: "src/large.ts", patch: { status: "unavailable", reason: "patch_budget" } }),
        expect.objectContaining({ path: "src/after-budget.ts", patch: { status: "unavailable", reason: "patch_budget" } }),
      ],
      rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-08-24T12:00:00.000Z" },
    });
    expect(urls).toEqual([
      "https://api.github.com/repos/fictional-tools/garden/pulls/17",
      "https://api.github.com/repos/fictional-tools/garden/pulls/17/files?per_page=100&page=1",
    ]);
  });

  it("stops at GitHub's 3,000-file REST ceiling and marks the list partial", async () => {
    const pages: number[] = [];
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (url) => {
      if (!url.includes("/files?")) return response({ head: { sha: "def456" } }, restRateLimitHeaders());
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      return response(Array.from({ length: 100 }, (_, index) => restFile({
        filename: `src/file-${page}-${index}.ts`,
        additions: 0,
        deletions: 0,
        patch: "",
      })), restRateLimitHeaders(String(5000 - page)));
    });

    const result = await client.readPullRequestDiff({ repositoryNameWithOwner: "fictional-tools/garden", number: 18 });

    expect(result).toMatchObject({ status: "partial", headSha: "def456", fileCount: 3000, partialReason: "file_limit" });
    expect(pages).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  });

  it("maps REST rate-limit headers to the safe unavailable read", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async () => response(
      { message: "rate limited" },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1787558400" },
      403,
    ));

    await expect(client.readPullRequestDiff({ repositoryNameWithOwner: "fictional-tools/garden", number: 19 })).resolves.toEqual({
      status: "unavailable",
      error: { code: "rate_limited", message: "GitHub rate limit prevented this read.", retryAt: "2026-08-24T08:00:00.000Z" },
    });
  });

  it("paginates separate open issue and pull-request searches, retaining only personal-account repositories", async () => {
    const requests: Array<{ operationName: string; variables: { query?: string; after?: string | null } }> = [];
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const request = JSON.parse(String(init.body)) as typeof requests[number];
      requests.push(request);
      if (request.operationName === "AccountSearchViewer") {
        return response({ data: { viewer: { id: "U_1", login: "octo" }, rateLimit: rateLimit() } });
      }
      if (request.variables.query?.includes("is:issue") && request.variables.after === null) {
        return response(searchPayload([workItem()], true, "issue-page-2", 2));
      }
      if (request.variables.query?.includes("is:issue")) {
        return response(searchPayload([{ ...workItem({ id: "I_unowned" }), repository: { id: "R_other", nameWithOwner: "other/repo", owner: { id: "U_other" } } }], false, null, 2));
      }
      return response(searchPayload([{ __typename: "PullRequest", ...workItem({ id: "PR_1", number: 22 }), isDraft: false, changedFiles: 4, additions: 21, deletions: 3 }], false, null, 1));
    });

    await expect(client.readAccountSnapshot({ updatedSince: null })).resolves.toMatchObject({
      account: { id: "U_1", login: "octo" },
      fetchedAt: expect.any(String),
      rateLimit: { cost: 4, remaining: 4999, resetAt: "2026-08-24T12:00:00Z" },
      repositories: [{ id: "R_1", nameWithOwner: "octo/repo" }],
      items: [
        {
          id: "I_1",
          type: "issue",
          repositoryId: "R_1",
          number: 17,
          bodyExcerpt: "First line\nsecond line",
          labels: [{ id: "L_1", name: "ready-for-agent" }],
          relationships: [],
          relationshipCoverage: { blocker: "not_sampled", parent: "not_sampled", closing_issue: "not_sampled" },
        },
        {
          id: "PR_1",
          type: "pull_request",
          pullRequest: { isDraft: false, changedFiles: 4, additions: 21, deletions: 3 },
        },
      ],
      scope: {
        reconciliation: "full",
        inventoryComplete: true,
        searchPageSize: 100,
        searchResultLimit: 1000,
        repositoryCount: 1,
        itemCount: 2,
        status: "complete",
        partialReasons: [],
      },
    });
    expect(requests).toMatchObject([
      { operationName: "AccountSearchViewer" },
      { operationName: "AccountSearchPage", variables: { query: "user:octo is:open is:issue sort:updated-asc", after: null } },
      { operationName: "AccountSearchPage", variables: { query: "user:octo is:open is:issue sort:updated-asc", after: "issue-page-2" } },
      { operationName: "AccountSearchPage", variables: { query: "user:octo is:open is:pr sort:updated-asc", after: null } },
    ]);
  });

  it("samples a parent link with its summary and the epic's sub-issue counts on search results", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const request = JSON.parse(String(init.body)) as { operationName: string; variables: { query?: string } };
      if (request.operationName === "AccountSearchViewer") {
        return response({ data: { viewer: { id: "U_1", login: "octo" }, rateLimit: rateLimit() } });
      }
      if (request.variables.query?.includes("is:issue")) {
        return response(searchPayload([{ ...workItem(), parent: graphqlRelatedIssue({ id: "I_epic", number: 2 }), subIssuesSummary: { total: 14, completed: 5 } }], false, null, 1));
      }
      return response(searchPayload([], false, null, 0));
    });

    await expect(client.readAccountSnapshot({ updatedSince: null })).resolves.toMatchObject({
      items: [
        {
          id: "I_1",
          type: "issue",
          relationships: [{ sourceId: "I_1", targetId: "I_epic", type: "parent" }],
          relationshipCoverage: { blocker: "not_sampled", parent: "complete", closing_issue: "not_sampled" },
          relatedItems: [relatedIssue({ id: "I_epic", number: 2 })],
          subIssues: { total: 14, completed: 5 },
        },
      ],
    });
  });

  it("maps a focused issue without a parent and keeps its sub-issue counts fresh", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async () => response({
      data: {
        viewer: { id: "U_1" },
        node: {
          __typename: "Issue",
          ...workItem(),
          state: "OPEN",
          parent: null,
          subIssuesSummary: { total: 7, completed: 7 },
        },
        rateLimit: rateLimit(),
      },
    }));

    await expect(client.readFocusedItem({ nodeId: "I_1" })).resolves.toMatchObject({
      status: "open",
      item: {
        id: "I_1",
        type: "issue",
        relationships: [],
        relationshipCoverage: { blocker: "not_sampled", parent: "complete", closing_issue: "not_sampled" },
        subIssues: { total: 7, completed: 7 },
      },
    });
  });

  it("reads epic progress for a batch of unchanged issue nodes", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_url, init) => {
      const request = JSON.parse(String(init.body)) as { operationName: string; variables: { ids: string[] } };
      expect(request).toEqual({ operationName: "EpicProgress", query: expect.any(String), variables: { ids: ["I_epic_1", "I_epic_2"] } });
      return response({
        data: {
          nodes: [
            { __typename: "Issue", id: "I_epic_1", subIssuesSummary: { total: 7, completed: 1 } },
            { __typename: "Issue", id: "I_epic_2", subIssuesSummary: { total: 3, completed: 3 } },
          ],
          rateLimit: rateLimit(),
        },
      });
    });

    await expect(client.readEpicProgress({ nodeIds: ["I_epic_1", "I_epic_2"] })).resolves.toEqual({
      status: "complete",
      summaries: [
        { nodeId: "I_epic_1", subIssues: { total: 7, completed: 1 } },
        { nodeId: "I_epic_2", subIssues: { total: 3, completed: 3 } },
      ],
      rateLimit: rateLimit(),
    });
  });

  it("marks GitHub's search-result cap as partial instead of claiming a complete inventory", async () => {    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const request = JSON.parse(String(init.body)) as { operationName: string; variables: { query?: string } };
      if (request.operationName === "AccountSearchViewer") return response({ data: { viewer: { id: "U_1", login: "octo" }, rateLimit: rateLimit() } });
      return response(searchPayload(request.variables.query?.includes("is:issue") ? [workItem()] : [], false, null, request.variables.query?.includes("is:issue") ? 1_001 : 0));
    });

    await expect(client.readAccountSnapshot({ updatedSince: null })).resolves.toMatchObject({
      scope: { inventoryComplete: false, status: "partial", partialReasons: [{ kind: "search_result_limit", itemType: "issue" }] },
    });
  });

  it("uses a five-minute overlap for incremental searches while retaining the ascending update order", async () => {
    const queries: string[] = [];
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const request = JSON.parse(String(init.body)) as { operationName: string; variables: { query?: string } };
      if (request.operationName === "AccountSearchViewer") {
        return response({ data: { viewer: { id: "U_1", login: "octo" }, rateLimit: rateLimit() } });
      }
      queries.push(request.variables.query!);
      return response(searchPayload([], false, null, 0));
    });

    await client.readAccountSnapshot({ updatedSince: "2026-08-24T12:00:00.000Z" });

    expect(queries).toEqual([
      "user:octo is:open is:issue sort:updated-asc updated:>=2026-08-24T11:55:00.000Z",
      "user:octo is:open is:pr sort:updated-asc updated:>=2026-08-24T11:55:00.000Z",
    ]);
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

  it("enriches relationship facts in one bounded named read", async () => {
    const requests: unknown[] = [];
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      requests.push(JSON.parse(String(init.body)));
      return response({ data: {
        nodes: [
          { __typename: "Issue", id: "I_1", blockedBy: connection([
            { ...graphqlRelatedIssue({ id: "I_open", number: 4 }), state: "OPEN" },
            { ...graphqlRelatedIssue({ id: "I_closed", number: 3 }), state: "CLOSED" },
          ], false) },
          { __typename: "PullRequest", id: "PR_1", closingIssuesReferences: connection([
            graphqlRelatedIssue({ id: "I_closing", number: 8 }),
          ], false) },
        ],
        rateLimit: { cost: 2, remaining: 4900, resetAt: "2026-08-24T12:00:00Z" },
      } });
    });

    await expect(client.readRelationshipEnrichment({ nodeIds: ["I_1", "PR_1", "I_1"] })).resolves.toEqual({
      requestedCount: 2, readCount: 2, subjectLimit: RELATIONSHIP_SUBJECT_LIMIT, status: "complete", rateLimit: { cost: 2, remaining: 4900, resetAt: "2026-08-24T12:00:00Z" },
      subjects: [
        { nodeId: "I_1", status: "read", coverage: { blocker: "complete", closing_issue: "not_sampled" }, relationships: [{ sourceId: "I_1", targetId: "I_open", type: "blocker" }], relatedItems: [relatedIssue({ id: "I_open", number: 4 })] },
        { nodeId: "PR_1", status: "read", coverage: { blocker: "not_sampled", closing_issue: "complete" }, relationships: [{ sourceId: "PR_1", targetId: "I_closing", type: "closing_issue" }], relatedItems: [relatedIssue({ id: "I_closing", number: 8 })] },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ operationName: "EnrichWorkItemRelationships", variables: { ids: ["I_1", "PR_1"] } });
  });

  it("marks subjects beyond the enrichment budget as not sampled", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const request = JSON.parse(String(init.body)) as { variables: { ids: string[] } };
      return response({ data: { nodes: request.variables.ids.map((id) => ({ __typename: "Issue", id, blockedBy: connection([], false) })), rateLimit: { cost: 1, remaining: 4900, resetAt: "2026-08-24T12:00:00Z" } } });
    });
    const nodeIds = Array.from({ length: RELATIONSHIP_SUBJECT_LIMIT + 1 }, (_, index) => `I_${index}`);
    const result = await client.readRelationshipEnrichment({ nodeIds });
    expect(result).toMatchObject({ requestedCount: RELATIONSHIP_SUBJECT_LIMIT + 1, readCount: RELATIONSHIP_SUBJECT_LIMIT, status: "partial" });
    expect("subjects" in result && result.subjects.at(-1)).toMatchObject({ nodeId: `I_${RELATIONSHIP_SUBJECT_LIMIT}`, status: "not_sampled", coverage: { blocker: "not_sampled", closing_issue: "not_sampled" } });
  });

  it("keeps valid relationship facts when a sibling is incomplete or malformed", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async () => response({ data: {
      nodes: [
        { __typename: "Issue", id: "I_empty", blockedBy: connection([], false) },
        { __typename: "PullRequest", id: "PR_empty", closingIssuesReferences: connection([], false) },
        { __typename: "PullRequest", id: "PR_truncated", closingIssuesReferences: connection([], true, "more") },
        { __typename: "Issue", id: "I_bad", blockedBy: connection([{ id: "I_missing_fields" }], false) },
      ],
      rateLimit: { cost: 3, remaining: 4897, resetAt: "2026-08-24T12:00:00Z" },
    } }));

    const result = await client.readRelationshipEnrichment({ nodeIds: ["I_empty", "PR_empty", "PR_truncated", "I_bad"] });
    expect(result).toMatchObject({ status: "partial" });
    expect("subjects" in result && result.subjects).toEqual([
      { nodeId: "I_empty", status: "read", coverage: { blocker: "complete", closing_issue: "not_sampled" }, relationships: [], relatedItems: [] },
      { nodeId: "PR_empty", status: "read", coverage: { blocker: "not_sampled", closing_issue: "complete" }, relationships: [], relatedItems: [] },
      { nodeId: "PR_truncated", status: "read", coverage: { blocker: "not_sampled", closing_issue: "unavailable" }, relationships: [], relatedItems: [] },
      { nodeId: "I_bad", status: "read", coverage: { blocker: "unavailable", closing_issue: "not_sampled" }, relationships: [], relatedItems: [] },
    ]);
  });

  it("treats a missing relationship subject as a partial enrichment", async () => {
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async () => response({ data: {
      nodes: [],
      rateLimit: rateLimit(),
    } }));

    await expect(client.readRelationshipEnrichment({ nodeIds: ["I_missing"] })).resolves.toMatchObject({
      status: "partial",
      subjects: [{ nodeId: "I_missing", coverage: { blocker: "unavailable", closing_issue: "unavailable" } }],
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
    createdAt: "2026-08-20T10:00:00Z",
    updatedAt: "2026-08-23T10:00:00Z",
    repository: { id: "R_1", nameWithOwner: "octo/repo", owner: { id: "U_1" } },
    labels,
  };
}

function searchPayload(nodes: unknown[], hasNextPage: boolean, endCursor: string | null, issueCount: number) {
  return { data: { viewer: { id: "U_1", login: "octo" }, search: { issueCount, nodes, pageInfo: { hasNextPage, endCursor } }, rateLimit: rateLimit() } };
}

function rateLimit() {
  return { cost: 1, remaining: 4999, resetAt: "2026-08-24T12:00:00Z" };
}

function relatedIssue({ id, number }: { id: string; number: number }) {
  return { id, number, title: `Issue ${number}`, url: `https://github.test/octo/repo/issues/${number}`, repositoryId: "R_1", repositoryNameWithOwner: "octo/repo" };
}

function graphqlRelatedIssue(input: { id: string; number: number }) {
  const { repositoryId, repositoryNameWithOwner, ...issue } = relatedIssue(input);
  return { ...issue, repository: { id: repositoryId, nameWithOwner: repositoryNameWithOwner } };
}


function connection<T>(nodes: T[], hasNextPage: boolean, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function response(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function restFile(overrides: Partial<Record<"filename" | "previous_filename" | "status" | "patch", string> & Record<"additions" | "deletions", number>>) {
  return {
    filename: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    ...overrides,
  };
}

function restRateLimitHeaders(remaining = "4999") {
  return {
    "x-ratelimit-remaining": remaining,
    "x-ratelimit-reset": "1787572800",
  };
}
