// .uvs/reasoningCheck.js
// Text-only plausibility reasoning fallback

const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function reasoningValidate(payload, model) {
  const res = await groq.chat.completions.create({
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
