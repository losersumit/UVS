/**
 * ============================================================================
 * MODULE: modelRouter.js
 * PURPOSE: Handles API connections to the Groq LLM inference engine. Serves
 *          as the routing layer for AI features, including Vision and Reasoning.
 *          Implements model fallback (Qwen -> Scout) for stability.
 * ============================================================================
 */
// .uvs/src/modelRouter.js

const Groq = require("groq-sdk");
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  timeout: 60 * 1000, // 60s — Railway has higher latency than local; default 10s times out on large images
});

function parseMaybeJson(content) {
  // Strip reasoning block if present
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  
  // Strip markdown code fences if present
  cleaned = cleaned.replace(/```json\s*([\s\S]*?)\s*```/g, "$1").trim();
  cleaned = cleaned.replace(/```\s*([\s\S]*?)\s*```/g, "$1").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (innerErr) {
        throw new Error("Extracted text is not valid JSON: " + match[0]);
      }
    }
    throw e;
  }
}

/**
 * runVision — calls a Groq vision model.
 * @param {string} prompt
 * @param {string} imageSource  — base64 string OR a public https:// URL
 * @param {string} model
 * @param {"base64"|"url"} imageMode  — how to pass the image to the API
 */
async function runVision(prompt, imageSource, model, imageMode = "base64") {
  const isQwen = model.startsWith("qwen");

  // Build the image content part based on the delivery mode
  const imagePart = imageMode === "url"
    ? { type: "image_url", image_url: { url: imageSource } }
    : { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageSource}` } };

  const options = {
    model,
    temperature: 0.1,
    // Qwen needs extra tokens to emit its <think> block before the JSON
    max_tokens: isQwen ? 2048 : 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          imagePart
        ]
      }
    ]
  };

  // JSON mode only on non-Qwen — Qwen reasoning models return a 400 with it
  if (!isQwen) {
    options.response_format = { type: "json_object" };
  }

  const res = await groq.chat.completions.create(options, { timeout: 30000 });
  return parseMaybeJson(res.choices[0].message.content);
}

/**
 * extractWithFallback
 * @param {string} prompt
 * @param {string} base64Image  — always provided; Scout will use the URL instead
 * @param {string} [imageUrl]   — original Discord CDN URL, used by Scout to avoid 4MB base64 limit
 */
async function extractWithFallback(prompt, base64Image, imageUrl) {
  // 1️⃣ Primary — Scout via URL (fast, stable; 20MB URL limit, no base64 cap issue)
  try {
    if (!imageUrl) throw new Error("No image URL available for Scout.");
    return await runVision(prompt, imageUrl, "meta-llama/llama-4-scout-17b-16e-instruct", "url");
  } catch (err) {
    console.warn("Scout failed, trying Qwen...", err.message);
  }

  // 2️⃣ Fallback — Qwen via base64
  try {
    return await runVision(prompt, base64Image, "qwen/qwen3.6-27b", "base64");
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
