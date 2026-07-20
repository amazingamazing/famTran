/**
 * One-off: verify Gemini translation fallback model (gemini-3.5-flash) with the
 * same generateContent shape as production (thinkingLevel minimal for gemini-3*).
 *
 * Usage: node --use-system-ca scripts/verify-gemini-fallback.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FALLBACK_MODEL = "gemini-3.5-flash";

const loadKey = () => {
  if (process.env.GEMINI_API_KEY?.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  const envPath = resolve(ROOT, "server", ".env");
  if (!existsSync(envPath)) {
    throw new Error("GEMINI_API_KEY missing");
  }
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.*)$/);
    if (m) {
      return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("GEMINI_API_KEY not found");
};

const main = async () => {
  const key = loadKey();
  const prompt = [
    "Translate from en to ja.",
    "Output translation only, no explanation.",
    "",
    "Text: Good morning."
  ].join("\n");

  // Simulate fallback-path: primary fails (bogus model), then gemini-3.5-flash succeeds.
  const modelsToTry = ["gemini-model-that-does-not-exist-fallback-test", FALLBACK_MODEL];
  let used = null;
  let text = null;
  let latencyMs = null;

  for (const model of modelsToTry) {
    const t0 = Date.now();
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(model.startsWith("gemini-3")
        ? { generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } } }
        : {})
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.log(`FAIL primary/attempt model=${model} status=${res.status} ${ms}ms`);
      continue;
    }
    const payload = await res.json();
    const out = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    if (out) {
      used = model;
      text = out;
      latencyMs = ms;
      break;
    }
    console.log(`FAIL empty model=${model} ${ms}ms`);
  }

  if (used !== FALLBACK_MODEL || !text) {
    console.error("Fallback verification failed — gemini-3.5-flash did not return text");
    process.exit(1);
  }

  console.log(`OK fallback model=${used} latency=${latencyMs}ms translation=${JSON.stringify(text)}`);
  console.log(`path=translation.gemini_api:${used}:${latencyMs}ms`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
