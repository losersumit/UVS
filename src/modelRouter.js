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
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

async function runVision(prompt, base64Image, model) {
  const isQwen = model.startsWith("qwen");
  const options = {
    model,
    temperature: 0.1,
    max_tokens: isQwen ? 2048 : 512, // Qwen needs extra tokens to output the thinking block first
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
  };

  // Only use response_format JSON mode for non-Qwen models to avoid 400 validation errors on Qwen reasoning models
  if (!isQwen) {
    options.response_format = { type: "json_object" };
  }

  const res = await groq.chat.completions.create(options);
  return parseMaybeJson(res.choices[0].message.content);
}

async function extractWithFallback(prompt, base64Image) {
  // 1️⃣ Primary — Qwen
  try {
    return await runVision(
      prompt,
      base64Image,
      "qwen/qwen3.6-27b"
    );
  } catch (err) {
    console.warn("Qwen failed, trying Scout...");
  }

  // 2️⃣ Fallback — Scout
  try {
    return await runVision(
      prompt,
      base64Image,
      "meta-llama/llama-4-scout-17b-16e-instruct"
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
