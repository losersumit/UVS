// .uvs/modelRouter.js
// Handles Vision model fallback (Scout → Maverick)

const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function runVision(prompt, base64Image, model) {
  const res = await groq.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Image}` }
          }
        ]
      }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}

async function extractWithFallback(prompt, base64Image) {
  // 1️⃣ Primary — Scout
  try {
    return await runVision(
      prompt,
      base64Image,
      "meta-llama/llama-4-scout-17b-16e-instruct"
    );
  } catch (err) {
    console.warn("Scout failed, trying Maverick...");
  }

  // 2️⃣ Fallback — Maverick
  try {
    return await runVision(
      prompt,
      base64Image,
      "meta-llama/llama-4-maverick-17b-128e-instruct"
    );
  } catch (err) {
    console.error("Vision fallback failed:", err.message);
    return null;
  }
}

async function analyzeRunsWithReasoning(prompt) {
  try {
    if (!process.env.GROQ_API_KEY) {
      console.error("❌ Reasoning analysis failed: Missing GROQ_API_KEY in .env");
      return null;
    }

    const res = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      temperature: 0.2, // Low temp for more factual analysis
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error("Reasoning analysis failed:", err.message);
    return null;
  }
}

module.exports = { extractWithFallback, analyzeRunsWithReasoning };
