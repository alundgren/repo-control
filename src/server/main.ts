import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startApplication } from "./start.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(moduleDirectory, "../web");
const dataDirectory = resolve(process.env.DATA_DIRECTORY ?? "data");
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");

const started = await startApplication(
  { dataDirectory, environment: process.env, host, port, webRoot },
  (message) => console.error(message),
);
if (!started) {
  process.exitCode = 1;
}
