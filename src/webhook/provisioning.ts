import type { OwnedRepositoryInventory } from "../github/read-client.js";

import type { TerminalProvisioningOutcome, WebhookProvisioningStore } from "./provisioning-store.js";

export type WebhookProvisioningConfiguration = {
  secret: string;
  callbackUrl: string;
};

export type GitHubWebhookClient = {
  listHooks(input: { repositoryNameWithOwner: string; page: number }): Promise<
    | { status: "complete"; hooks: Array<{ callbackUrl: string | null }>; hasNextPage?: boolean }
    | { status: "failed"; code: "authentication_failed" | "invalid_response" | "unavailable" }
  >;
  createHook(input: {
    repositoryNameWithOwner: string;
    callbackUrl: string;
    secret: string;
    active: true;
    contentType: "json";
    events: ["issues", "pull_request"];
  }): Promise<{ status: "created" } | { status: "failed"; code: "authentication_failed" | "invalid_response" | "unavailable" }>;
};

export type WebhookProvisioner = {
  reconcile(inventory: OwnedRepositoryInventory): Promise<WebhookProvisioningSummary>;
};

export type WebhookProvisioningSummary = {
  eligible: number;
  created: number;
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
      const summary: WebhookProvisioningSummary = { eligible: 0, created: 0, alreadyPresent: 0, failed: 0 };
      for (const repository of inventory.repositories) {
        if (repository.isFork || repository.isArchived || store.getTerminalOutcome(inventory.account.id, repository.id)) continue;
        summary.eligible += 1;
        const outcome = await reconcileRepository(client, repository.nameWithOwner, configuration);
        if (outcome === "failed") {
          summary.failed += 1;
          continue;
        }
        store.recordTerminalOutcome(inventory.account.id, repository.id, outcome, now());
        if (outcome === "created") summary.created += 1;
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
): Promise<TerminalProvisioningOutcome | "failed"> {
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage) {
    const listed = await client.listHooks({ repositoryNameWithOwner, page });
    if (listed.status === "failed") return "failed";
    if (listed.hooks.some((hook) => hook.callbackUrl === configuration.callbackUrl)) return "already_present";
    hasNextPage = listed.hasNextPage ?? false;
    if (hasNextPage) page += 1;
  }
  const created = await client.createHook({
    repositoryNameWithOwner,
    callbackUrl: configuration.callbackUrl,
    secret: configuration.secret,
    active: true,
    contentType: "json",
    events: ["issues", "pull_request"],
  });
  return created.status === "created" ? "created" : "failed";
}
