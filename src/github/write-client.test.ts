import { describe, expect, it, vi } from "vitest";

import { createGitHubWriteClient } from "./write-client.js";

describe("GitHub write client", () => {
  it("submits every line comment in one add-review operation with the expected commit", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({
        data: { addPullRequestReview: { pullRequestReview: { id: "PRR_1", url: "https://github.test/fictional/reviews/1" } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createGitHubWriteClient("github_pat_fictional", fetch);

    await expect(client.addPullRequestReview({
      pullRequestId: "PR_1",
      expectedHeadSha: "head-one",
      summary: "A small fictional review.",
      event: "REQUEST_CHANGES",
      comments: [
        { path: "src/first.ts", line: 3, side: "RIGHT", body: "Rename this value." },
        { path: "src/second.ts", line: 7, side: "LEFT", body: "Keep the removed check." },
      ],
    })).resolves.toEqual({ status: "submitted", reviewUrl: "https://github.test/fictional/reviews/1" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(request).toMatchObject({
      operationName: "AddPullRequestReview",
      variables: {
        input: {
          pullRequestId: "PR_1",
          commitOID: "head-one",
          body: "A small fictional review.",
          event: "REQUEST_CHANGES",
          threads: [
            { path: "src/first.ts", line: 3, side: "RIGHT", body: "Rename this value." },
            { path: "src/second.ts", line: 7, side: "LEFT", body: "Keep the removed check." },
          ],
        },
      },
    });
  });

  it("distinguishes authoritative rejection from an ambiguous network result", async () => {
    const rejected = createGitHubWriteClient("github_pat_fictional", async () => new Response("forbidden", { status: 403 }));
    const ambiguous = createGitHubWriteClient("github_pat_fictional", async () => { throw new TypeError("network failed"); });
    const input = { pullRequestId: "PR_1", expectedHeadSha: "head", event: "APPROVE" as const, comments: [] };

    await expect(rejected.addPullRequestReview(input)).resolves.toEqual({ status: "rejected" });
    await expect(ambiguous.addPullRequestReview(input)).resolves.toEqual({ status: "unknown" });
  });

  it("sends one squash merge with the expected head and never deletes a ref", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({ merged: true, sha: "merge-commit" }), { status: 200 });
    });
    const client = createGitHubWriteClient("github_pat_fictional", fetch);

    await expect(client.mergePullRequest({
      repositoryNameWithOwner: "fictional-tools/garden",
      number: 7,
      expectedHeadSha: "head-one",
    })).resolves.toEqual({ status: "merged" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/fictional-tools/garden/pulls/7/merge");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ sha: "head-one", merge_method: "squash" });
  });

  it.each([
    [403, "not_permitted"],
    [405, "rejected"],
    [409, "head_changed"],
    [422, "rejected"],
    [500, "unknown"],
  ])("maps merge HTTP %s to %s without retrying", async (status, expected) => {
    const fetch = vi.fn(async () => new Response("failure", { status }));
    const client = createGitHubWriteClient("github_pat_fictional", fetch);
    await expect(client.mergePullRequest({ repositoryNameWithOwner: "fictional-tools/garden", number: 7, expectedHeadSha: "head" }))
      .resolves.toEqual({ status: expected });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
