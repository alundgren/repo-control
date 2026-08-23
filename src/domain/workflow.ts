export type QueueMapping = {
  defaultQueue: string;
  labels: Array<{ label: string; queue: string }>;
};

export type IssueForClassification = {
  id: string;
  repositoryId: string;
  number: number;
  updatedAt: string;
  labels: Array<{ name: string }>;
  relationships: Array<{ targetId: string; type: string }>;
  relationshipCoverage: { blocker: "complete" | "unavailable" | "not_sampled" };
};

export type IssueReadiness =
  | { kind: "unblocked" }
  | { kind: "blocked"; blockerIds: string[] }
  | { kind: "unavailable" };

export type ClassifiedIssue<T extends IssueForClassification = IssueForClassification> = T & {
  queue: string;
  readiness: IssueReadiness;
  eligibleForRecommendation: boolean;
};

export function classifyIssues<T extends IssueForClassification>(
  mapping: QueueMapping,
  issues: T[],
): ClassifiedIssue<T>[] {
  const queueByLabel = new Map(mapping.labels.map(({ label, queue }) => [label, queue]));

  return issues
    .map((issue) => {
      const matchingQueues = new Set(
        issue.labels
          .map(({ name }) => queueByLabel.get(name))
          .filter((queue): queue is string => queue !== undefined),
      );
      const readiness = getReadiness(issue);

      return {
        ...issue,
        queue: matchingQueues.size === 1 ? [...matchingQueues][0]! : mapping.defaultQueue,
        readiness,
        eligibleForRecommendation: readiness.kind === "unblocked",
      };
    })
    .sort(compareIssues);
}

function getReadiness(issue: IssueForClassification): IssueReadiness {
  if (issue.relationshipCoverage.blocker !== "complete") {
    return { kind: "unavailable" };
  }

  const blockerIds = issue.relationships
    .filter(({ type }) => type === "blocker")
    .map(({ targetId }) => targetId)
    .sort(compareStrings);
  return blockerIds.length === 0 ? { kind: "unblocked" } : { kind: "blocked", blockerIds };
}

function compareIssues(left: ClassifiedIssue, right: ClassifiedIssue) {
  return (
    compareStrings(right.updatedAt, left.updatedAt) ||
    compareStrings(left.repositoryId, right.repositoryId) ||
    left.number - right.number ||
    compareStrings(left.id, right.id)
  );
}

function compareStrings(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
