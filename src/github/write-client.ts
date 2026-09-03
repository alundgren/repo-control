export type PullRequestReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type PullRequestReviewComment = {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
};

export type AddPullRequestReviewInput = {
  pullRequestId: string;
  expectedHeadSha: string;
  summary?: string;
  event: PullRequestReviewEvent;
  comments: PullRequestReviewComment[];
};

export type AddPullRequestReviewOutcome =
  | { status: "submitted"; reviewUrl: string | null }
  | { status: "rejected" }
  | { status: "unknown" };

export type GitHubWriteClient = {
  addPullRequestReview(input: AddPullRequestReviewInput): Promise<AddPullRequestReviewOutcome>;
};

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

export function createGitHubWriteClient(token: string, fetch: Fetch = globalThis.fetch): GitHubWriteClient {
  return {
    async addPullRequestReview(input) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            operationName: "AddPullRequestReview",
            query: ADD_PULL_REQUEST_REVIEW_MUTATION,
            variables: {
              input: {
                pullRequestId: input.pullRequestId,
                commitOID: input.expectedHeadSha,
                body: input.summary?.trim() || undefined,
                event: input.event,
                threads: input.comments.map(({ path, line, side, body }) => ({ path, line, side, body })),
              },
            },
          }),
          signal: controller.signal,
        });
      } catch {
        return { status: "unknown" };
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        return response.status >= 500 || response.status === 408
          ? { status: "unknown" }
          : { status: "rejected" };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { status: "unknown" };
      }
      const review = readReview(payload);
      if (review) return { status: "submitted", reviewUrl: review.url };
      return isObject(payload) && Array.isArray(payload.errors)
        ? { status: "rejected" }
        : { status: "unknown" };
    },
  };
}

const ADD_PULL_REQUEST_REVIEW_MUTATION = `mutation AddPullRequestReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) {
    pullRequestReview { id url }
  }
}`;

function readReview(payload: unknown): { url: string | null } | null {
  if (!isObject(payload) || !isObject(payload.data) || !isObject(payload.data.addPullRequestReview)) return null;
  const review = payload.data.addPullRequestReview.pullRequestReview;
  if (!isObject(review) || typeof review.id !== "string") return null;
  return { url: typeof review.url === "string" ? review.url : null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
