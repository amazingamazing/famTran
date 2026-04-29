import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { appConfig } from "./config.js";
import { AppDb } from "./db.js";
import { InMemoryProviderPipeline } from "./providers.js";
import { RoomHub } from "./room-hub.js";

const resolveClientDistPath = () => {
  const cwdCandidate = path.resolve(process.cwd(), "client", "dist");
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const relativeCandidate = path.resolve(process.cwd(), "..", "client", "dist");
  if (fs.existsSync(relativeCandidate)) {
    return relativeCandidate;
  }
  return null;
};

const boot = async () => {
  const app = Fastify({ logger: true });
  const db = new AppDb(appConfig.databasePath);
  const providers = new InMemoryProviderPipeline({
    stt: appConfig.providers.stt,
    translation: appConfig.providers.translation,
    tts: appConfig.providers.tts
  }, {
    deepgramApiKey: appConfig.apiKeys.deepgram,
    geminiApiKey: appConfig.apiKeys.gemini,
    geminiModel: appConfig.models.gemini,
    cartesiaApiKey: appConfig.apiKeys.cartesia,
    cartesiaModelId: appConfig.models.cartesia,
    openAiApiKey: appConfig.apiKeys.openAi
  });
  const roomHub = new RoomHub(db, providers);

  app.get("/health", async () => ({ ok: true }));

  app.post(
    "/api/glossary",
    async (request) => {
      const schema = z.object({
        userId: z.string().min(1),
        term: z.string().min(1),
        translation: z.string().min(1),
        notes: z.string().optional().default("")
      });
      const payload = schema.parse(request.body as unknown);
      db.upsertGlossary(payload.userId, payload.term, payload.translation, payload.notes);
      return { ok: true };
    }
  );

  const clientDistPath = resolveClientDistPath();
  if (clientDistPath) {
    await app.register(fastifyStatic, {
      root: clientDistPath,
      prefix: "/"
    });

    app.get("/", async (_request, reply) => reply.sendFile("index.html"));
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/health")) {
        return reply.code(404).send({
          message: `Route ${request.method}:${request.url} not found`,
          error: "Not Found",
          statusCode: 404
        });
      }
      return reply.type("text/html").sendFile("index.html");
    });
  } else {
    app.log.warn("client/dist not found, root path will not serve the frontend");
  }

  const address = await app.listen({ host: appConfig.host, port: appConfig.port });
  app.log.info({ address }, "HTTP server running");

  const wss = new WebSocketServer({ server: app.server });
  wss.on("connection", (socket) => {
    let clientId: string | undefined;
    socket.on("message", async (data) => {
      try {
        const event = JSON.parse(data.toString()) as { type: string };
        if (event.type === "session.join") {
          clientId = roomHub.join(socket, event as never);
          return;
        }
        if (!clientId) {
          return;
        }
        await roomHub.handleEvent(clientId, event as never);
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid client event payload" }));
      }
    });

    socket.on("close", () => {
      if (clientId) {
        roomHub.leave(clientId);
      }
    });
  });
};

void boot();

