import { describe, expect, it } from "vitest";

import { createGitHubReadClient } from "./client.js";

describe("GitHub read client", () => {
  it("uses named read operations for viewer and repository capabilities", async () => {
    const requests: Array<{ body: { operationName: string; variables: Record<string, unknown> } }> = [];
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_, init) => {
      const body = JSON.parse(String(init.body)) as {
        operationName: string;
        variables: Record<string, unknown>;
      };
      requests.push({ body });

      if (body.operationName === "AuthenticatedViewer") {
        return response({ data: { viewer: { __typename: "User", id: "U_1", login: "octo" } } });
      }
      return response({
        data: {
          viewer: {
            repositories: {
              nodes: [{
                id: "R_1",
                nameWithOwner: "octo/repo",
                owner: { id: "U_1", login: "octo" },
                issues: { totalCount: 0 },
                pullRequests: { totalCount: 0 },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    });

    await expect(client.getViewer()).resolves.toEqual({ id: "U_1", login: "octo", type: "User" });
    await expect(client.readOwnedRepositoryCapabilities()).resolves.toMatchObject([
      { id: "R_1", issues: { totalCount: 0 }, pullRequests: { totalCount: 0 } },
    ]);
    expect(requests.map((request) => request.body.operationName)).toEqual([
      "AuthenticatedViewer",
      "OwnedRepositoryCapabilities",
    ]);
  });

  it("maps a GitHub error response to a safe validation failure", async () => {
    const token = "github_pat_SENTINEL_SHOULD_NEVER_LEAVE_THE_SERVER";
    const client = createGitHubReadClient(token, async () =>
      response({ errors: [{ message: `Bad credentials: ${token}` }] }),
    );

    await expect(client.getViewer()).rejects.toMatchObject({
      code: "insufficient_read_access",
      message: expect.not.stringContaining(token),
    });
  });

  it("paginates a separate owned repository inventory with fork and archive state", async () => {
    const afterValues: Array<string | null | undefined> = [];
    const client = createGitHubReadClient("github_pat_example_token_for_tests", async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { operationName: string; variables: { after?: string | null } };
      afterValues.push(body.variables.after);
      return response({
        data: {
          viewer: {
            id: "U_1",
            login: "octo",
            repositories: body.variables.after === undefined || body.variables.after === null
              ? {
                  nodes: [{ id: "R_1", nameWithOwner: "octo/active", isFork: false, isArchived: false }],
                  pageInfo: { hasNextPage: true, endCursor: "next-page" },
                }
              : {
                  nodes: [{ id: "R_2", nameWithOwner: "octo/archive", isFork: false, isArchived: true }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
          },
        },
      });
    });

    await expect(client.readOwnedRepositoryInventory?.()).resolves.toMatchObject({
      account: { id: "U_1", login: "octo" },
      repositories: [
        { id: "R_1", isFork: false, isArchived: false },
        { id: "R_2", isFork: false, isArchived: true },
      ],
    });
    expect(afterValues).toEqual([null, "next-page"]);
  });
});

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
