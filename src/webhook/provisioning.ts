import type { OwnedRepositoryInventory } from "../github/read-client.js";

import type { TerminalProvisioningOutcome, WebhookProvisioningStore } from "./provisioning-store.js";

export type WebhookProvisioningConfiguration = {
  secret: string;
  callbackUrl: string;
};

const WEBHOOK_SPEC = {
  version: 2,
  active: true,
  contentType: "json",
  events: ["issues", "pull_request", "sub_issues"],
} as const;

type WebhookEvent = typeof WEBHOOK_SPEC.events[number];

type RepositoryHook = {
  id: number;
  callbackUrl: string;
  active: boolean;
  contentType: string;
  events: string[];
};

export type GitHubWebhookClient = {
  listHooks(input: { repositoryNameWithOwner: string; page: number }): Promise<
    | { status: "complete"; hooks: RepositoryHook[]; hasNextPage?: boolean }
    | { status: "failed"; code: "authentication_failed" | "invalid_response" | "unavailable" }
  >;
  createHook(input: {
    repositoryNameWithOwner: string;
    callbackUrl: string;
    secret: string;
    active: boolean;
    contentType: string;
    events: WebhookEvent[];
  }): Promise<{ status: "created" } | { status: "failed"; code: "authentication_failed" | "invalid_response" | "unavailable" }>;
  updateHook(input: {
    repositoryNameWithOwner: string;
    hookId: number;
    callbackUrl: string;
    secret: string;
    active: boolean;
    contentType: string;
    events: WebhookEvent[];
  }): Promise<{ status: "updated" } | { status: "failed"; code: "authentication_failed" | "invalid_response" | "unavailable" }>;
};

export type WebhookProvisioner = {
  reconcile(inventory: OwnedRepositoryInventory): Promise<WebhookProvisioningSummary>;
};

export type WebhookProvisioningSummary = {
  eligible: number;
  created: number;
  updated: number;
  alreadyPresent: number;
  failed: number;
};

export function readWebhookProvisioningConfiguration(environment: Readonly<Record<string, string | undefined>>): WebhookProvisioningConfiguration | null {
  const secret = environment.REPO_CONTROL_GITHUB_WEBHOOK_SECRET;
  const callbackUrl = environment.REPO_CONTROL_GITHUB_WEBHOOK_CALLBACK_URL;
  if (!secret || secret.trim() === "" || !callbackUrl) return null;
  try {
    const url = new URL(callbackUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/webhooks/github" || url.search || url.hash) return null;
    return { secret, callbackUrl: url.toString() };
  } catch {
    return null;
  }
}

export function createWebhookProvisioner({
  store,
  client,
  configuration,
  now = () => new Date().toISOString(),
}: {
  store: WebhookProvisioningStore;
  client: GitHubWebhookClient;
  configuration: WebhookProvisioningConfiguration;
  now?: () => string;
}): WebhookProvisioner {
  return {
    async reconcile(inventory) {
      store.replaceInventory(inventory.account.id, inventory.repositories, inventory.fetchedAt);
      const summary: WebhookProvisioningSummary = { eligible: 0, created: 0, updated: 0, alreadyPresent: 0, failed: 0 };
      for (const repository of inventory.repositories) {
        const recorded = store.getTerminalOutcome(inventory.account.id, repository.id);
        if (repository.isFork || repository.isArchived || recorded?.specVersion === WEBHOOK_SPEC.version) continue;
        summary.eligible += 1;
        const outcome = await reconcileRepository(client, repository.nameWithOwner, configuration);
        if (outcome === "failed") {
          summary.failed += 1;
          continue;
        }
        store.recordTerminalOutcome(
          inventory.account.id,
          repository.id,
          outcome === "updated" ? "already_present" : outcome,
          now(),
          WEBHOOK_SPEC.version,
        );
        if (outcome === "created") summary.created += 1;
        else if (outcome === "updated") summary.updated += 1;
        else summary.alreadyPresent += 1;
      }
      return summary;
    },
  };
}

async function reconcileRepository(
  client: GitHubWebhookClient,
  repositoryNameWithOwner: string,
  configuration: WebhookProvisioningConfiguration,
): Promise<TerminalProvisioningOutcome | "updated" | "failed"> {
  let page = 1;
  let hasNextPage = true;
  const matchingHooks: RepositoryHook[] = [];
  while (hasNextPage) {
    const listed = await client.listHooks({ repositoryNameWithOwner, page });
    if (listed.status === "failed") return "failed";
    matchingHooks.push(...listed.hooks.filter((hook) => hook.callbackUrl === configuration.callbackUrl));
    hasNextPage = listed.hasNextPage ?? false;
    if (hasNextPage) page += 1;
  }
  if (matchingHooks.length > 1) return "failed";
  const [matchingHook] = matchingHooks;
  if (matchingHook) {
    if (matchesWebhookSpec(matchingHook)) return "already_present";
    const updated = await client.updateHook({
      repositoryNameWithOwner,
      hookId: matchingHook.id,
      callbackUrl: configuration.callbackUrl,
      secret: configuration.secret,
      active: WEBHOOK_SPEC.active,
      contentType: WEBHOOK_SPEC.contentType,
      events: [...WEBHOOK_SPEC.events],
    });
    return updated.status === "updated" ? "updated" : "failed";
  }
  const created = await client.createHook({
    repositoryNameWithOwner,
    callbackUrl: configuration.callbackUrl,
    secret: configuration.secret,
    active: WEBHOOK_SPEC.active,
    contentType: WEBHOOK_SPEC.contentType,
    events: [...WEBHOOK_SPEC.events],
  });
  return created.status === "created" ? "created" : "failed";
}

function matchesWebhookSpec(hook: RepositoryHook) {
  return hook.active === WEBHOOK_SPEC.active
    && hook.contentType === WEBHOOK_SPEC.contentType
    && hook.events.length === WEBHOOK_SPEC.events.length
    && WEBHOOK_SPEC.events.every((event) => hook.events.includes(event));
}
