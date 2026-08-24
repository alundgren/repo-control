import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogEventSink, createOperationalLogger, type LogEvent } from "./index.js";

describe("operational logging", () => {
  it("writes allow-listed operation events as one JSON line without retaining secrets", () => {
    const output: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    });
    const logger = createOperationalLogger(destination);
    const emit = createLogEventSink(logger);

    emit({
      event: "sync.finished",
      level: "info",
      status: "complete",
      durationMs: 12,
      repositoryCount: 2,
      itemCount: 4,
      token: "fixture-secret-must-not-be-logged",
    });

    const record = JSON.parse(output[0]!);
    expect(record).toMatchObject({
      event: "sync.finished",
      msg: "sync.finished",
      status: "complete",
      durationMs: 12,
      repositoryCount: 2,
      itemCount: 4,
    });
    expect(record).not.toHaveProperty("pid");
    expect(record).not.toHaveProperty("hostname");
    expect(output[0]).not.toContain("Server listening at");
    expect(output[0]).not.toContain("fixture-secret-must-not-be-logged");
    expect(output).toHaveLength(1);
  });

  it("redacts sensitive fields if a future Fastify error path supplies them", () => {
    const output: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    });
    const logger = createOperationalLogger(destination);
    const sentinel = "fixture-secret-must-not-be-logged";

    logger.error({ req: { headers: { authorization: sentinel, cookie: sentinel, "x-hub-signature-256": sentinel }, body: sentinel } }, "request failed");

    expect(output.join("\n")).not.toContain(sentinel);
  });

  it("keeps captured events easy to assert without depending on Pino metadata", () => {
    const events: LogEvent[] = [];
    const logger = createLogEventSink({
      info(fields: Record<string, unknown>) { events.push({ ...fields, level: "info", event: String(fields.event) } as LogEvent); },
      warn(fields: Record<string, unknown>) { events.push({ ...fields, level: "warn", event: String(fields.event) } as LogEvent); },
      error(fields: Record<string, unknown>) { events.push({ ...fields, level: "error", event: String(fields.event) } as LogEvent); },
    } as never);

    logger({ event: "startup.finished", level: "info", status: "started", durationMs: 3 });

    expect(events).toEqual([{ event: "startup.finished", level: "info", status: "started", durationMs: 3 }]);
  });
});
