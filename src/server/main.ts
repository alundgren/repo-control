import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startApplication } from "./start.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(moduleDirectory, "../web");
const port = Number(process.env.PORT ?? "3000");

const started = await startApplication(
  { environment: process.env, port, webRoot },
  (message) => console.error(message),
);
if (!started) {
  process.exitCode = 1;
}
