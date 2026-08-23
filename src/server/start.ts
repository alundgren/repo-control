import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { openCache } from "../cache/index.js";
import { createGitHubReadClient } from "../github/client.js";
import {
  ConnectionValidationError,
  readConnectionConfiguration,
  validateConnection,
  type GitHubReadClient,
} from "../github/connection.js";
import { createApp } from "./app.js";

export type StartServerOptions = {
  dataDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  host: string;
  port: number;
  webRoot: string;
  createGitHubClient?: (token: string) => GitHubReadClient;
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

  try {
    const app = await createApp({ webRoot });
    app.addHook("onClose", () => cache.close());
    await app.listen({ host, port });
    return { app, connection };
  } catch (error) {
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
