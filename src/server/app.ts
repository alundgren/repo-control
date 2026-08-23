import fastify from "fastify";
import fastifyStatic from "@fastify/static";

export type AppOptions = {
  webRoot: string;
};

export async function createApp({ webRoot }: AppOptions) {
  const app = fastify();

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(fastifyStatic, {
    root: webRoot,
  });

  return app;
}
