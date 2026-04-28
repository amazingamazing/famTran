# A family translation PWA you can actually ship in Cursor

**Build a pipelined Deepgram → Gemini 2.5 Flash → Cartesia Sonic-2 stack on a plain Node WebSocket server on Render, with a Vite + React PWA client and silero-vad in the browser.** That is the single stack. Everything else discussed below is why, what it costs, what will bite you, and in what order to build.

The short version: an all-in-one speech-to-speech API (OpenAI Realtime, Gemini Live) cannot satisfy your hard requirements — per-listener transcripts in each user's chosen language, distinct voice per speaker, and per-user context injection — without spinning up one session per listener, which is expensive and awkward. A classic pipeline wins. WebRTC/LiveKit also loses here because audio flow is strictly server-mediated with different TTS output per listener, so an SFU buys nothing. The pieces below are tuned for aggressive latency (~1.0–1.4 s from speech-end to first translated audio in a listener's ear) on a ~$60–90/month all-in budget.

## The recommended stack, component by component

| Layer | Pick | Why it beats the alternative |
|---|---|---|
| Frontend | **Vite + React + TypeScript**, packaged as PWA via `vite-plugin-pwa` | Most Cursor/Claude training data; tiny build; Next.js SSR buys nothing for a single-page audio app. |
| PWA runtime | `manifest.json` with `"display": "standalone"`, iOS icons, **no** Service-Worker caching of the WebSocket endpoint | Works on iOS 17+ "Add to Home Screen." SW caching of live endpoints is the top PWA footgun. |
| Mic capture | `getUserMedia` → `AudioContext({sampleRate:16000})` → **AudioWorkletNode** emitting Float32 PCM frames | Avoids Safari's MediaRecorder container restrictions (no Opus/WebM on iOS, only MP4/AAC). Worklet gives raw PCM that STT APIs accept directly. |
| VAD | **`@ricky0123/vad-web` (silero-vad via ONNX + AudioWorklet)**, with a push-to-talk toggle and Deepgram server-side `UtteranceEnd` as safety net | Silero is the de-facto browser VAD; language-agnostic so it handles JA fine. Tune `minSpeechFrames`/`redemptionFrames` up ~50% for Japanese, which has more intra-sentence pauses than English. |
| Transport | **Plain WebSocket** (`ws` on server, native `WebSocket` in browser). Binary frames for audio, JSON for control | For 2–6 users with server-mediated, per-listener-different audio, mesh/SFU are architecturally wrong — they exist to fan *the same* media out, and you never have "the same" media. WebSocket also sidesteps iOS's long history of `RTCPeerConnection` bugs in standalone PWAs. |
| Backend host | **Render Starter web service ($7/mo)** + 1 GB persistent disk (~$0.25) | User already uses it. Always-on, first-class WebSocket support, no cold starts, runs a normal Node process with native deps if needed. Fly.io is a close runner-up at ~$2/mo but is a lateral move. |
| Backend runtime | **Node 20 + Fastify + `ws`** | Fastify for HTTP routes (room create, glossary CRUD), `ws` for the realtime hub. Avoid Socket.IO — extra protocol you don't need. |
| Storage | **SQLite via `better-sqlite3`** on the Render disk | Zero ops. Render's managed Postgres free tier expires after 30 days and you don't need it. Turso would be the only reasonable remote alternative. |
| STT | **Deepgram Nova-3 Multilingual** (`model=nova-3&language=multi`), streaming WebSocket | Sub-300 ms first-partial; JA support GA'd in 2025; built-in `endpointing` and `UtteranceEnd` for free server-side safety-net VAD; $200 free credit covers the whole month. JA WER is "Tier 2" (≈7–16 % band per Deepgram's own multilingual guide) which is adequate when you're also injecting proper nouns via the context box. |
| STT fallback | `gpt-4o-transcribe` via OpenAI Realtime transcription-only session | Higher JA accuracy ceiling (top-tier on FLEURS per OpenAI; ~2.5 % EN, estimated 8–12 % JA) but first-partial latency runs 500 ms–2 s per community reports — worse than Deepgram. Keep it behind a provider flag so you can A/B on your own family's voices. |
| Translation | **Gemini 2.5 Flash (non-reasoning) via Google AI Studio API**, streaming | Best time-to-first-token at your input size (~**0.47 s** TTFT, **180 tok/s** per Artificial Analysis), top-cluster JA↔EN quality per Intento 2025 and WMT24-era benchmarks, full natural-language system prompt so your "context box" of proper nouns, relationships, and in-jokes drops in trivially. GPT-4.1-mini is the runner-up (≈0.9 s TTFT, 80 tok/s, comparable quality). **Skip DeepL** — its glossary is exact-match, `custom_instructions` caps at 10×300 chars, and enabling it forces the slower `quality_optimized` model with no token streaming. |
| TTS | **Cartesia Sonic-2**, WebSocket streaming, PCM 22.05 kHz output | ~90 ms time-to-first-audio (vendor + partner testing), native Japanese voices (6+ explicitly ja-tagged), fully multilingual voice IDs so **one voice_id per speaker covers both languages**. **Startup plan $49/mo, 1.25 M credits** fits in budget with headroom. ElevenLabs Flash v2.5 is the runner-up at ~75 ms model inference / ~150–200 ms real TTFB and a much larger JA voice library, but its Creator tier ($22) only gets you ~200 k Flash chars and you'll go over fast at scale. |
| All-in-one Realtime/Live | **Explicitly rejected** | OpenAI's own translation cookbook (`one_way_translation_using_realtime_api`) runs **one Realtime session per target language** — that's 2× cost for a 2-language room and blocks distinct-per-speaker voices because each session has one voice. Gemini Live has the same per-session voice/target limitation. At 2 sessions, Realtime costs ~$0.40–0.60/min; our pipeline costs ~$0.04–0.08/min. |

Everything else — persistence, auth, room codes — goes in SQLite, and the "auth" is the unguessable 6-character Crockford-base32 room code in the URL the QR encodes.

## Text architecture diagram

```
                ┌───────────────── iPhone (PWA, foreground) ─────────────────┐
                │                                                            │
                │  getUserMedia ─► AudioWorklet ─► silero-vad ─► PCM16 16k   │
                │                                             │              │
                │                                             ▼              │
                │              TranscriptUI ◄───── WebSocket (binary+JSON)   │
                │              AudioPlayback ◄──────────  │        ▲         │
                └──────────────────────────────────────────┼────────┼────────┘
                                                           │        │
                                                           ▼        │
             ┌──────────────── Render Node server (Fastify + ws) ───┴───────┐
             │                                                              │
             │  RoomHub ──► per-room state                                  │
             │       │                                                      │
             │       ├─► Deepgram Nova-3 WSS (one per active speaker)       │
             │       │        │ interim + final transcripts                 │
             │       │        ▼                                             │
             │       ├─► Gemini 2.5 Flash (streaming, one call per target   │
             │       │   language present in the room, with glossary +     │
             │       │   context box of **speaker's** room-mates injected) │
             │       │        │ streamed text tokens                        │
             │       │        ▼                                             │
             │       ├─► Cartesia Sonic-2 WSS (one generation per target    │
             │       │   language, speaker's assigned voice_id)             │
             │       │        │ streamed PCM frames                         │
             │       │        ▼                                             │
             │       └─► Fan-out: push translated audio to each listener   │
             │           whose lang ≠ speaker and whose "hear audio" = on; │
             │           push transcript (in listener's chosen lang) to ALL│
             │                                                              │
             │  SQLite (better-sqlite3, on /data) ◄── glossary, turns,      │
             │                                        corrections           │
             └──────────────────────────────────────────────────────────────┘
```

Key architectural choice: **STT is server-side**, not client. Web Speech API on iOS Safari is a non-starter — it routes to Apple's server-side ASR with no streaming partials guarantee, no control over model, and historically flaky inside installed PWAs. You own the audio path from Worklet to server.

### Utterance commit: what listeners see vs what the speaker sees

Product choice for this app: **fast, partial source text for the speaker only**; **stable translated text + voice for everyone else**.

| Path | When | Speaker | Listeners |
|------|------|---------|-----------|
| **Live STT** | While talking (`STT_STREAM` + `LIVE_CAPTIONS`) | Debounced **interim transcripts** (`transcript.live`) so they can read what the model thinks they said. | **No** `transcript.live`. Partial translations are confusing and often wrong; listeners should not see them. |
| **Phrase-final (streaming)** | After each Deepgram `is_final` slice while mic is open (`STT_STREAM=1`) | Same live draft as above until that phrase locks. | **`transcript.chunk`** + **`audio.chunk`** for **that phrase only** (one translate + one TTS per phrase). |

**Important:** a “phrase” here is **whatever Deepgram finalizes after a stretch of speech plus silence** (`endpointing`), **not** a guaranteed English sentence. A question like “What’s your favorite color?” often gets an `is_final` at a **short pause** before “If it’s blue…”, so you may see two clips for one rhetorical sentence. Raising **`DEEPGRAM_LIVE_ENDPOINTING_MS`** (e.g. 500–900) on the server waits for **longer silence** before closing a phrase, which reduces those splits at the cost of slightly later delivery. There is no free “true sentence” detector in this path—true sentence boundaries would need heavier client logic or a different STT contract.

| **Turn end** | After `turn.stop` | May receive a **final short remainder** chunk if the closing transcript extends the last phrase. | **`debug.turn`** summarizes the full utterance; no duplicate TTS if phrases already covered the transcript. |

Optional **`UTTERANCE_COMMIT_DELAY_MS`** on the server: short pause after the client ends the turn (before resolving STT → translate → TTS) so trailing streaming STT frames can settle; tune per language (e.g. ~1000–1500 ms for Japanese) without changing client code. Default 0 keeps dev/tests snappy.

Each **phrase** that Deepgram finalizes during streaming triggers **one** translate + **one** TTS per target language; the client queues clips in order. A long monologue is many such passes; a single burst with no internal `is_final` is still **one** pass at `turn.stop`.

## Latency budget, in real numbers

End-to-end from "speaker stops talking" to "first translated audio plays in listener's earbuds":

| Stage | Time | Source |
|---|---|---|
| Client silero-vad detects speech-end | 200–400 ms | `redemptionFrames` default ~24 @ 16 kHz ≈ 384 ms |
| Last PCM chunk over WS to Render | 30–80 ms | Typical TLS WS RTT home-to-cloud |
| Deepgram Nova-3 emits final (we actually use the last interim, arriving earlier) | 200–400 ms after speech-end | Deepgram docs: <300 ms median streaming latency |
| **Gemini 2.5 Flash first token** | 470–500 ms | Artificial Analysis median TTFT |
| Gemini streams to ~75 output tokens | +400 ms (180 tok/s) | AA output speed |
| **Cartesia Sonic-2 first audio byte** (we pipe tokens in as they stream) | ~90 ms after first tokens arrive | Cartesia + partner measurements |
| Audio frame hits listener speaker | +30–80 ms | WS + AudioContext scheduling |

**Realistic total (speech-end → first audible audio on listener): ~1.0–1.4 s.** First translated *text* appears in the transcript UI ~500–700 ms earlier because we render Gemini tokens as they stream, in parallel with kicking off TTS.

**Bottleneck: LLM translation TTFT.** Deepgram's ~300 ms final and Cartesia's ~90 ms TTFB are both tight. Gemini's ~500 ms TTFT is the single largest contributor. Mitigations: (1) start translation on the **interim** transcript once ~80 % of the utterance is in, not the final, letting translate and STT-finalize overlap; (2) keep the context-box prompt short (≤500 tokens) to minimize prefill; (3) if you have a spare week, try Groq-hosted Llama 3.3 70B or Cerebras-hosted models — both can cut TTFT below 200 ms and are worth an A/B.

## Cost estimate, opinionated and concrete

**Scenario given: 4 people, 60 min, 600 utterances × 5 s speech, 50 min total speech, one session.**

Assume a 2-EN / 2-JA room, so each utterance produces exactly 1 translation + 1 TTS generation.

| Line | Calculation | Cost / session |
|---|---|---|
| Deepgram Nova-3 multilingual streaming | 50 min × $0.0092 | **$0.46** |
| Gemini 2.5 Flash translate | 600 × (~650 input tok × $0.30/M + ~75 output tok × $2.50/M) | **$0.23** |
| Cartesia Sonic-2 TTS (PAYG rate for math) | 600 utt × ~100 chars × $30/M chars | **$1.80** |
| Render infra (amortized per session at ~20 sessions/mo) | $7 / 20 | $0.35 |
| **Per-session total** | | **~$2.84** |

**Monthly (scenario: "low thousands of turns" = ~20 hour-long sessions, ~12 k utterances):**

| Line | Monthly |
|---|---|
| Deepgram (~1000 min/month) | **$9** (or $0 during the first $200 of free credit, which lasts the whole month) |
| Gemini 2.5 Flash | **~$4–5** |
| **Cartesia Startup plan ($49/mo, 1.25 M credits ≈ 1.25 M chars)** | **$49 flat** — covers ~12 k × 100-char utterances with ~50 k chars headroom |
| Render Starter + disk | **$7.25** |
| Domain (optional) | $0–$15 |
| **All-in monthly** | **~$70–90** |

This is comfortably under "a few hundred dollars." If your real volume lands at half this, drop Cartesia to PAYG ($30/M chars on their new generative-voice pricing, or pay about $19 for ~600k chars) and you land around **$40–50/mo total**.

**Flat-fee callouts you should know about:**
- **LiveKit Cloud free tier** (5 k connection-min, 50 GB bandwidth) would cover this app trivially — but the architecture doesn't fit their SFU model well for per-listener-different audio, so you'd fight the tool. Not recommended here.
- **ElevenLabs Creator $22/mo** = 200 k Flash chars. Enough for ~10 sessions/mo. Usable if you cut TTS volume or you'd rather have their larger JA voice library; otherwise Cartesia Startup is strictly better value.
- **Render free web service** spins down after 15 min idle and WebSockets die — must use the $7 tier.
- **Deepgram $200 credit** is the biggest freebie by far; at these volumes it's effectively a free STT month.

## Cursor/Claude feasibility, honestly

Claude-in-Cursor will one-shot or near-one-shot most of this. The gotchas cluster on iOS Safari PWA behavior and WebSocket-audio plumbing — those need a human with a phone in hand, not just Cursor.

**One-shot territory** (Cursor will nail it on the first or second prompt):
- Vite + React + TypeScript scaffold, `vite-plugin-pwa` manifest, room-code generation, basic Fastify + `ws` server, SQLite schema, Deepgram WebSocket client in Node, Gemini translate per committed utterance (full string in, full string out), Cartesia HTTP/bytes one-shot TTS per line, QR code generation (use `qrcode` npm package on an `/r/:id` landing page).
- React UI for per-user language picker, hear-audio toggle, context-box textarea, live-transcript list, PTT button.
- Room-level state machine on the server.

**Needs iteration and manual testing on a real iPhone** (expect 2–4 attempts per item):
- **iOS PWA install UX + the AudioContext unlock dance.** You *must* call `audioCtx.resume()` inside a synchronous user-gesture handler, and iOS 17 has had regressions where the context re-suspends (WebKit #261554, #263627). Ship a visible "Reconnect audio" button that calls `audioContext.close()` and creates a fresh one — users will hit the suspend bug. iOS 26.0.1 (Oct 2025) also broke PWA audio playback for many users; build in a retry path.
- **Mic stream lifetime across route changes.** WebKit bug #212040 causes `MediaStreamTrack.muted = true` when a standalone PWA's URL changes. Hoist `getUserMedia` to app root; never navigate in a way that unmounts the owner.
- **Background/lock behavior.** Audio WILL stop when the screen locks or the PWA is backgrounded. The HTML `<audio>` 30-second timeout kills the session permanently until reopen. Wake Lock API is **not supported on iOS Safari** (open WebKit bug #254545, 2+ years unresolved). Your only realistic mitigations are (a) an onboarding modal that tells users to disable auto-lock, or (b) a near-silent loop trick via `<audio>` that sometimes keeps the tab alive (unreliable; don't trust it). Design around "PWA must be foreground and unlocked for the duration."
- **AudioWorklet sample-count bug** (WebKit #251350, iOS 15.6–16.2) occasionally delivers fewer samples than requested. Status on iOS 17+ unclear; use timestamp-based buffering, not sample-count math.
- **MediaRecorder on iOS only does MP4/AAC** — not Opus/WebM. That's why the stack uses AudioWorklet → raw PCM → WebSocket, bypassing MediaRecorder entirely. Saves one class of bugs.

**Real plumbing work** (Claude writes it, you debug over a day or two):
- **Streaming WebSocket audio with backpressure.** Node `ws` doesn't apply TCP-level backpressure automatically when you write faster than the client drains. Watch `ws.bufferedAmount` before pushing next TTS frame; drop or coalesce if it grows.
- **Reconnection with session resume.** When the iPhone backgrounds and returns, the WS is often dead. Implement resumable sessions keyed by a client-side token; server replays the last N transcript events on reconnect. **Current behavior:** each reconnect gets a **new `clientId`**; the server **drops in-flight mic turns** when the **speaker’s** socket closes, so the speaker must **stop and start mic again** after reconnect. If only the listener reconnects, the speaker’s session continues.
- **Piping Gemini tokens → Cartesia in real time.** This app **does not** stream translation into TTS mid-utterance: one committed sentence → one translate call → one Cartesia (or OpenAI) synthesis. If you later want minimum latency for other products, you could shovel Gemini stream into Cartesia's streaming input; that is intentionally out of scope here.

**Genuinely tricky** (plan for a day of yak-shaving):
- **silero-vad in a PWA on iOS.** The library works in Safari, but you need to serve the ONNX model and Worklet bundle from your origin (not jsDelivr) for PWA offline-install reliability, and tune thresholds for Japanese. If it fights back, ship with PTT default-on.
- **Voice assignment UI.** Keep it simple: map the first 6 Cartesia Japanese voice UUIDs to speaker slots 1–6 on room creation; let users rename their slot if they care.

**Things Cursor will *not* help with:** the iOS version-to-version audio regressions. There's no training data for "iOS 26.0.1 broke X." You'll diagnose those yourself with a spare iPhone.

## Glossary / context learning loop

Simplest design that actually works:

**Storage (SQLite):** three tables — `glossary(user_id, term, translation, notes)` for the context box entries, `turns(room_id, ts, speaker, src_lang, src_text, tgt_lang, tgt_text)` as an audit log, and `corrections(user_id, wrong, right, context)` for post-hoc fixes ("that was Hiroko, not Hiroshi"). Edit the context box → upsert glossary rows. Tap "fix this" on a mistranslated transcript → insert into corrections.

**Prompt injection (Gemini system prompt template, regenerated per utterance):**

```
You are a real-time JA↔EN interpreter for a family conversation.
Translate from {src_lang} to {tgt_lang}. Output ONLY the translation.

People in this room (with pronunciations and relationships):
{speaker_context_box}
{listener_context_boxes_merged}

Established corrections (apply these):
{top 20 corrections by recency, as "«wrong» should be «right» (context)"}

Recent turns (for coreference):
{last 3 turns, source + target}

Register: casual family chat. Preserve proper nouns and code-switched words as-is.
```

That's it. Regenerate the prompt each turn — at 500–800 tokens it costs fractions of a cent. **No MCP server.** MCP is for giving AI assistants tools at inference time; your translation LLM doesn't need tools, it needs strings in its prompt. Using MCP during *development* to let Cursor introspect live app state is cute but not worth the ceremony for a one-month project.

Cross-session learning is just "read the corrections table at room-join and include the top N." No embeddings, no retrieval. At low-thousands of corrections lifetime, exact text matching with a recency weight is fine and more predictable than a vector store.

## Build sequence

Nine steps, roughly a weekend each if you're working evenings, tighter if you go straight through.

1. **Scaffold and deploy an empty room.** Vite + React + TypeScript client; Fastify + `ws` server on Render Starter; SQLite file on `/data`. Route `/r/:id` renders a join page. Room code generator. QR via `qrcode` on the create page. Prove: two devices can open the same room URL and exchange a "hello" chat message over WebSocket. *Do this first because every debugging loop afterward depends on this working.*

2. **Mic capture to server round-trip.** AudioWorklet emitting 16 kHz PCM16, binary-framed to server, server logs chunk sizes. Test on a real iPhone PWA install, not just desktop Safari. Handle the AudioContext unlock gesture. Do not move on until audio reliably flows on iOS home-screen install.

3. **Plug in Deepgram Nova-3.** Open one WSS per active speaker. Display interim transcripts live in the speaker's own UI (self-monitor). Validate JA and EN both work. Add the UtteranceEnd safety net.

4. **Add silero-vad + PTT toggle.** VAD drives start/stop of the STT window on the client; PTT button as manual override. Tune Japanese thresholds with your actual family voices.

5. **Wire Gemini 2.5 Flash translation.** Use **non-streaming translation per committed utterance** for listeners (one complete target string per turn). The speaker may still see **streaming source** STT in their own UI only; listeners only see the final `transcript.chunk`.

6. **Wire Cartesia Sonic-2 TTS.** Assign the first 6 JA voices to speaker slots. For each committed translated line, call TTS **once** for the full string; send **one** audio payload per listener per turn over your WebSocket. Client playback queues clips **sequentially** (sentence by sentence). Optional small jitter buffer (~80 ms) only if measuring underruns on device.

7. **Context box + glossary injection.** Per-user textarea in settings; persisted to SQLite; merged into the Gemini system prompt. Add a "fix this" affordance on transcript rows that writes to `corrections`.

8. **Polish the iOS PWA edges.** Manifest tweaks, icons, install prompt, "keep screen on" warning modal, reconnect button, WebSocket resume logic, `navigator.onLine` banner, "hear audio" toggle actually mutes playback without killing the transcript stream.

9. **Room-scaling to 3–6 participants, and then use it with your family.** Multiple concurrent STT streams, fan-out of TTS to all eligible listeners, per-target-language translation deduplication (one translate call per target language, not per listener). Ship.

## What I'd do differently only if X

- **If the family turns out to be heavily monolingual with one bilingual pivot:** drop to a single-direction model and consider OpenAI's Realtime translation cookbook pattern — one session per target language is bearable when there's only one target.
- **If Japanese WER from Deepgram disappoints in your first week:** swap STT to OpenAI `gpt-4o-transcribe` via the Realtime API behind the same interface. Expect +500–1000 ms latency but materially better JA.
- **If latency feels slow despite the pipeline:** the fix is almost always the translate step. Try Groq- or Cerebras-hosted inference for Gemma/Llama of comparable quality — they regularly deliver sub-200 ms TTFT, which would shave 300 ms off end-to-end.
- **If you outgrow "personal use" and go to many concurrent rooms:** revisit LiveKit Cloud + Agents, whose free tier and pipeline recipes genuinely shine once you're managing dozens of sessions — but only if you relax the per-listener-different-language requirement.

## Bottom line

The answer to your real question — *what would I build if it were mine?* — is: **Vite + React PWA, Node + `ws` on Render Starter, silero-vad + PTT, Deepgram Nova-3 Multilingual, Gemini 2.5 Flash, Cartesia Sonic-2, SQLite for glossary.** ~$70–90 a month, ~1.0–1.4 s speech-end to translated-audio, Cursor can scaffold 80 % of it, the remaining 20 % is iOS audio quirks you'll only catch on-device. Build in the order above; the first weekend ends with two iPhones in the same room exchanging typed messages, and each subsequent stage replaces one piece with the real thing.