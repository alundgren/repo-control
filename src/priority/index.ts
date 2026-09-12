import type { Cache } from "../cache/index.js";
import type { GitHubReadClient, PullRequestPriorityContextRead } from "../github/read-client.js";
import type { PriorityClassifier } from "./provider.js";
import type { PriorityJob, PriorityStore } from "./store.js";
import type { PriorityRead } from "./types.js";

export const PRIORITY_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
export type PriorityService = ReturnType<typeof createPriorityService>;
type PriorityClient = Pick<GitHubReadClient, "readPullRequestPriorityContext" | "readPullRequestDiff" | "readRepositoryPolicy">;

export function createPriorityService({ cache, store, client, classify, reconcile, now = Date.now }: {
  cache: Cache;
  store: PriorityStore;
  client: PriorityClient;
  classify: PriorityClassifier;
  reconcile: () => Promise<unknown>;
  now?: () => number;
}) {
  let stopped = true;
  let work: Promise<void> | null = null;
  let reconciliation: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  function target(nodeId: string) {
    const item = cache.getItem(nodeId);
    if (!item || item.type !== "pull_request" || item.pullRequest.isDraft || cache.isRepositoryIgnored(item.repositoryId)) return null;
    const repository = cache.getActiveSnapshot()?.repositories.find((entry) => entry.id === item.repositoryId);
    return repository ? { repositoryNameWithOwner: repository.nameWithOwner, number: item.number } : null;
  }
  function eligible(read: PullRequestPriorityContextRead, nodeId: string) {
    return read.status === "read" && read.nodeId === nodeId && read.state === "open" && !read.isDraft && target(nodeId) !== null;
  }
  function discover() {
    for (const item of cache.getActiveSnapshot()?.items ?? []) {
      if (item.type === "pull_request") store.observe(item.id, target(item.id) !== null, now(), item.updatedAt);
    }
    schedule();
  }
  function schedule() {
    if (stopped || work) return;
    if (timer) clearTimeout(timer);
    const next = store.nextAvailableAt();
    timer = next === null ? null : setTimeout(() => { timer = null; void drain(); }, Math.max(0, next - now()));
    timer?.unref();
  }
  async function process(job: PriorityJob) {
    try {
      const input = target(job.nodeId);
      if (!input) { store.finish(job, "ineligible"); return; }
      const context = await client.readPullRequestPriorityContext(input);
      if (context.status === "unavailable") throw new Error("context_unavailable");
      if (!eligible(context, job.nodeId)) { store.finish(job, "ineligible"); return; }
      const diff = await client.readPullRequestDiff(input);
      if (diff.status !== "complete" || diff.fileCount !== context.fileCount || diff.files.length !== context.fileCount
        || new Set(diff.files.map((file) => file.path)).size !== context.fileCount) throw new Error("incomplete_file_list");
      if (diff.headSha !== context.headSha) { store.fail(job, now(), "stale"); return; }
      const policy = await client.readRepositoryPolicy({ ...input, headSha: context.headSha });
      const before = await client.readPullRequestPriorityContext(input);
      if (before.status === "unavailable") throw new Error("context_unavailable");
      if (!eligible(before, job.nodeId)) { store.finish(job, "ineligible"); return; }
      if (before.headSha !== context.headSha) { store.fail(job, now(), "stale"); return; }
      const result = await classify({ context, files: diff.files, policy });
      const after = await client.readPullRequestPriorityContext(input);
      if (after.status === "unavailable") throw new Error("context_unavailable");
      if (!eligible(after, job.nodeId)) { store.finish(job, "ineligible"); return; }
      if (after.headSha !== context.headSha) { store.fail(job, now(), "stale"); return; }
      store.finish(job, "completed", result);
    } catch { store.fail(job, now()); }
  }
  function drain(): Promise<void> {
    if (work) return work;
    if (stopped) return Promise.resolve();
    work = (async () => {
      let job: PriorityJob | null;
      while (!stopped && (job = store.take(now()))) await process(job);
    })().finally(() => { work = null; schedule(); });
    return work;
  }
  function sync() {
    if (stopped || reconciliation) return;
    reconciliation = Promise.resolve().then(reconcile).then(() => discover()).catch(() => {}).finally(() => { reconciliation = null; });
  }
  return {
    discover,
    drain,
    start() {
      if (!stopped) return;
      stopped = false;
      store.recover();
      discover();
      sync();
      syncTimer = setInterval(sync, PRIORITY_RECONCILIATION_INTERVAL_MS);
      syncTimer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (syncTimer) clearInterval(syncTimer);
      await Promise.all([work, reconciliation]);
    },
    async read(nodeId: string, expectedHeadSha: string): Promise<PriorityRead> {
      const job = store.read(nodeId);
      const base = job ? { attempts: job.attempts, enqueuedAt: job.enqueuedAt } : {};
      const input = target(nodeId);
      if (!input) return { status: "ineligible", ...base };
      if (!job) return { status: "unavailable" };
      const current = await client.readPullRequestPriorityContext(input);
      if (current.status === "unavailable") return { status: "unavailable", ...base };
      if (!eligible(current, nodeId)) return { status: "ineligible", ...base };
      if (current.headSha !== expectedHeadSha || (job.result && job.result.headSha !== current.headSha)) {
        if (job.result && job.result.headSha !== current.headSha) store.stale(nodeId);
        return { status: "stale", ...base };
      }
      return { status: job.status, ...base, ...(job.status === "completed" && job.result ? { result: job.result } : {}) };
    },
  };
}
