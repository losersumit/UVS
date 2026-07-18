/**
 * ============================================================================
 * MODULE: modelRouter.js
 * PURPOSE: Handles API connections to the Groq LLM inference engine. Serves
 *          as the routing layer for AI features, including Vision and Reasoning.
 *          Implements model fallback (Scout -> Qwen) for stability.
 *
 * NOTE: Vision calls use axios.post directly (not the groq-sdk) — this matches
 *       the proven pattern used by the worker bot and avoids the fetch-based
 *       timeout issues the SDK has on Railway for large image payloads.
 * ============================================================================
 */
// .uvs/src/modelRouter.js

const axios = require("axios");
const Groq  = require("groq-sdk");

// SDK is only used for text-only reasoning (no large payloads, no timeout issue)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const VISION_TIMEOUT_MS = 30_000; // 30s — consistent with the worker bot

// ─── GROQ KEYS ROTATION ───
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

let keyIndex = 0;
function getNextApiKey() {
  if (GROQ_KEYS.length === 0) return null;
  const key = GROQ_KEYS[keyIndex % GROQ_KEYS.length];
  keyIndex++;
  return key;
}

function parseMaybeJson(content) {
  // Strip reasoning block if present (handles both closed and unclosed <think> tags)
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

// ─── GEMINI KEYS ROTATION ───
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_ONE,
  process.env.GEMINI_API_KEY_TWO,
  process.env.GEMINI_API_KEY_THREE,
  process.env.GEMINI_API_KEY_FOUR,
  process.env.GEMINI_API_KEY_FIVE,
  process.env.GEMINI_API_KEY_SIX,
  process.env.GEMINI_API_KEY_SEVEN,
  process.env.GEMINI_API_KEY_EIGHT,
].filter(Boolean);

let geminiKeyIndex = 0;
function getNextGeminiApiKey() {
  if (GEMINI_KEYS.length === 0) return null;
  const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
  geminiKeyIndex++;
  return key;
}

const { GoogleGenAI } = require("@google/genai");

/**
 * extractWithFallback — Calls Google Gemini API for fast, high-limit OCR/Vision.
 * Runs key rotation in round-robin and retries other keys on quota/failures.
 * @param {string}  prompt
 * @param {string}  base64Image
 * @param {string}  [imageUrl]
 */
async function extractWithFallback(prompt, base64Image, imageUrl) {
  const attemptsCount = GEMINI_KEYS.length > 0 ? GEMINI_KEYS.length : 1;
  let lastError = null;

  for (let attempt = 0; attempt < attemptsCount; attempt++) {
    const apiKey = getNextGeminiApiKey() || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("❌ Gemini Vision failed: No Gemini API Key configured.");
      return null;
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: [
          {
            inlineData: {
              data: base64Image,
              mimeType: "image/jpeg"
            }
          },
          prompt
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      return parseMaybeJson(response.text);
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Gemini API attempt ${attempt + 1}/${attemptsCount} failed using key ending in ...${apiKey ? apiKey.slice(-6) : "None"}: ${err.message}`);
      if (attempt < attemptsCount - 1) {
        // Wait briefly before retrying next key
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  console.error("❌ All Gemini API keys failed vision extraction. Last error:", lastError?.message);
  return null;
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

module.exports = { extractWithFallback, analyzeRunsWithReasoning };

