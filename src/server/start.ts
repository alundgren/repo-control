import { createGitHubReadClient } from "../github/client.js";
import {
  ConnectionValidationError,
  readConnectionConfiguration,
  validateConnection,
  type GitHubReadClient,
} from "../github/connection.js";
import { createApp } from "./app.js";

export type StartServerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  port: number;
  webRoot: string;
  createGitHubClient?: (token: string) => GitHubReadClient;
};

export async function startServer({
  environment,
  port,
  webRoot,
  createGitHubClient = createGitHubReadClient,
}: StartServerOptions) {
  const configuration = readConnectionConfiguration(environment);
  const connection = await validateConnection(configuration, createGitHubClient(configuration.token));
  const app = await createApp({ webRoot });

  await app.listen({ host: "0.0.0.0", port });
  return { app, connection };
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
