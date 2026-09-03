import { describe, expect, it, vi } from "vitest";

import type { LogEvent } from "../observability/index.js";
import {
  ARTIFACT_CLEANUP_INTERVAL_MS,
  ARTIFACT_CONFIGURATION_MESSAGE,
  ARTIFACT_TYPE_POLICIES,
  ArtifactConfigurationError,
  acceptsHtmlArtifactMediaType,
  createArtifactService,
  readArtifactConfiguration,
} from "./index.js";
import type { ArtifactStore } from "./store.js";

describe("artifact service", () => {
  it("is disabled when the public origin is absent and accepts only an HTTPS origin root", () => {
    expect(readArtifactConfiguration({})).toBeNull();
    expect(readArtifactConfiguration({ REPO_CONTROL_ARTIFACT_PUBLIC_ORIGIN: "https://artifacts.example.test/" })).toEqual({
      publicOrigin: "https://artifacts.example.test",
    });

    for (const value of [
      "",
      "http://artifacts.example.test",
      "https://user@example.test",
      "https://example.test/path",
      "https://example.test/?query=yes",
      "https://example.test/#fragment",
    ]) {
      expect(() => readArtifactConfiguration({ REPO_CONTROL_ARTIFACT_PUBLIC_ORIGIN: value })).toThrow(
        expect.objectContaining({ code: "artifact_configuration_invalid", message: ARTIFACT_CONFIGURATION_MESSAGE }),
      );
    }
  });

  it("applies one UTF-8 HTML policy to every supported artifact type", () => {
    expect(ARTIFACT_TYPE_POLICIES).toEqual(Object.fromEntries(
      ["archify", "presentation", "mockup"].map((type) => [type, {
        mediaType: "text/html",
        charset: "utf-8",
        maxBytes: 10 * 1024 * 1024,
        downloadExtension: ".html",
        viewable: true,
      }]),
    ));
    expect(acceptsHtmlArtifactMediaType("text/html")).toBe(true);
    expect(acceptsHtmlArtifactMediaType("TEXT/HTML; CHARSET=UTF-8")).toBe(true);
    expect(acceptsHtmlArtifactMediaType("text/html; charset=\"utf-8\"")).toBe(true);
    expect(acceptsHtmlArtifactMediaType("text/html; charset=iso-8859-1")).toBe(false);
    expect(acceptsHtmlArtifactMediaType("text/html; charset=utf-8; boundary=nope")).toBe(false);
    expect(acceptsHtmlArtifactMediaType("application/xhtml+xml")).toBe(false);
  });

  it("publishes through the store and constructs public URLs from configuration", () => {
    const events: LogEvent[] = [];
    const store = storeFixture();
    const service = createArtifactService({
      configuration: { publicOrigin: "https://artifacts.example.test" },
      store,
      logEvent: (event) => events.push(event),
      clock: () => 100,
    });

    expect(service.publish("presentation", Buffer.from("fixture"))).toEqual({
      id: "a".repeat(32),
      type: "presentation",
      createdAt: "2026-08-31T10:00:00.000Z",
      deleteAfter: "2026-09-30T10:00:00.000Z",
      viewUrl: `https://artifacts.example.test/public/${"a".repeat(32)}/view`,
      downloadUrl: `https://artifacts.example.test/public/${"a".repeat(32)}/download`,
    });
    expect(events).toEqual([expect.objectContaining({
      event: "artifact.publication.finished",
      status: "published",
      artifactId: "a".repeat(32),
      artifactType: "presentation",
      byteCount: 7,
      durationMs: 0,
    })]);
  });

  it("attempts startup cleanup, retries after failure, and stops its timer and store", () => {
    const callbacks: Array<() => void> = [];
    const stopTimer = vi.fn();
    const close = vi.fn();
    const cleanup = vi.fn()
      .mockImplementationOnce(() => { throw new Error("private cleanup detail"); })
      .mockReturnValueOnce(2);
    const events: LogEvent[] = [];
    const service = createArtifactService({
      configuration: { publicOrigin: "https://artifacts.example.test" },
      store: storeFixture({ cleanup, close }),
      logEvent: (event) => events.push(event),
      scheduleEvery: (callback, intervalMs) => {
        expect(intervalMs).toBe(ARTIFACT_CLEANUP_INTERVAL_MS);
        callbacks.push(callback);
        return stopTimer;
      },
    });

    service.start();
    expect(cleanup).toHaveBeenCalledTimes(1);
    callbacks[0]!();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      expect.objectContaining({ event: "artifact.cleanup.finished", status: "failed", errorCode: "cleanup_failed" }),
      expect.objectContaining({ event: "artifact.cleanup.finished", status: "complete", deletedRowCount: 2 }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private cleanup detail");

    service.stop();
    service.stop();
    expect(stopTimer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses the fixed configuration error type", () => {
    const error = new ArtifactConfigurationError();
    expect(error.code).toBe("artifact_configuration_invalid");
    expect(error.message).toBe(ARTIFACT_CONFIGURATION_MESSAGE);
  });
});

function storeFixture(overrides: Partial<ArtifactStore> = {}): ArtifactStore {
  return {
    publish({ type }) {
      return {
        id: "a".repeat(32),
        type,
        appearance: null,
        createdAt: "2026-08-31T10:00:00.000Z",
        deleteAfter: "2026-09-30T10:00:00.000Z",
      };
    },
    find() {
      return null;
    },
    cleanup() {
      return 0;
    },
    close() {},
    ...overrides,
  };
}
