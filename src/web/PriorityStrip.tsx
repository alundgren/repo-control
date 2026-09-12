import type { PriorityRead } from "../priority/types.js";

export const priorityTiers = [
  { tier: 5, name: "Critical", description: "Security, trust, privileges, protocols, and user configuration." },
  { tier: 4, name: "Important", description: "Behavior, resource limits, validation, and repository policy." },
  { tier: 3, name: "Skim", description: "Mechanical changes, tests, and tooling." },
  { tier: 2, name: "Glance", description: "Lower-risk documentation and configuration." },
  { tier: 1, name: "Low priority", description: "Generated material and supported low-risk changes." },
] as const;

export function PriorityStrip({ priority, selectedTier, onSelect }: { priority: PriorityRead; selectedTier: number; onSelect: (tier: number) => void }) {
  const current = priority.status === "completed" && priority.result;
  return <div className="priorityStrip">
    <div aria-label="File priority" className="priorityTiers">
      {priorityTiers.map(({ tier, name }) => <button aria-pressed={selectedTier === tier} disabled={!current} key={tier} onClick={() => onSelect(tier)} type="button">
        <strong>{tier}</strong> <span>{name}</span> <span className="priorityTierCount">{current ? current.files.filter((file) => file.tier === tier).length : "–"}</span>
      </button>)}
    </div>
    <div className="priorityMeta">
      <span className={current ? "priorityCurrent" : ""}>{current ? `Current · ${current.headSha}` : priorityStatusText(priority)}</span>
      <details className="priorityDetails"><summary>Details</summary><div>
        <p>AI priorities guide file review. They do not approve this pull request.</p>
        {current ? <p>Classified commit <span className="mono">{current.headSha}</span>.</p> : null}
        {current && current.policyStatus ? <p>Root AGENTS.md: {current.policyStatus}.</p> : null}
        {priority.enqueuedAt ? <p>Originally queued <time dateTime={priority.enqueuedAt}>{new Date(priority.enqueuedAt).toLocaleString()}</time>. {priority.attempts ?? 0} of 2 attempts used.</p> : null}
        <p>One automatic retry after failure. A try waiting more than 24 hours is skipped. A successful result is not rerun for later commits.</p>
        {current && current.evidence.length > 0 ? <><p>Some evidence was unavailable or incomplete:</p><ul>{current.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul></> : null}
      </div></details>
    </div>
  </div>;
}

export function priorityStatusText(priority: PriorityRead) {
  if (priority.status === "queued") return priority.attempts ? "Retry queued · final attempt" : "AI priorities are queued";
  if (priority.status === "running") return "Classifying changed files";
  if (priority.status === "failed") return "AI priorities failed after two attempts";
  if (priority.status === "expired") return "Skipped after 24 hours in the queue";
  if (priority.status === "stale") return "The pull request changed. Earlier priorities are hidden.";
  if (priority.status === "ineligible") return "This pull request is a draft or no longer eligible.";
  if (priority.status === "disabled") return "AI priority is not configured for this installation.";
  return "AI priorities are unavailable.";
}
