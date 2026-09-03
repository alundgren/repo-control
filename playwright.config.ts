import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.browser.test.ts",
  outputDir: join(tmpdir(), "repo-control-playwright-results"),
  fullyParallel: false,
  workers: 1,
  use: {
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
