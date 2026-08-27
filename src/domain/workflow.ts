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
  queue: string | null;
  readiness: IssueReadiness;
  eligibleForRecommendation: boolean;
};

export type ClassificationOptions = {
  epicLabel: string;
};

export function classifyIssues<T extends IssueForClassification>(
  mapping: QueueMapping,
  issues: T[],
  options: ClassificationOptions,
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
        queue: isEpic(issue, options.epicLabel) ? null : matchingQueues.size === 1 ? [...matchingQueues][0]! : mapping.defaultQueue,
        readiness,
        eligibleForRecommendation: readiness.kind === "unblocked",
      };
    })
    .sort(compareIssues);
}

function isEpic(issue: IssueForClassification, epicLabel: string) {
  return issue.labels.some(({ name }) => name === epicLabel);
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
    (left.queue === null ? 1 : 0) - (right.queue === null ? 1 : 0) ||
    readinessBand(left.readiness) - readinessBand(right.readiness) ||
    compareStrings(left.updatedAt, right.updatedAt) ||
    compareStrings(left.repositoryId, right.repositoryId) ||
    left.number - right.number ||
    compareStrings(left.id, right.id)
  );
}

function readinessBand(readiness: IssueReadiness): number {
  switch (readiness.kind) {
    case "unblocked":
      return 0;
    case "unavailable":
      return 1;
    case "blocked":
      return 2;
  }
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
