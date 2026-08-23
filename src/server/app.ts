import fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { apiPlugin, type ApiPluginOptions } from "../api/plugin.js";

export type AppOptions = {
  webRoot: string;
} & ApiPluginOptions;

export async function createApp({ webRoot, cache, syncService, refreshService }: AppOptions) {
  const app = fastify();

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(apiPlugin, { prefix: "/api", cache, syncService, refreshService });

  await app.register(fastifyStatic, {
    root: webRoot,
  });

  return app;
}
