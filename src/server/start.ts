import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactConfigurationError, createArtifactService, readArtifactConfiguration } from "../artifact/index.js";
import { openArtifactStore } from "../artifact/store.js";
import { openCache } from "../cache/index.js";
import { createReconciliationCoordinator } from "../coordination/index.js";
import { createChangeEventHub } from "../events/index.js";
import { createGitHubReadClient } from "../github/client.js";
import { createGitHubWebhookClient } from "../github/webhook-client.js";
import { createGitHubWriteClient } from "../github/write-client.js";
import {
  ConnectionValidationError,
  readConnectionConfiguration,
  validateConnection,
  type GitHubConnectionClient,
} from "../github/connection.js";
import { createItemRefreshService } from "../refresh/index.js";
import {
  createReviewSubmissionService,
  GitHubWriteActionsConfigurationError,
  readGitHubWriteActions,
} from "../review/index.js";
import { createSyncService } from "../sync/index.js";
import { createWebhookService } from "../webhook/index.js";
import { openDeliveryStore } from "../webhook/store.js";
import { createWebhookProvisioner, readWebhookProvisioningConfiguration } from "../webhook/provisioning.js";
import { openWebhookProvisioningStore } from "../webhook/provisioning-store.js";
import type { FastifyBaseLogger } from "fastify";
import { emitLogEvent, type LogEventSink } from "../observability/index.js";
import { createApp } from "./app.js";

export type StartServerOptions = {
  dataDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  host: string;
  port: number;
  webRoot: string;
  createGitHubClient?: (token: string) => GitHubConnectionClient;
  logger?: FastifyBaseLogger;
  logEvent?: LogEventSink;
};

export async function startServer({
  dataDirectory,
  environment,
  host,
  port,
  webRoot,
  createGitHubClient = createGitHubReadClient,
  logger,
  logEvent,
}: StartServerOptions) {
  const artifactConfiguration = readArtifactConfiguration(environment);
  const writeActions = readGitHubWriteActions(environment);
  const configuration = readConnectionConfiguration(environment);
  const connection = await validateConnection(configuration, createGitHubClient(configuration.token));
  await mkdir(dataDirectory, { recursive: true });
  const cache = openCache({ path: join(dataDirectory, "repo-control.sqlite") });
  const client = createGitHubReadClient(configuration.token);
  const deliveryStore = openDeliveryStore({ path: join(dataDirectory, "repo-control.sqlite") });
  const webhookProvisioningConfiguration = readWebhookProvisioningConfiguration(environment);
  const webhookProvisioningStore = webhookProvisioningConfiguration
    ? openWebhookProvisioningStore({ path: join(dataDirectory, "repo-control.sqlite") })
    : null;
  const webhookProvisioner = webhookProvisioningConfiguration && webhookProvisioningStore
    ? createWebhookProvisioner({
        store: webhookProvisioningStore,
        client: createGitHubWebhookClient(configuration.token),
        configuration: webhookProvisioningConfiguration,
      })
    : undefined;
  const coordinator = createReconciliationCoordinator();
  const eventHub = createChangeEventHub();
  const syncService = createSyncService({
    cache,
    client,
    coordinator,
    onComplete: () => deliveryStore.resolveManualReconciliation(new Date().toISOString()),
    webhookProvisioner,
    logEvent,
  });
  const refreshService = createItemRefreshService({ cache, client, coordinator, onChange: eventHub.publish, logEvent });
  const reviewService = createReviewSubmissionService({
    cache,
    readClient: client,
    writeClient: createGitHubWriteClient(configuration.token),
    refreshService,
    enabled: writeActions.has("review"),
    logEvent,
  });
  const webhookService = environment.REPO_CONTROL_GITHUB_WEBHOOK_SECRET
    ? createWebhookService({
        cache,
        refreshService,
        secret: environment.REPO_CONTROL_GITHUB_WEBHOOK_SECRET,
        store: deliveryStore,
        logEvent,
      })
    : null;
  const artifactService = artifactConfiguration
    ? createArtifactService({
        configuration: artifactConfiguration,
        store: openArtifactStore({ path: join(dataDirectory, "repo-control.sqlite") }),
        logEvent,
      })
    : null;

  try {
    artifactService?.start();
    const app = await createApp({
      logger,
      webRoot,
      cache,
      syncService,
      refreshService,
      diffClient: client,
      reviewService,
      eventHub,
      webhookService: webhookService ?? undefined,
      artifactService: artifactService ?? undefined,
    });
    app.addHook("onClose", async () => {
      if (webhookService) await webhookService.stop();
      artifactService?.stop();
      deliveryStore.close();
      webhookProvisioningStore?.close();
      cache.close();
    });
    await app.listen({ host, port, listenTextResolver: () => "Server listening" });
    if (webhookService) {
      void webhookService.start().catch(() => emitLogEvent(logEvent, {
        event: "webhook.worker.failed",
        level: "error",
        status: "failed",
        errorCode: "worker_failed",
      }));
    }
    return { app, connection };
  } catch (error) {
    if (webhookService) await webhookService.stop();
    artifactService?.stop();
    deliveryStore.close();
    webhookProvisioningStore?.close();
    cache.close();
    throw error;
  }
}

export async function startApplication(
  options: StartServerOptions,
  writeStartupFailure: (message: string) => void,
) {
  const startedAt = Date.now();
  try {
    await startServer(options);
    emitLogEvent(options.logEvent, { event: "startup.finished", level: "info", status: "started", durationMs: Date.now() - startedAt });
    return true;
  } catch (error) {
    writeStartupFailure(startupFailureMessage(error));
    emitLogEvent(options.logEvent, {
      event: "startup.failed",
      level: "error",
      status: "failed",
      durationMs: Date.now() - startedAt,
      errorCode: startupFailureCode(error),
      message: startupFailureMessage(error),
    });
    return false;
  }
}

function startupFailureCode(error: unknown) {
  if (error instanceof ArtifactConfigurationError) return error.code;
  if (error instanceof GitHubWriteActionsConfigurationError) return error.code;
  return error instanceof ConnectionValidationError ? error.code : "authentication_failed";
}

export function startupFailureMessage(error: unknown) {
  if (error instanceof ArtifactConfigurationError) {
    return error.message;
  }
  if (error instanceof GitHubWriteActionsConfigurationError) {
    return error.message;
  }
  if (error instanceof ConnectionValidationError) {
    return error.message;
  }
  return "Repo Control could not start because GitHub connection validation failed.";
}
