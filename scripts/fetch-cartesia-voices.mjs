/**
 * One-off: list Cartesia voices for en/ja by gender, propose pool expansions
 * to 8 per gender per language, and verify newly added IDs with TTS bytes.
 *
 * Usage (from repo root):
 *   node --use-system-ca scripts/fetch-cartesia-voices.mjs
 *
 * Loads CARTESIA_API_KEY from the environment or server/.env.
 * On Windows, --use-system-ca avoids TLS leaf-certificate verification failures.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CARTESIA_VERSION = "2026-03-01";
const CARTESIA_BASE = "https://api.cartesia.ai";
const MODEL_ID = "sonic-3.5";

/** Existing audited pool entries — keep as first entries so assignments stay stable. */
const EXISTING = {
  en: {
    male: ["630ed21c-2c5c-41cf-9d82-10a7fd668370", "47c38ca4-5f35-497b-b1a3-415245fb35e1"],
    female: ["db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", "f786b574-daa5-4673-aa0c-cbe3e8534c02"]
  },
  ja: {
    male: ["30894953-bcce-41fe-892c-15ce19c843ff", "65209f8e-6140-4a20-b819-3cc2e21da19b"],
    female: ["d0ff6870-dd30-420d-8568-d756d806ea62", "498e7f37-7fa3-4e2c-b8e2-8b6e9276f956"]
  }
};

const TARGET_PER_POOL = 8;

const loadApiKey = () => {
  if (process.env.CARTESIA_API_KEY?.trim()) {
    return process.env.CARTESIA_API_KEY.trim();
  }
  const envPath = resolve(ROOT, "server", ".env");
  if (!existsSync(envPath)) {
    throw new Error(`CARTESIA_API_KEY not set and ${envPath} missing`);
  }
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*CARTESIA_API_KEY\s*=\s*(.*)$/);
    if (m) {
      return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("CARTESIA_API_KEY not found in env or server/.env");
};

/** Map our male/female pools to Cartesia GenderPresentation query values. */
const toCartesiaGender = (gender) => (gender === "male" ? "masculine" : "feminine");

const cartesiaHeaders = (apiKey) => ({
  "X-API-Key": apiKey,
  "Cartesia-Version": CARTESIA_VERSION,
  "Content-Type": "application/json"
});

const listVoices = async (apiKey, { language, gender }) => {
  const voices = [];
  let startingAfter = undefined;
  for (;;) {
    const url = new URL(`${CARTESIA_BASE}/voices`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("language", language);
    url.searchParams.set("gender", toCartesiaGender(gender));
    if (startingAfter) {
      url.searchParams.set("starting_after", startingAfter);
    }
    const res = await fetch(url, { headers: cartesiaHeaders(apiKey) });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`list voices failed: ${res.status} ${body}`);
    }
    const json = await res.json();
    const page = Array.isArray(json.data) ? json.data : [];
    voices.push(...page);
    if (!json.has_more || !json.next_page) {
      break;
    }
    startingAfter = json.next_page;
  }
  return voices;
};

const verifyTts = async (apiKey, voiceId, language) => {
  const transcript = language === "ja" ? "こんにちは。" : "Hello there.";
  const res = await fetch(`${CARTESIA_BASE}/tts/bytes`, {
    method: "POST",
    headers: cartesiaHeaders(apiKey),
    body: JSON.stringify({
      model_id: MODEL_ID,
      transcript,
      language,
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: 22050
      },
      voice: {
        mode: "id",
        id: voiceId
      }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, detail: `status=${res.status} ${body.slice(0, 200)}` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { ok: false, detail: "empty audio body" };
  }
  return { ok: true, detail: `audio_bytes=${bytes.byteLength}` };
};

const byId = (voices) => {
  const map = new Map();
  for (const v of voices) {
    map.set(v.id, v);
  }
  return map;
};

const main = async () => {
  const apiKey = loadApiKey();
  const langs = ["en", "ja"];
  const genders = ["male", "female"];

  /** @type {Record<string, Record<string, object[]>>} */
  const listed = {};
  for (const language of langs) {
    listed[language] = {};
    for (const gender of genders) {
      const voices = await listVoices(apiKey, { language, gender });
      listed[language][gender] = voices;
      console.log(`\n=== candidates ${language}/${gender} (${voices.length}) ===`);
      for (const v of voices) {
        console.log(`${v.id}\t${v.name}\t${v.gender}\t${v.language}`);
      }
    }
  }

  /** @type {Record<string, Record<string, { id: string, name: string, existing: boolean, verified?: string }[]>>} */
  const chosen = {};
  /** @type {{ id: string, name: string, language: string, gender: string, result: string }[]} */
  const verificationRows = [];

  for (const language of langs) {
    chosen[language] = {};
    for (const gender of genders) {
      const existingIds = EXISTING[language][gender];
      const catalog = byId(listed[language][gender]);
      const pool = [];

      for (const id of existingIds) {
        const meta = catalog.get(id);
        pool.push({
          id,
          name: meta?.name ?? "(existing audited, not in filtered list)",
          existing: true,
          verified: "kept (not re-verified)"
        });
      }

      const existingSet = new Set(existingIds);
      const candidates = listed[language][gender].filter((v) => !existingSet.has(v.id));

      for (const candidate of candidates) {
        if (pool.length >= TARGET_PER_POOL) {
          break;
        }
        const check = await verifyTts(apiKey, candidate.id, language);
        const row = {
          id: candidate.id,
          name: candidate.name,
          language,
          gender,
          result: check.ok ? `OK ${check.detail}` : `FAIL ${check.detail}`
        };
        verificationRows.push(row);
        console.log(
          `\nverify ${language}/${gender} ${candidate.id} (${candidate.name}): ${row.result}`
        );
        if (check.ok) {
          pool.push({
            id: candidate.id,
            name: candidate.name,
            existing: false,
            verified: row.result
          });
        }
      }

      if (pool.length < TARGET_PER_POOL) {
        throw new Error(
          `Could only fill ${language}/${gender} to ${pool.length}/${TARGET_PER_POOL} after TTS verification`
        );
      }
      chosen[language][gender] = pool;
    }
  }

  console.log("\n========== CHOSEN POOLS (8 each) ==========");
  for (const language of langs) {
    for (const gender of genders) {
      console.log(`\n${language}.${gender}:`);
      for (const entry of chosen[language][gender]) {
        const tag = entry.existing ? "EXISTING" : "NEW";
        console.log(`  [${tag}] ${entry.id}  ${entry.name}  (${entry.verified})`);
      }
    }
  }

  console.log("\n========== PASTE FOR providers.ts ==========");
  console.log("const CARTESIA_VOICES_JA = {");
  console.log(
    `  male: ${JSON.stringify(chosen.ja.male.map((e) => e.id))},`
  );
  console.log(
    `  female: ${JSON.stringify(chosen.ja.female.map((e) => e.id))}`
  );
  console.log("} as const;");
  console.log("const CARTESIA_VOICES_EN = {");
  console.log(
    `  male: ${JSON.stringify(chosen.en.male.map((e) => e.id))},`
  );
  console.log(
    `  female: ${JSON.stringify(chosen.en.female.map((e) => e.id))}`
  );
  console.log("} as const;");

  console.log("\n========== COMMIT MESSAGE BODY (new IDs) ==========");
  for (const row of verificationRows.filter((r) => r.result.startsWith("OK"))) {
    // Only report the ones that made it into a pool (first successes per slot).
    const inPool = chosen[row.language][row.gender].some((e) => e.id === row.id && !e.existing);
    if (inPool) {
      console.log(`${row.language}/${row.gender}: ${row.id}  ${row.name}  → ${row.result}`);
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
