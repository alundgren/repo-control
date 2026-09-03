import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactQuotaExceededError, type ArtifactType, type StoredArtifact } from "./store.js";
import {
  ARTIFACT_VIEWER_RESPONSE_OVERHEAD_BYTES,
  HTML_ARTIFACT_MAX_BYTES,
  artifactPlugin,
  type ArtifactService,
} from "./index.js";

describe("artifact HTTP routes", () => {
  const applications: Array<ReturnType<typeof fastify>> = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("publishes Archify documents, presentations, and mockups as supported HTML", async () => {
    const publish = vi.fn((type) => publishedArtifact(type));
    const app = await buildApp(serviceFixture({ publish }));

    for (const [type, contentType] of [
      ["archify", "text/html"],
      ["presentation", "text/html; charset=UTF-8"],
      ["mockup", "TEXT/HTML; CHARSET=\"utf-8\""],
    ] as const) {
      const content = Buffer.from([60, 33, 255, 0, 62]);
      const response = await app.inject({
        method: "POST",
        url: `/api/artifacts/${type}`,
        headers: { "content-type": contentType },
        payload: content,
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ status: "published", ...publishedArtifact(type) });
      expect(publish).toHaveBeenLastCalledWith(type, content);
    }
  });

  it("applies media, size, empty-body, and quota validation in order", async () => {
    const quotaService = serviceFixture({
      publish() {
        throw new ArtifactQuotaExceededError();
      },
    });
    const app = await buildApp(quotaService);

    const unsupportedAndLarge = await app.inject({
      method: "POST",
      url: "/api/artifacts/archify",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(HTML_ARTIFACT_MAX_BYTES + 1),
    });
    expectError(unsupportedAndLarge, 415, "artifact_media_type_unsupported");

    const wrongCharset = await app.inject({
      method: "POST",
      url: "/api/artifacts/archify",
      headers: { "content-type": "text/html; charset=iso-8859-1" },
      payload: Buffer.from("fixture"),
    });
    expectError(wrongCharset, 415, "artifact_media_type_unsupported");

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/artifacts/archify",
      headers: { "content-type": "text/html" },
      payload: Buffer.alloc(HTML_ARTIFACT_MAX_BYTES + 1),
    });
    expectError(tooLarge, 413, "artifact_too_large");

    const empty = await app.inject({
      method: "POST",
      url: "/api/artifacts/archify",
      headers: { "content-type": "text/html" },
      payload: Buffer.alloc(0),
    });
    expectError(empty, 400, "artifact_empty");

    const quota = await app.inject({
      method: "POST",
      url: "/api/artifacts/archify",
      headers: { "content-type": "text/html" },
      payload: Buffer.from("fixture"),
    });
    expectError(quota, 507, "artifact_quota_exceeded");
  });

  it("serves every supported type through a viewer that preserves the stored bytes", async () => {
    const artifacts = new Map<string, ArtifactType>([
      ["a".repeat(32), "archify"],
      ["b".repeat(32), "presentation"],
      ["c".repeat(32), "mockup"],
    ]);
    const content = Buffer.concat([
      Buffer.from("<!doctype html><title>café 雪</title>", "utf8"),
      Buffer.from([255, 0, 128]),
    ]);
    const app = await buildApp(serviceFixture({
      find(id) {
        const type = artifacts.get(id);
        return type ? storedArtifact({ id, type, content }) : null;
      },
    }));

    for (const [id, type] of artifacts) {
      const view = await app.inject({ method: "GET", url: `/public/${id}/view` });
      expect(view.statusCode).toBe(200);
      expect(view.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(view.body).toContain("data-artifact-viewer");
      expect(view.body).toContain(`title="${artifactFrameTitle(type)}"`);
      expect(view.body).toContain('sandbox="allow-scripts allow-downloads"');
      expect(view.body).not.toContain("allow-same-origin");
      expect(decodeEmbeddedArtifact(view.body)).toEqual(content);
      expect(view.headers["content-security-policy"]).toBe(
        "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; connect-src 'none'; object-src 'none'; frame-src blob:; form-action 'none'; base-uri 'none'",
      );
      expect(view.headers["x-frame-options"]).toBe("DENY");
      expectPublicHeaders(view.headers);
    }

    const id = "c".repeat(32);
    const download = await app.inject({ method: "GET", url: `/public/${id}/download` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="artifact-${id}.html"`);
    expect(download.rawPayload).toEqual(content);
    expect(download.headers).not.toHaveProperty("content-security-policy");
    expectPublicHeaders(download.headers);
  });

  it("bounds the viewer response overhead at the maximum upload size", async () => {
    const id = "a".repeat(32);
    const content = Buffer.alloc(HTML_ARTIFACT_MAX_BYTES, 0xa5);
    const app = await buildApp(serviceFixture({
      find: () => storedArtifact({ id, content }),
    }));

    const view = await app.inject({ method: "GET", url: `/public/${id}/view` });
    const encodedBytes = 4 * Math.ceil(content.byteLength / 3);

    expect(view.statusCode).toBe(200);
    expect(view.rawPayload.byteLength).toBeLessThanOrEqual(
      encodedBytes + ARTIFACT_VIEWER_RESPONSE_OVERHEAD_BYTES,
    );
    expect(decodeEmbeddedArtifact(view.body).equals(content)).toBe(true);
  });

  it("returns the same missing response for malformed, unknown, and non-viewable artifacts", async () => {
    const id = "a".repeat(32);
    const app = await buildApp(serviceFixture({
      find(requestedId) {
        return requestedId === id ? storedArtifact({ id, type: "future" }) : null;
      },
    }));

    for (const url of [
      "/public/not-valid/view",
      `/public/${"b".repeat(32)}/view`,
      `/public/${id}/view`,
      `/public/${"A".repeat(32)}/download`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expectError(response, 404, "not_found");
    }
  });

  it("registers only the two GET routes without automatic HEAD siblings", async () => {
    const id = "a".repeat(32);
    const app = await buildApp(serviceFixture({ find: () => storedArtifact({ id }) }));

    for (const request of [
      { method: "HEAD" as const, url: `/public/${id}/view` },
      { method: "HEAD" as const, url: `/public/${id}/download` },
      { method: "POST" as const, url: `/public/${id}/view` },
      { method: "GET" as const, url: `/public/${id}/view/extra` },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(404);
    }
  });

  async function buildApp(service: ArtifactService) {
    const app = fastify();
    applications.push(app);
    await app.register(artifactPlugin, { service });
    return app;
  }
});

function publishedArtifact(type: ArtifactType = "archify") {
  const id = "a".repeat(32);
  return {
    id,
    type,
    createdAt: "2026-08-31T10:00:00.000Z",
    deleteAfter: "2026-09-30T10:00:00.000Z",
    viewUrl: `https://artifacts.example.test/public/${id}/view`,
    downloadUrl: `https://artifacts.example.test/public/${id}/download`,
  };
}

function storedArtifact(overrides: Partial<StoredArtifact>): StoredArtifact {
  return {
    id: "a".repeat(32),
    type: "archify",
    content: Buffer.from("<!doctype html><title>Fixture</title>"),
    createdAt: "2026-08-31T10:00:00.000Z",
    deleteAfter: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function serviceFixture(overrides: Partial<ArtifactService> = {}): ArtifactService {
  return {
    publish(type) {
      return publishedArtifact(type);
    },
    find() {
      return null;
    },
    start() {},
    stop() {},
    ...overrides,
  };
}

function expectError(response: { statusCode: number; json(): unknown; headers: Record<string, unknown> }, statusCode: number, code: string) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual({ status: "error", error: { code } });
}

function expectPublicHeaders(headers: Record<string, unknown>) {
  expect(headers).toMatchObject({
    "cache-control": "public, max-age=2592000, immutable",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-content-type-options": "nosniff",
  });
}

function decodeEmbeddedArtifact(viewer: string) {
  const match = viewer.match(/<script id="artifact-payload" type="application\/octet-stream">([A-Za-z0-9+/=]+)<\/script>/);
  expect(match).not.toBeNull();
  return Buffer.from(match![1]!, "base64");
}

function artifactFrameTitle(type: ArtifactType) {
  return type === "archify" ? "Archify artifact" : type === "presentation" ? "Presentation artifact" : "Mockup artifact";
}
