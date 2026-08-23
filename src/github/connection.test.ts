import { describe, expect, it } from "vitest";

import {
  ConnectionValidationError,
  readConnectionConfiguration,
  validateConnection,
  type GitHubReadClient,
} from "./connection.js";

const token = "github_pat_example_token_for_tests";

describe("GitHub connection validation", () => {
  it.each([
    ["missing", {}, "missing_token"],
    ["malformed", { REPO_CONTROL_GITHUB_TOKEN: "ghp_legacy_token" }, "invalid_token"],
    [
      "expired",
      {
        REPO_CONTROL_GITHUB_TOKEN: token,
        REPO_CONTROL_GITHUB_OWNER: "octo",
        REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT: "2026-08-22T00:00:00.000Z",
      },
      "expired_token",
    ],
    [
      "an invalid calendar date",
      {
        REPO_CONTROL_GITHUB_TOKEN: token,
        REPO_CONTROL_GITHUB_OWNER: "octo",
        REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT: "2026-02-31T00:00:00.000Z",
      },
      "invalid_expiry",
    ],
  ] as const)("rejects %s local configuration without revealing the token", (_, environment, code) => {
    expect(() => readConnectionConfiguration(environment, new Date("2026-08-23T00:00:00.000Z"))).toThrow(
      expect.objectContaining({ code }),
    );

    try {
      readConnectionConfiguration(environment, new Date("2026-08-23T00:00:00.000Z"));
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionValidationError);
      expect(String(error)).not.toContain(token);
    }
  });

  it("accepts a fictional configuration and validates the authenticated owner", async () => {
    const configuration = readConnectionConfiguration({
      REPO_CONTROL_GITHUB_TOKEN: token,
      REPO_CONTROL_GITHUB_OWNER: "octo",
      REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT: "2030-08-24T00:00:00.000Z",
    }, new Date("2026-08-23T00:00:00.000Z"));

    await expect(validateConnection(configuration, client())).resolves.toEqual({
      id: "U_1",
      login: "octo",
    });
  });

  it.each([
    ["organization viewer", client({ viewer: { id: "O_1", login: "octo", type: "Organization" } }), "not_personal_account"],
    ["wrong owner", client({ viewer: { id: "U_1", login: "someone-else", type: "User" } }), "unexpected_owner"],
    [
      "repository from another owner",
      client({
        repositories: [{
          id: "R_1",
          nameWithOwner: "other/repo",
          owner: { id: "U_2", login: "other" },
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
        }],
      }),
      "unexpected_repository_owner",
    ],
    [
      "insufficient fields",
      client({
        repositories: [{
          id: "R_1",
          nameWithOwner: "octo/repo",
          owner: { id: "U_1", login: "octo" },
          issues: { totalCount: Number.NaN },
          pullRequests: { totalCount: 0 },
        }],
      }),
      "insufficient_read_access",
    ],
    ["no repositories", client({ repositories: [] }), "insufficient_read_access"],
  ] as const)("rejects %s", async (_, github, code) => {
    const configuration = readConnectionConfiguration({
      REPO_CONTROL_GITHUB_TOKEN: token,
      REPO_CONTROL_GITHUB_OWNER: "octo",
      REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT: "2030-08-24T00:00:00.000Z",
    }, new Date("2026-08-23T00:00:00.000Z"));

    await expect(validateConnection(configuration, github)).rejects.toEqual(
      expect.objectContaining({ code }),
    );
  });
});

function client(overrides: Partial<{
  viewer: { id: string; login: string; type: "User" | "Organization" };
  repositories: Array<{
    id: string;
    nameWithOwner: string;
    owner: { id: string; login: string };
    issues: { totalCount: number };
    pullRequests: { totalCount: number };
  }>;
}> = {}): GitHubReadClient {
  return {
    async getViewer() {
      return overrides.viewer ?? { id: "U_1", login: "octo", type: "User" };
    },
    async readOwnedRepositoryCapabilities() {
      return overrides.repositories ?? [{
        id: "R_1",
        nameWithOwner: "octo/repo",
        owner: { id: "U_1", login: "octo" },
        issues: { totalCount: 0 },
        pullRequests: { totalCount: 0 },
      }];
    },
  };
}
