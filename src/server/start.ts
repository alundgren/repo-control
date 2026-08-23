import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { openCache } from "../cache/index.js";
import { createReconciliationCoordinator } from "../coordination/index.js";
import { createChangeEventHub } from "../events/index.js";
import { createGitHubReadClient } from "../github/client.js";
import {
  ConnectionValidationError,
  readConnectionConfiguration,
  validateConnection,
  type GitHubConnectionClient,
} from "../github/connection.js";
import { createItemRefreshService } from "../refresh/index.js";
import { createSyncService } from "../sync/index.js";
import { createWebhookService } from "../webhook/index.js";
import { openDeliveryStore } from "../webhook/store.js";
import { createApp } from "./app.js";

export type StartServerOptions = {
  dataDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  host: string;
  port: number;
  webRoot: string;
  createGitHubClient?: (token: string) => GitHubConnectionClient;
};

export async function startServer({
  dataDirectory,
  environment,
  host,
  port,
  webRoot,
  createGitHubClient = createGitHubReadClient,
}: StartServerOptions) {
  const configuration = readConnectionConfiguration(environment);
  const connection = await validateConnection(configuration, createGitHubClient(configuration.token));
  await mkdir(dataDirectory, { recursive: true });
  const cache = openCache({ path: join(dataDirectory, "repo-control.sqlite") });
  const client = createGitHubReadClient(configuration.token);
  const deliveryStore = openDeliveryStore({ path: join(dataDirectory, "repo-control.sqlite") });
  const coordinator = createReconciliationCoordinator();
  const eventHub = createChangeEventHub();
  const syncService = createSyncService({
    cache,
    client,
    coordinator,
    onComplete: () => deliveryStore.resolveManualReconciliation(new Date().toISOString()),
  });
  const refreshService = createItemRefreshService({ cache, client, coordinator, onChange: eventHub.publish });
  const webhookService = environment.REPO_CONTROL_GITHUB_WEBHOOK_SECRET
    ? createWebhookService({
        cache,
        refreshService,
        secret: environment.REPO_CONTROL_GITHUB_WEBHOOK_SECRET,
        store: deliveryStore,
      })
    : null;

  try {
    const app = await createApp({ webRoot, cache, syncService, refreshService, eventHub, webhookService: webhookService ?? undefined });
    app.addHook("onClose", async () => {
      if (webhookService) await webhookService.stop();
      deliveryStore.close();
      cache.close();
    });
    await app.listen({ host, port });
    if (webhookService) void webhookService.start().catch(() => undefined);
    return { app, connection };
  } catch (error) {
    if (webhookService) await webhookService.stop();
    deliveryStore.close();
    cache.close();
    throw error;
  }
}

export async function startApplication(
  options: StartServerOptions,
  writeStartupFailure: (message: string) => void,
) {
  try {
    await startServer(options);
    return true;
  } catch (error) {
    writeStartupFailure(startupFailureMessage(error));
    return false;
  }
}

export function startupFailureMessage(error: unknown) {
  if (error instanceof ConnectionValidationError) {
    return error.message;
  }
  return "Repo Control could not start because GitHub connection validation failed.";
}
