import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";

describe("application server", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("reports its health without exposing runtime details", async () => {
    const webRoot = await createWebRoot();
    const app = await createApp({ webRoot });

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("serves the browser shell from the configured build directory", async () => {
    const webRoot = await createWebRoot();
    const app = await createApp({ webRoot });

    try {
      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("<main>Browser shell</main>");
    } finally {
      await app.close();
    }
  });

  async function createWebRoot() {
    const directory = await mkdtemp(join(tmpdir(), "repo-control-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><main>Browser shell</main>",
    );

    return directory;
  }
});
