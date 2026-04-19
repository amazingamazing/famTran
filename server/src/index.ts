import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { appConfig } from "./config.js";
import { AppDb } from "./db.js";
import { InMemoryProviderPipeline } from "./providers.js";
import { RoomHub } from "./room-hub.js";

const createRoomCode = () => {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  let value = "";
  for (let i = 0; i < 6; i += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
};

const boot = async () => {
  const app = Fastify({ logger: true });
  const db = new AppDb(appConfig.databasePath);
  const providers = new InMemoryProviderPipeline({
    stt: appConfig.providers.stt,
    translation: appConfig.providers.translation,
    tts: appConfig.providers.tts
  });
  const roomHub = new RoomHub(db, providers);

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/rooms", async () => ({ roomId: createRoomCode() }));

  app.post(
    "/api/glossary",
    async (request) => {
      const schema = z.object({
        roomId: z.string().min(3),
        userId: z.string().min(1),
        term: z.string().min(1),
        translation: z.string().min(1),
        notes: z.string().optional().default("")
      });
      const payload = schema.parse(request.body as unknown);
      db.upsertGlossary(payload.roomId, payload.userId, payload.term, payload.translation, payload.notes);
      return { ok: true };
    }
  );

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

