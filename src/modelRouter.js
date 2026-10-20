/**
 * ============================================================================
 * MODULE: modelRouter.js
 * PURPOSE: Handles AI model routing and execution.
 *          Implements 3-Stage Batch Fallback for OCR & Vision processing:
 *            Stage 1: First 4 Gemini keys (sent in parallel, first to succeed wins)
 *            Stage 2: Next 5 Gemini keys (sent in parallel, first to succeed wins)
 *            Stage 3: OpenRouter API (Minimax vision model)
 *          Also provides text-based reasoning via Groq with round-robin key rotation.
 * ============================================================================
 */

const axios = require("axios");
const Groq  = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");

// ─── GROQ KEYS ROTATION (Reasoning) ───
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_ONE,
  process.env.GROQ_API_KEY_TWO,
  process.env.GROQ_API_KEY_THREE,
  process.env.GROQ_API_KEY_FOUR,
  process.env.GROQ_API_KEY_FIVE,
  process.env.GROQ_API_KEY_SIX,
  process.env.GROQ_API_KEY_SEVEN,
  process.env.GROQ_API_KEY_EIGHT,
].filter(Boolean);

let groqKeyIndex = 0;
function getNextApiKey() {
  if (GROQ_KEYS.length === 0) return null;
  const key = GROQ_KEYS[groqKeyIndex % GROQ_KEYS.length];
  groqKeyIndex++;
  return key;
}

// ─── GEMINI KEYS & OPENROUTER ───
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_ONE,
  process.env.GEMINI_API_KEY_TWO,
  process.env.GEMINI_API_KEY_THREE,
  process.env.GEMINI_API_KEY_FOUR,
  process.env.GEMINI_API_KEY_FIVE,
  process.env.GEMINI_API_KEY_SIX,
  process.env.GEMINI_API_KEY_SEVEN,
  process.env.GEMINI_API_KEY_EIGHT,
  process.env.GEMINI_API_KEY_NINE || process.env.GEMINI_API_NINE,
].filter(Boolean);

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "minimax/minimax-m3.1-flash:free";
const OPENROUTER_ENDPOINT = process.env.OPENROUTER_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions";

function parseMaybeJson(content) {
  if (!content || typeof content !== "string") {
    throw new Error("Cannot parse empty content as JSON");
  }

  // Strip reasoning block if present
  let cleaned = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();

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
    throw new Error(`Failed to parse JSON. Content was: ${content.slice(0, 200)}... Error: ${e.message}`);
  }
}

/**
 * Builds the inline contents array for Gemini SDK.
 * @param {Array<{base64: string, mimeType: string}>} images
 * @param {string} prompt
 */
function buildGeminiContents(images, prompt) {
  const contents = [];
  for (const img of images) {
    contents.push({
      inlineData: {
        data: img.base64,
        mimeType: img.mimeType || "image/jpeg"
      }
    });
  }
  contents.push(prompt);
  return contents;
}

/**
 * Executes a single request to Gemini via the @google/genai SDK.
 */
async function sendToGeminiKey(apiKey, prompt, images) {
  const ai = new GoogleGenAI({ apiKey });
  const contents = buildGeminiContents(images, prompt);

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite",
    contents,
    config: {
      responseMimeType: "application/json"
    }
  });

  return parseMaybeJson(response.text);
}

/**
 * Races a batch of keys concurrently using Promise.any.
 * Returns the first key that succeeds with parsed JSON.
 */
async function executeBatchOfGeminiKeys(keys, batchName, prompt, images) {
  if (!keys || keys.length === 0) {
    throw new Error(`[Batch ${batchName}] No keys configured.`);
  }

  console.log(`[ModelRouter] [${batchName}] Dispatching batch of ${keys.length} keys in parallel...`);

  const promises = keys.map(async (key, index) => {
    try {
      const res = await sendToGeminiKey(key, prompt, images);
      console.log(`[ModelRouter] [${batchName}] Key ending in ...${key.slice(-6)} (index ${index + 1}) succeeded!`);
      return res;
    } catch (err) {
      console.warn(`[ModelRouter] [${batchName}] Key ending in ...${key.slice(-6)} (index ${index + 1}) failed: ${err.message}`);
      throw err;
    }
  });

  try {
    return await Promise.any(promises);
  } catch (aggregateErr) {
    console.warn(`[ModelRouter] [${batchName}] All ${keys.length} keys in this batch failed.`);
    throw aggregateErr;
  }
}

/**
 * Fallback to OpenRouter using OpenAI-compatible vision chat completion.
 */
async function sendToOpenRouter(prompt, images) {
  if (!OPENROUTER_KEY) {
    throw new Error("OpenRouter API key is not configured.");
  }

  console.log(`[ModelRouter] [Stage 3] Dispatching to OpenRouter using model "${OPENROUTER_VISION_MODEL}"...`);

  const contentItems = [{ type: "text", text: prompt }];
  for (const img of images) {
    contentItems.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType || "image/jpeg"};base64,${img.base64}`
      }
    });
  }

  const response = await axios.post(
    OPENROUTER_ENDPOINT,
    {
      model: OPENROUTER_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: contentItems
        }
      ],
      temperature: 0.1,
      max_tokens: 1024
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_KEY}`
      },
      timeout: 30000
    }
  );

  const text = response.data?.choices?.[0]?.message?.content;
  return parseMaybeJson(text);
}

/**
 * Executes a vision prompt with 3-Stage Fallback:
 *  Stage 1: First 4 Gemini keys (sent in parallel batch, first to succeed wins)
 *  Stage 2: Next 5 Gemini keys (sent in parallel batch, first to succeed wins)
 *  Stage 3: OpenRouter API key
 *
 * @param {string} prompt
 * @param {Array<{base64: string, mimeType: string}>} images
 */
async function executeVisionPipeline(prompt, images) {
  const stage1Keys = GEMINI_KEYS.slice(0, 4);
  const stage2Keys = GEMINI_KEYS.slice(4, 9);

  let lastError = null;

  // ── Stage 1: First 4 Gemini keys ───────────────────────────────────────────
  if (stage1Keys.length > 0) {
    try {
      console.log("[ModelRouter] [Stage 1/3] Attempting first 4 Gemini keys in parallel...");
      const result = await executeBatchOfGeminiKeys(stage1Keys, "Stage 1 (Keys 1-4)", prompt, images);
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  // ── Stage 2: Next 5 Gemini keys ────────────────────────────────────────────
  if (stage2Keys.length > 0) {
    try {
      console.log("[ModelRouter] [Stage 2/3] Attempting next 5 Gemini keys in parallel...");
      const result = await executeBatchOfGeminiKeys(stage2Keys, "Stage 2 (Keys 5-9)", prompt, images);
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  // ── Stage 3: OpenRouter ────────────────────────────────────────────────────
  if (OPENROUTER_KEY) {
    try {
      console.log("[ModelRouter] [Stage 3/3] Attempting OpenRouter fallback...");
      const result = await sendToOpenRouter(prompt, images);
      return result;
    } catch (err) {
      lastError = err;
      console.error("[ModelRouter] [Stage 3/3] OpenRouter failed:", err.message);
    }
  } else {
    console.warn("[ModelRouter] Stage 3 skipped: OPENROUTER_API_KEY not configured.");
  }

  console.error("❌ All 3 stages of vision fallback failed. Last error:", lastError?.message);
  return null;
}

/**
 * Single-image vision fallback helper (backward compatible).
 */
async function extractWithFallback(prompt, base64Image, imageUrl = null, mimeType = "image/jpeg") {
  return executeVisionPipeline(prompt, [{ base64: base64Image, mimeType }]);
}

// Text-only reasoning — groq-sdk is fine here (no large payloads)
async function analyzeRunsWithReasoning(prompt) {
  try {
    const apiKey = getNextApiKey() || process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("❌ Reasoning analysis failed: Missing GROQ_API_KEY in .env");
      return null;
    }

    const currentGroq = new Groq({ apiKey });

    const res = await currentGroq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      temperature: 0.2,
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }]
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error("Reasoning analysis failed:", err.message);
    return null;
  }
}

module.exports = {
  extractWithFallback,
  executeVisionPipeline,
  analyzeRunsWithReasoning,
  GEMINI_KEYS,
  OPENROUTER_KEY
};
