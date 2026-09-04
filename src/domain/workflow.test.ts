import { describe, expect, it } from "vitest";

import { classifyIssues } from "./workflow.js";

describe("classifyIssues", () => {
  const mapping = {
    defaultQueue: "triage",
    labels: [
      { label: "agent-alias", queue: "agent" },
      { label: "ready-for-agent", queue: "agent" },
      { label: "needs-review", queue: "human" },
    ],
  };

  it("uses configured mappings and a stable version-one order", () => {
    const classified = classifyIssues(mapping, [
      issue({ id: "I_later", number: 3, updatedAt: "2026-08-23T12:00:00.000Z" }),
      issue({
        id: "I_human",
        labels: ["needs-review"],
        number: 9,
        updatedAt: "2026-08-24T12:00:00.000Z",
      }),
      issue({ id: "I_earlier", number: 2, updatedAt: "2026-08-23T12:00:00.000Z" }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id, queue }) => ({ id, queue }))).toEqual([
      { id: "I_earlier", queue: "agent" },
      { id: "I_later", queue: "agent" },
      { id: "I_human", queue: "human" },
    ]);
  });

  it("preserves cached issue fields while ordering ties by repository, number, and ID", () => {
    const classified = classifyIssues(mapping, [
      { ...issue({ id: "I_c", repositoryId: "R_alpha", number: 9 }), title: "Third" },
      { ...issue({ id: "I_a", repositoryId: "R_alpha", number: 9 }), title: "Second" },
      { ...issue({ id: "I_z", repositoryId: "R_alpha", number: 7 }), title: "First" },
      { ...issue({ id: "I_b", repositoryId: "R_beta", number: 1 }), title: "Fourth" },
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id }) => id)).toEqual(["I_z", "I_a", "I_c", "I_b"]);
    expect(classified[0]?.title).toBe("First");
  });

  it("sends absent and unknown labels to the configured default queue", () => {
    const classified = classifyIssues(mapping, [
      issue({ id: "I_none", labels: [] }),
      issue({ id: "I_unknown", labels: ["custom-label"] }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id, queue }) => ({ id, queue }))).toEqual([
      { id: "I_none", queue: "triage" },
      { id: "I_unknown", queue: "triage" },
    ]);
  });

  it("keeps a valid mapping when unknown labels are present, accepts same-queue labels, and defaults conflicts", () => {
    const classified = classifyIssues(mapping, [
      issue({ id: "I_known", labels: ["ready-for-agent", "custom-label"] }),
      issue({ id: "I_conflict", labels: ["ready-for-agent", "needs-review"] }),
      issue({ id: "I_same-queue", labels: ["ready-for-agent", "agent-alias"] }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id, queue }) => ({ id, queue }))).toEqual([
      { id: "I_conflict", queue: "triage" },
      { id: "I_known", queue: "agent" },
      { id: "I_same-queue", queue: "agent" },
    ]);
  });

  it("keeps blocked issues in their queue but excludes them from recommendations", () => {
    const [classified] = classifyIssues(mapping, [
      issue({
        relationships: [
          { sourceId: "I_issue", targetId: "I_blocker_b", type: "blocker" },
          { sourceId: "I_issue", targetId: "I_blocker_a", type: "blocker" },
        ],
      }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified).toMatchObject({
      queue: "agent",
      readiness: { kind: "blocked", blockerIds: ["I_blocker_a", "I_blocker_b"] },
      eligibleForRecommendation: false,
      readyExclusion: "blocked",
    });
  });

  it("derives claimed and combined Ready exclusions from the configured label", () => {
    const classified = classifyIssues(mapping, [
      issue({ id: "I_claimed", labels: ["ready-for-agent", "in-progress"] }),
      issue({
        id: "I_claimed_blocked",
        labels: ["ready-for-agent", "in-progress"],
        relationships: [{ sourceId: "I_claimed_blocked", targetId: "I_blocker", type: "blocker" }],
      }),
      issue({ id: "I_unavailable", blockerCoverage: "unavailable" }),
    ], { epicLabel: "epic", claimedLabel: "in-progress" });

    expect(classified.map(({ id, readyExclusion, eligibleForRecommendation }) => ({ id, readyExclusion, eligibleForRecommendation }))).toEqual([
      { id: "I_claimed", readyExclusion: "claimed", eligibleForRecommendation: false },
      { id: "I_unavailable", readyExclusion: null, eligibleForRecommendation: false },
      { id: "I_claimed_blocked", readyExclusion: "claimed_and_blocked", eligibleForRecommendation: false },
    ]);
  });

  it("does not assign Ready exclusion reasons to other queues", () => {
    const classified = classifyIssues(mapping, [
      issue({ id: "I_human_claimed", labels: ["needs-review", "claimed"] }),
      issue({
        id: "I_triage_blocked",
        labels: [],
        relationships: [{ sourceId: "I_triage_blocked", targetId: "I_blocker", type: "blocker" }],
      }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id, queue, readyExclusion }) => ({ id, queue, readyExclusion }))).toEqual([
      { id: "I_human_claimed", queue: "human", readyExclusion: null },
      { id: "I_triage_blocked", queue: "triage", readyExclusion: null },
    ]);
  });

  it("orders unblocked before unavailable before blocked regardless of recency", () => {
    const classified = classifyIssues(mapping, [
      issue({
        id: "I_blocked_but_newest",
        updatedAt: "2026-08-24T10:00:00.000Z",
        relationships: [{ sourceId: "I_blocked_but_newest", targetId: "I_blocker", type: "blocker" }],
      }),
      issue({ id: "I_unavailable_middle", blockerCoverage: "unavailable", updatedAt: "2026-08-23T10:00:00.000Z" }),
      issue({ id: "I_unblocked_but_oldest", updatedAt: "2026-08-22T10:00:00.000Z" }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id }) => id)).toEqual([
      "I_unblocked_but_oldest",
      "I_unavailable_middle",
      "I_blocked_but_newest",
    ]);
  });

  it("keeps epic-labelled issues out of every queue, even with a queue label", () => {
    const classified = classifyIssues(mapping, [
      issue({ id: "I_epic_only", labels: ["epic"] }),
      issue({ id: "I_epic_and_queue", labels: ["epic", "ready-for-agent"], updatedAt: "2026-08-24T12:00:00.000Z" }),
      issue({ id: "I_regular", labels: ["ready-for-agent"] }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id, queue }) => ({ id, queue }))).toEqual([
      { id: "I_regular", queue: "agent" },
      { id: "I_epic_only", queue: null },
      { id: "I_epic_and_queue", queue: null },
    ]);
  });

  it("respects a configured epic label other than the default name", () => {
    const classified = classifyIssues(mapping, [
      issue({ id: "I_container", labels: ["release-organizer"] }),
    ], { epicLabel: "release-organizer", claimedLabel: "claimed" });

    expect(classified.map(({ id, queue }) => ({ id, queue }))).toEqual([
      { id: "I_container", queue: null },
    ]);
  });

  it("does not treat unavailable or unsampled blocker facts as unblocked", () => {
    const classified = classifyIssues(mapping, [
      issue({
        id: "I_unavailable",
        blockerCoverage: "unavailable",
        relationships: [{ sourceId: "I_unavailable", targetId: "I_retained_blocker", type: "blocker" }],
      }),
      issue({ id: "I_unsampled", blockerCoverage: "not_sampled" }),
    ], { epicLabel: "epic", claimedLabel: "claimed" });

    expect(classified.map(({ id, readiness, eligibleForRecommendation }) => ({
      id,
      readiness,
      eligibleForRecommendation,
    }))).toEqual([
      { id: "I_unavailable", readiness: { kind: "unavailable" }, eligibleForRecommendation: false },
      { id: "I_unsampled", readiness: { kind: "unavailable" }, eligibleForRecommendation: false },
    ]);
  });
});

function issue({
  id = "I_issue",
  repositoryId = "R_repo",
  number = 17,
  updatedAt = "2026-08-23T10:00:00.000Z",
  labels = ["ready-for-agent"],
  relationships = [],
  blockerCoverage = "complete",
}: {
  id?: string;
  repositoryId?: string;
  number?: number;
  updatedAt?: string;
  labels?: string[];
  relationships?: Array<{ sourceId: string; targetId: string; type: "blocker" }>;
  blockerCoverage?: "complete" | "unavailable" | "not_sampled";
} = {}) {
  return {
    id,
    repositoryId,
    number,
    updatedAt,
    labels: labels.map((name) => ({ name })),
    relationships,
    relationshipCoverage: { blocker: blockerCoverage },
  };
}
