import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(moduleDirectory, "../web");
const port = Number(process.env.PORT ?? "3000");

const app = await createApp({ webRoot });

await app.listen({
  host: "0.0.0.0",
  port,
});
