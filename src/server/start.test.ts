import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openCache } from "../cache/index.js";
import type { GitHubConnectionClient } from "../github/connection.js";
import { createOperationalLogger } from "../observability/index.js";
import { startApplication, startServer } from "./start.js";

const execFile = promisify(execFileCallback);
const sentinel = "github_pat_SENTINEL_SHOULD_NEVER_LEAVE_THE_SERVER";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "../..");

describe("server startup", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("keeps a configured token out of browser assets, HTTP responses, and startup logs", async () => {
    const webRoot = await createWebRoot();
    const dataDirectory = await createDataDirectory();
    const { app } = await startServer({
      environment: environment(),
      host: "127.0.0.1",
      port: 0,
      webRoot,
      dataDirectory,
      createGitHubClient: () => client(),
    });

    try {
      const [health, shell, browserAssets] = await Promise.all([
        app.inject({ method: "GET", url: "/health" }),
        app.inject({ method: "GET", url: "/" }),
        buildBrowserAssets(),
      ]);

      expect(health.body).not.toContain(sentinel);
      expect(shell.body).not.toContain(sentinel);
      expect(browserAssets).not.toContain(sentinel);
      const logs: string[] = [];
      const events: Array<Record<string, unknown>> = [];
      const started = await startApplication({
        environment: environment(),
        host: "127.0.0.1",
        port: 0,
        webRoot,
        dataDirectory,
        createGitHubClient: () => ({
          async getViewer() {
            throw new Error(sentinel);
          },
          async readOwnedRepositoryCapabilities() {
            return [];
          },
        }),
        logEvent: (event) => events.push(event),
      }, (message) => logs.push(message));

      expect(started).toBe(false);
      expect(logs.join("\n")).not.toContain(sentinel);
      expect(events).toEqual([
        expect.objectContaining({
          event: "startup.failed",
          errorCode: "authentication_failed",
          message: "GitHub rejected the connection or did not return the required read data.",
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("creates the SQLite cache in the configured data directory", async () => {
    const webRoot = await createWebRoot();
    const dataDirectory = await createDataDirectory();
    const output: string[] = [];
    const logger = createOperationalLogger(new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    }));
    const { app } = await startServer({
      environment: environment(),
      host: "127.0.0.1",
      port: 0,
      webRoot,
      dataDirectory,
      createGitHubClient: () => client(),
      logger,
    });

    await app.close();

    expect(output.join("\n")).not.toContain("127.0.0.1");
    expect(output.join("\n")).not.toContain("pid");
    expect(output.join("\n")).not.toContain("hostname");

    await expect(access(join(dataDirectory, "repo-control.sqlite"))).resolves.toBeUndefined();

    const cache = openCache({ path: join(dataDirectory, "repo-control.sqlite") });
    try {
      expect(cache.getStatus().storedItemCount).toBe(0);
    } finally {
      cache.close();
    }
  });

  async function createWebRoot() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-web-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "index.html"), "<!doctype html><main>Browser shell</main>");
    return directory;
  }

  async function createDataDirectory() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-data-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  async function buildBrowserAssets() {
    const output = await mkdtemp(join(tmpdir(), "repo-control-build-"));
    temporaryDirectories.push(output);
    await execFile(process.execPath, [
      "node_modules/vite/bin/vite.js",
      "build",
      "--outDir",
      output,
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, VITE_REPO_CONTROL_GITHUB_TOKEN: sentinel },
    });
    return readFiles(output);
  }
});

function environment() {
  return {
    REPO_CONTROL_GITHUB_TOKEN: sentinel,
    REPO_CONTROL_GITHUB_OWNER: "octo",
    REPO_CONTROL_GITHUB_TOKEN_EXPIRES_AT: "2099-08-24T00:00:00.000Z",
  };
}

function client(): GitHubConnectionClient {
  return {
    async getViewer() {
      return { id: "U_1", login: "octo", type: "User" };
    },
    async readOwnedRepositoryCapabilities() {
      return [{
        id: "R_1",
        nameWithOwner: "octo/repo",
        owner: { id: "U_1", login: "octo" },
        issues: { totalCount: 0 },
        pullRequests: { totalCount: 0 },
      }];
    },
  };
}

async function readFiles(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? readFiles(path) : readFile(path, "utf8");
  }));
  return contents.join("\n");
}
