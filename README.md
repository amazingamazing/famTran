# Family Translation

Private EN<->JA realtime translation workspace built for a small family group.

## Workspace layout

- `client/` - React PWA for room join, transcript, glossary, corrections, provider control
- `server/` - Fastify + `ws` room hub, sqlite persistence, provider pipeline abstraction
- `shared/` - shared event contracts used by client and server

## Quick start

1. Install dependencies:
   - `npm install`
2. Start server:
   - `npm run dev:server`
3. Start client:
   - `npm run dev:client`
4. Open two browser tabs/devices and connect to the same room code.

## Verification commands

- Tests: `npm run test`
- Typecheck/lint: `npm run lint`
- Production build: `npm run build`

## Deploy

- Render starter deployment config is in `render.yaml`.
- Copy `server/.env.example` to `server/.env` and fill provider keys.

## Current implementation status

- Text-first realtime turn flow is live over websocket.
- Transcript UI includes translated text + expandable source text.
- Glossary upsert and corrections are persisted in sqlite.
- Provider routing can be switched live from the client operator panel.
- Audio phase currently sends queueable audio events and plays lightweight cues for turn completion.
