import type { Cache } from "../cache/index.js";
import type { GitHubReadClient } from "../github/read-client.js";
import type {
  GitHubWriteClient,
  PullRequestReviewComment,
  PullRequestReviewEvent,
} from "../github/write-client.js";
import type { ItemRefreshService, RefreshOutcome } from "../refresh/index.js";
import { emitLogEvent, type LogEventSink } from "../observability/index.js";

export const GITHUB_WRITE_ACTIONS_CONFIGURATION_MESSAGE = "Repo Control could not start because REPO_CONTROL_GITHUB_WRITE_ACTIONS contains an unknown value.";
export const REVIEW_SUMMARY_MAX_BYTES = 64 * 1024;
export const REVIEW_COMMENT_MAX_BYTES = 16 * 1024;
export const REVIEW_COMMENT_LIMIT = 100;

export type GitHubWriteAction = "review" | "merge";

export class GitHubWriteActionsConfigurationError extends Error {
  readonly code = "github_write_actions_invalid";

  constructor() {
    super(GITHUB_WRITE_ACTIONS_CONFIGURATION_MESSAGE);
  }
}

export function readGitHubWriteActions(environment: Readonly<Record<string, string | undefined>>): Set<GitHubWriteAction> {
  const configured = environment.REPO_CONTROL_GITHUB_WRITE_ACTIONS;
  if (configured === undefined || configured.trim() === "") return new Set();
  const values = configured.split(",").map((value) => value.trim());
  if (values.some((value) => value !== "review" && value !== "merge")) {
    throw new GitHubWriteActionsConfigurationError();
  }
  return new Set(values as GitHubWriteAction[]);
}

export type ReviewSubmissionInput = {
  nodeId: string;
  expectedHeadSha: string;
  summary?: string;
  event: PullRequestReviewEvent;
  comments: PullRequestReviewComment[];
};

export type ReviewSubmissionOutcome =
  | { status: "submitted"; reviewUrl: string | null; refresh: RefreshOutcome | null }
  | { status: "head_changed"; currentHeadSha: string }
  | { status: "disabled" | "invalid" | "not_found" | "not_pull_request" | "verification_failed" | "rejected" | "unknown" };

export type ReviewSubmissionService = {
  enabled: boolean;
  submit(input: ReviewSubmissionInput): Promise<ReviewSubmissionOutcome>;
};

export function createReviewSubmissionService({
  cache,
  readClient,
  writeClient,
  refreshService,
  enabled,
  logEvent,
  now = Date.now,
}: {
  cache: Cache;
  readClient: Pick<GitHubReadClient, "readPullRequestHead">;
  writeClient: Pick<GitHubWriteClient, "addPullRequestReview">;
  refreshService: ItemRefreshService;
  enabled: boolean;
  logEvent?: LogEventSink;
  now?: () => number;
}): ReviewSubmissionService {
  return {
    enabled,
    async submit(input) {
      const startedAt = now();
      const finish = <Outcome extends ReviewSubmissionOutcome>(outcome: Outcome): Outcome => {
        emitLogEvent(logEvent, {
          event: "review.submission.finished",
          level: outcome.status === "submitted" ? "info" : outcome.status === "unknown" ? "error" : "warn",
          status: outcome.status,
          durationMs: Math.max(0, now() - startedAt),
          reviewEvent: input.event,
          commentCount: Array.isArray(input.comments) ? input.comments.length : 0,
          refreshStatus: outcome.status === "submitted" ? outcome.refresh?.status ?? "failed" : undefined,
        });
        return outcome;
      };
      if (!enabled) return finish({ status: "disabled" });
      if (!isValidSubmission(input)) return finish({ status: "invalid" });
      const item = cache.getItem(input.nodeId);
      if (!item) return finish({ status: "not_found" });
      if (item.type !== "pull_request") return finish({ status: "not_pull_request" });
      const repository = cache.getActiveSnapshot()?.repositories.find((entry) => entry.id === item.repositoryId);
      if (!repository) return finish({ status: "not_found" });

      const head = await readClient.readPullRequestHead({
        repositoryNameWithOwner: repository.nameWithOwner,
        number: item.number,
      });
      if (head.status === "unavailable") return finish({ status: "verification_failed" });
      if (head.headSha !== input.expectedHeadSha) {
        return finish({ status: "head_changed", currentHeadSha: head.headSha });
      }

      const result = await writeClient.addPullRequestReview({
        pullRequestId: item.id,
        expectedHeadSha: input.expectedHeadSha,
        summary: input.summary,
        event: input.event,
        comments: input.comments,
      });
      if (result.status !== "submitted") return finish(result);
      const refresh = await refreshService.refreshItem({ nodeId: input.nodeId }).catch(() => null);
      return finish({ status: "submitted", reviewUrl: result.reviewUrl, refresh });
    },
  };
}

function isValidSubmission(input: ReviewSubmissionInput): boolean {
  if (typeof input.nodeId !== "string" || input.nodeId.length === 0) return false;
  if (typeof input.expectedHeadSha !== "string" || input.expectedHeadSha.length === 0) return false;
  if (input.event !== "COMMENT" && input.event !== "APPROVE" && input.event !== "REQUEST_CHANGES") return false;
  if (input.summary !== undefined && (typeof input.summary !== "string" || byteLength(input.summary) > REVIEW_SUMMARY_MAX_BYTES)) return false;
  if (!Array.isArray(input.comments) || input.comments.length > REVIEW_COMMENT_LIMIT) return false;
  if (!input.comments.every(isValidComment)) return false;
  const hasContent = Boolean(input.summary?.trim()) || input.comments.length > 0;
  return input.event === "APPROVE" || hasContent;
}

function isValidComment(comment: PullRequestReviewComment): boolean {
  return typeof comment === "object"
    && comment !== null
    && typeof comment.path === "string"
    && comment.path.length > 0
    && Number.isSafeInteger(comment.line)
    && comment.line > 0
    && (comment.side === "LEFT" || comment.side === "RIGHT")
    && typeof comment.body === "string"
    && comment.body.trim().length > 0
    && byteLength(comment.body) <= REVIEW_COMMENT_MAX_BYTES;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
