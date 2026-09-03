import type { FastifyError, FastifyPluginAsync, FastifyReply } from "fastify";

import { emitLogEvent, type LogEventSink } from "../observability/index.js";
import {
  ArtifactQuotaExceededError,
  type ArtifactStore,
  type ArtifactType,
  type StoredArtifact,
} from "./store.js";
import { renderArtifactViewer } from "./viewer.js";

export { ARTIFACT_VIEWER_RESPONSE_OVERHEAD_BYTES } from "./viewer.js";

export const ARTIFACT_CONFIGURATION_MESSAGE = "Repo Control could not start because the artifact public origin is invalid.";
export const HTML_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_CLEANUP_INTERVAL_MS = 8 * 60 * 60 * 1_000;
const HTML_ARTIFACT_POLICY = {
  mediaType: "text/html",
  charset: "utf-8",
  maxBytes: HTML_ARTIFACT_MAX_BYTES,
  downloadExtension: ".html",
  viewable: true,
} as const;
export const ARTIFACT_TYPE_POLICIES = {
  archify: HTML_ARTIFACT_POLICY,
  presentation: HTML_ARTIFACT_POLICY,
  mockup: HTML_ARTIFACT_POLICY,
} as const satisfies Record<ArtifactType, typeof HTML_ARTIFACT_POLICY>;
const ARTIFACT_TYPES = Object.keys(ARTIFACT_TYPE_POLICIES) as ArtifactType[];
const ARTIFACT_UPLOAD_ROUTES = new Set(ARTIFACT_TYPES.map((type) => `/api/artifacts/${type}`));
export const ARTIFACT_VIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export type ArtifactConfiguration = {
  publicOrigin: string;
};

export class ArtifactConfigurationError extends Error {
  readonly code = "artifact_configuration_invalid";

  constructor() {
    super(ARTIFACT_CONFIGURATION_MESSAGE);
  }
}

export function readArtifactConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ArtifactConfiguration | null {
  const configuredOrigin = environment.REPO_CONTROL_ARTIFACT_PUBLIC_ORIGIN;
  if (configuredOrigin === undefined) return null;

  try {
    const url = new URL(configuredOrigin);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new ArtifactConfigurationError();
    }
    return { publicOrigin: url.origin };
  } catch (error) {
    if (error instanceof ArtifactConfigurationError) throw error;
    throw new ArtifactConfigurationError();
  }
}

export function acceptsHtmlArtifactMediaType(contentType: string | undefined) {
  if (!contentType) return false;
  const [mediaType, ...parameters] = contentType.split(";").map((part) => part.trim());
  if (mediaType?.toLowerCase() !== HTML_ARTIFACT_POLICY.mediaType) return false;
  if (parameters.length === 0) return true;
  if (parameters.length !== 1) return false;
  return /^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(parameters[0]!);
}

export type PublishedArtifact = Omit<StoredArtifact, "content"> & {
  viewUrl: string;
  downloadUrl: string;
};

export type ArtifactService = {
  publish(type: ArtifactType, content: Buffer): PublishedArtifact;
  find(id: string): StoredArtifact | null;
  start(): void;
  stop(): void;
};

export const artifactPlugin: FastifyPluginAsync<{ service: ArtifactService }> = async (app, { service }) => {
  app.addContentTypeParser(/^text\/html(?:\s*;.*)?$/i, {
    parseAs: "buffer",
    bodyLimit: HTML_ARTIFACT_MAX_BYTES,
  }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.routeOptions.url && ARTIFACT_UPLOAD_ROUTES.has(request.routeOptions.url)) {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        reply.code(413).send(artifactError("artifact_too_large"));
        return;
      }
    }
    reply.code(500).send(artifactError("unavailable"));
  });

  for (const type of ARTIFACT_TYPES) {
    app.post<{ Body: Buffer }>(`/api/artifacts/${type}`, {
      bodyLimit: ARTIFACT_TYPE_POLICIES[type].maxBytes,
      onRequest: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!acceptsHtmlArtifactMediaType(request.headers["content-type"])) {
          await reply.code(415).send(artifactError("artifact_media_type_unsupported"));
        }
      },
    }, async (request, reply) => {
      if (request.body.byteLength === 0) {
        return reply.code(400).send(artifactError("artifact_empty"));
      }
      try {
        return reply.code(201).send({ status: "published", ...service.publish(type, request.body) });
      } catch (error) {
        if (error instanceof ArtifactQuotaExceededError) {
          return reply.code(507).send(artifactError(error.code));
        }
        throw error;
      }
    });
  }

  const publicRouteOptions = { exposeHeadRoute: false } as const;
  app.get<{ Params: { id: string } }>("/public/:id/view", publicRouteOptions, async (request, reply) => {
    const artifact = findPublicArtifact(service, request.params.id);
    const policy = artifact ? artifactPolicy(artifact.type) : null;
    if (!artifact || !policy?.viewable) return sendNotFound(reply);
    applyPublicHeaders(reply);
    reply.header("Content-Security-Policy", ARTIFACT_VIEW_CSP);
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Type", `${policy.mediaType}; charset=${policy.charset}`);
    return reply.send(renderArtifactViewer(artifact));
  });

  app.get<{ Params: { id: string } }>("/public/:id/download", publicRouteOptions, async (request, reply) => {
    const artifact = findPublicArtifact(service, request.params.id);
    const policy = artifact ? artifactPolicy(artifact.type) : null;
    if (!artifact || !policy) return sendNotFound(reply);
    applyPublicHeaders(reply);
    reply.header("Content-Type", "application/octet-stream");
    reply.header(
      "Content-Disposition",
      `attachment; filename="artifact-${artifact.id}${policy.downloadExtension}"`,
    );
    return reply.send(artifact.content);
  });
};

type ScheduleEvery = (callback: () => void, intervalMs: number) => () => void;

type ArtifactServiceOptions = {
  configuration: ArtifactConfiguration;
  store: ArtifactStore;
  logEvent?: LogEventSink;
  clock?: () => number;
  scheduleEvery?: ScheduleEvery;
};

export function createArtifactService({
  configuration,
  store,
  logEvent,
  clock = Date.now,
  scheduleEvery = defaultScheduleEvery,
}: ArtifactServiceOptions): ArtifactService {
  let stopTimer: (() => void) | null = null;
  let stopped = false;

  function cleanup() {
    const startedAt = clock();
    try {
      const deletedRowCount = store.cleanup();
      emitLogEvent(logEvent, {
        event: "artifact.cleanup.finished",
        level: "info",
        status: "complete",
        durationMs: clock() - startedAt,
        deletedRowCount,
      });
    } catch {
      emitLogEvent(logEvent, {
        event: "artifact.cleanup.finished",
        level: "error",
        status: "failed",
        durationMs: clock() - startedAt,
        errorCode: "cleanup_failed",
      });
    }
  }

  return {
    publish(type, content) {
      const startedAt = clock();
      try {
        const artifact = store.publish({ type, content });
        emitLogEvent(logEvent, {
          event: "artifact.publication.finished",
          level: "info",
          status: "published",
          artifactId: artifact.id,
          artifactType: artifact.type,
          byteCount: content.byteLength,
          durationMs: clock() - startedAt,
        });
        return {
          ...artifact,
          viewUrl: `${configuration.publicOrigin}/public/${artifact.id}/view`,
          downloadUrl: `${configuration.publicOrigin}/public/${artifact.id}/download`,
        };
      } catch (error) {
        emitLogEvent(logEvent, {
          event: "artifact.publication.finished",
          level: "error",
          status: "failed",
          artifactType: type,
          byteCount: content.byteLength,
          durationMs: clock() - startedAt,
          errorCode: error instanceof ArtifactQuotaExceededError ? error.code : "publication_failed",
        });
        throw error;
      }
    },
    find(id) {
      return store.find(id);
    },
    start() {
      if (stopTimer || stopped) return;
      cleanup();
      stopTimer = scheduleEvery(cleanup, ARTIFACT_CLEANUP_INTERVAL_MS);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopTimer?.();
      store.close();
    },
  };
}

function defaultScheduleEvery(callback: () => void, intervalMs: number) {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function findPublicArtifact(service: ArtifactService, id: string) {
  return /^[a-z]{32}$/.test(id) ? service.find(id) : null;
}

function artifactPolicy(type: string) {
  return type in ARTIFACT_TYPE_POLICIES
    ? ARTIFACT_TYPE_POLICIES[type as keyof typeof ARTIFACT_TYPE_POLICIES]
    : null;
}

function artifactError(code: string) {
  return { status: "error", error: { code } };
}

function sendNotFound(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  return reply.code(404).send(artifactError("not_found"));
}

function applyPublicHeaders(reply: FastifyReply) {
  reply.header("Cache-Control", "public, max-age=2592000, immutable");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  reply.header("X-Content-Type-Options", "nosniff");
}
