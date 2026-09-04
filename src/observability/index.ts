import pino, { type DestinationStream } from "pino";

import type { FastifyBaseLogger } from "fastify";

export type LogEvent = {
  event:
    | "startup.finished"
    | "startup.failed"
    | "sync.finished"
    | "webhook.provisioning.finished"
    | "refresh.finished"
    | "settings.repository_visibility.finished"
    | "review.submission.finished"
    | "pull_request.merge.finished"
    | "artifact.publication.finished"
    | "artifact.cleanup.finished"
    | "webhook.delivery.finished"
    | "webhook.worker.failed";
  level: "info" | "warn" | "error";
  [field: string]: boolean | number | string | null | undefined;
};

export type LogEventSink = (event: LogEvent) => void;

export function emitLogEvent(logEvent: LogEventSink | undefined, event: LogEvent) {
  try {
    logEvent?.(event);
  } catch {
    // Logging must never change the operation it observes.
  }
}

export function createOperationalLogger(destination: DestinationStream = process.stdout): FastifyBaseLogger {
  return pino(
    {
      level: "info",
      base: null,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-hub-signature-256",
          "req.body",
          "res.headers.set-cookie",
        ],
        remove: true,
      },
    },
    destination,
  );
}

export function createLogEventSink(logger: FastifyBaseLogger): LogEventSink {
  return (event) => {
    emitLogEvent((safeEvent) => {
      const { event: eventName, level } = safeEvent;
      const fields = selectFields(safeEvent, EVENT_FIELDS[eventName]);
      if (level === "error") {
        logger.error({ event: eventName, ...fields }, eventName);
      } else if (level === "warn") {
        logger.warn({ event: eventName, ...fields }, eventName);
      } else {
        logger.info({ event: eventName, ...fields }, eventName);
      }
    }, event);
  };
}

const EVENT_FIELDS: Record<LogEvent["event"], readonly string[]> = {
  "startup.finished": ["status", "durationMs"],
  "startup.failed": ["status", "durationMs", "errorCode", "message"],
  "sync.finished": [
    "status", "durationMs", "reconciliation", "inventoryComplete", "repositoryCount", "itemCount",
    "truncatedReason", "generationId", "errorCode", "hasActiveSnapshot", "rateLimitCost", "rateLimitRemaining", "rateLimitResetAt",
  ],
  "webhook.provisioning.finished": ["status", "eligibleCount", "createdCount", "alreadyPresentCount", "failedCount", "errorCode"],
  "refresh.finished": [
    "status", "mode", "durationMs", "itemType", "relationshipStatus", "removalReason", "errorCode",
    "rateLimitCost", "rateLimitRemaining", "rateLimitResetAt",
  ],
  "settings.repository_visibility.finished": ["status", "revision", "ignoredRepositoryCount", "errorCode"],
  "review.submission.finished": ["status", "durationMs", "reviewEvent", "commentCount", "refreshStatus"],
  "pull_request.merge.finished": ["status", "reason", "durationMs", "refreshStatus"],
  "artifact.publication.finished": [
    "status", "artifactId", "artifactType", "byteCount", "durationMs", "errorCode",
  ],
  "artifact.cleanup.finished": ["status", "durationMs", "deletedRowCount", "errorCode"],
  "webhook.delivery.finished": [
    "status", "deliveryId", "eventName", "action", "itemType", "attempt", "detail", "retryDelayMs",
  ],
  "webhook.worker.failed": ["status", "errorCode"],
};

function selectFields(event: LogEvent, allowedFields: readonly string[]) {
  return Object.fromEntries(allowedFields.flatMap((field) => event[field] === undefined ? [] : [[field, event[field]]]));
}
