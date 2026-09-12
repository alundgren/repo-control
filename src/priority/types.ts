export type FilePriority = { path: string; tier: 1 | 2 | 3 | 4 | 5; reason: string };

export type PriorityResult = {
  headSha: string;
  files: FilePriority[];
  evidence: string[];
  policyStatus?: "available" | "absent" | "unavailable" | "truncated";
};

export type PriorityStatus = "queued" | "running" | "completed" | "failed" | "expired" | "ineligible" | "stale";

export type PriorityRead = {
  status: PriorityStatus | "disabled" | "unavailable";
  attempts?: number;
  enqueuedAt?: string;
  result?: PriorityResult;
};
