// .uvs/reasoningCheck.js
// Text-only plausibility reasoning fallback

const Groq = require("groq-sdk");
// ─── GROQ KEYS ROTATION ───
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_ONE,
  process.env.GROQ_API_KEY_TWO,
  process.env.GROQ_API_KEY_THREE,
  process.env.GROQ_API_KEY_FOUR,
  process.env.GROQ_API_KEY_FIVE,
  process.env.GROQ_API_KEY_SIX,
].filter(Boolean);

let keyIndex = 0;
function getNextApiKey() {
  if (GROQ_KEYS.length === 0) return null;
  const key = GROQ_KEYS[keyIndex % GROQ_KEYS.length];
  keyIndex++;
  return key;
}

async function reasoningValidate(payload, model) {
  const apiKey = getNextApiKey() || process.env.GROQ_API_KEY;
  const currentGroq = new Groq({ apiKey });
  const res = await currentGroq.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `
Check if these run stats are logically consistent.
Reply ONLY with JSON: { "ok": true } or { "ok": false, "reason": "..." }

DATA:
${JSON.stringify(payload)}
`
      }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}

async function reasoningFallback(payload) {
  // 1️⃣ GPT OSS 20B
  try {
    return await reasoningValidate(payload, "gpt-oss-20b");
  } catch {}

  // 2️⃣ Qwen 3 32B
  try {
    return await reasoningValidate(payload, "qwen-3-32b");
  } catch {}

  return { ok: false, reason: "Reasoning models failed" };
}

module.exports = { reasoningFallback };
