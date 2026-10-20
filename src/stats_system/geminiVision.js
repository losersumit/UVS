// stats_system/geminiVision.js
const fs = require("fs");
const path = require("path");
const { extractWithFallback, executeVisionPipeline } = require("../modelRouter");

// Pre-load and cache the reference default job report
const DEFAULT_REPORT_PATH = path.resolve(__dirname, "../../deault_job_report.png");
let DEFAULT_REPORT_BASE64 = null;

function getDefaultReportBase64() {
  if (!DEFAULT_REPORT_BASE64) {
    if (fs.existsSync(DEFAULT_REPORT_PATH)) {
      DEFAULT_REPORT_BASE64 = fs.readFileSync(DEFAULT_REPORT_PATH).toString("base64");
    } else {
      console.warn(`[GeminiVision] Reference file not found at ${DEFAULT_REPORT_PATH}`);
    }
  }
  return DEFAULT_REPORT_BASE64;
}

function parseGameNumber(val) {
  if (val === undefined || val === null) return 0;
  let str = String(val).trim();
  if (str === "" || str === "-") return 0;
  
  // Strip all non-digit characters to handle thousands separators, currency signs, minus signs, etc.
  str = str.replace(/[^\d]/g, "");
  
  const num = parseInt(str, 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Step 1: Visual comparison between default_job_report.png and candidate image.
 * Sends BOTH images to the AI to confirm visual layout similarity.
 */
async function verifyVisualSimilarity(userBase64Image, userMimeType = "image/jpeg") {
  const refBase64 = getDefaultReportBase64();
  if (!refBase64) {
    console.warn("[GeminiVision] Reference default_job_report.png unavailable, bypassing image comparison step.");
    return { similar: true };
  }

  const prompt = `You are a strict visual layout anticheat verification system for the mobile game Truckers of Europe 3 (TOE3).
You are given two images:
- Image 1: Reference template of a genuine TOE3 "Job Finished" delivery summary screen (the authoritative example).
- Image 2: Candidate screenshot submitted by a player.

Your ONLY job is to decide whether Image 2 shares the same visual UI layout as Image 1 (a genuine TOE3 job finished screen).

Study Image 1 carefully. The TOE3 "Job Finished" screen has a distinctive visual fingerprint:
1. A HORIZONTAL CARD in the center of the screen with a colored gradient background (blue/purple tones).
2. A truck or trailer image physically placed on the LEFT side of the card, and another vehicle on the RIGHT side.
3. A LEVEL XP PROGRESS BAR running across the top of the card, with two level numbers on each end (e.g. "224 ——— 225").
4. A decorative BADGE or MEDALLION ICON centered above the card.
5. Stats laid out in a compact grid inside the card (distance, time, fuel, income, damage penalty, time penalty). There is NO detailed itemized reward table.
6. It is a mobile game UI — compact and card-based.

Image 2 must visually resemble Image 1's card-based layout to be accepted.

Acceptable differences in Image 2:
- Different language (Chinese, Turkish, Russian, German, etc.)
- Different resolution or screen size
- Different truck/trailer skins or background scenery
- Different color theme or number formatting (dots/commas)

Unacceptable — set "similar": false if Image 2 does NOT look like Image 1's layout:
- Missing the horizontal card with trucks on both sides
- Missing the level XP bar with two numbers
- A completely different UI style or layout structure
- Not a game job report at all (random photo, chat, menu, etc.)

Do NOT name or reference specific games in your reasoning. Just compare Image 2 against Image 1's layout.

Return ONLY strict JSON:
{
  "similar": true or false,
  "reason": "Brief explanation"
}`;

  const images = [
    { base64: refBase64, mimeType: "image/png" },
    { base64: userBase64Image, mimeType: userMimeType }
  ];

  try {
    const result = await executeVisionPipeline(prompt, images);
    if (!result || typeof result.similar !== "boolean") {
      console.warn("[GeminiVision] Visual verification returned invalid payload:", result);
      return null;
    }
    return result;
  } catch (err) {
    console.error("[GeminiVision] Visual verification call failed:", err.message);
    return null;
  }
}

/**
 * Step 2: OCR extraction from ONLY the user's screenshot.
 * Prevents the AI from confusing numbers between the template and candidate image.
 */
async function extractStatsOnly(userBase64Image, userMimeType = "image/jpeg", imageUrl = null) {
  const prompt = `You are an OCR extraction system for the game Truckers of Europe 3 (TOE3).
Analyze this "Job Finished" screen.
Extract these exact values into JSON. All numerical fields must be returned as strings representing the exact value seen in the screenshot, preserving any dots or commas.

{
  "valid": true,
  "distance_km": "string", (e.g. "2350" or "1.234")
  "time_minutes": "string", (convert "7h 30m" to total minutes as a string, e.g. "450")
  "damage_penalty": "string", (exact value, e.g. "-" or "1.200")
  "time_penalty": "string", (exact value, e.g. "2.011")
  "income": "string", (exact value, e.g. "5.037")
  "level": "string", (The level shown, e.g. "42")
  "xp": "string" (current XP, e.g. "80.800")
}

IMPORTANT: In this game, dots (.) are used as thousands separators, not decimals. Do not try to convert or parse them yourself; just return the exact string seen in the screenshot.

If this is NOT a valid "Job Finished" screen, return:
{ "valid": false, "sarcasm": "A short, funny roast about why this isn't a truck job result." }`;

  const images = [{ base64: userBase64Image, mimeType: userMimeType }];

  try {
    return await executeVisionPipeline(prompt, images);
  } catch (err) {
    console.error("[GeminiVision] OCR extraction call failed:", err.message);
    return null;
  }
}

/**
 * Two-stage process:
 *   Stage 1: Sends [default_job_report.png, user_screenshot] to confirm visual layout similarity.
 *   Stage 2: Sends [user_screenshot] to extract OCR numerical stats without number contamination.
 *
 * @param {Buffer} imageBuffer  — already-downloaded image bytes (from screenshotListener)
 * @param {string} imageUrl     — original Discord CDN URL
 * @param {string} [mimeType="image/jpeg"]
 */
async function extractStatsWithGemini(imageBuffer, imageUrl, mimeType = "image/jpeg") {
  try {
    const base64Image = imageBuffer.toString("base64");

    // ── STAGE 1: Visual Format Similarity Check (Two Images) ──
    console.log("[GeminiVision] [Stage 1/2] Checking visual similarity against default_job_report.png...");
    const simResult = await verifyVisualSimilarity(base64Image, mimeType);

    if (simResult === null) {
      // API call failed completely -> return null so retry queue can handle it (error 105/301)
      console.warn("[GeminiVision] Visual similarity check failed to reach any AI provider.");
      return null;
    }

    if (!simResult.similar) {
      console.log(`[GeminiVision] Visual format anticheat rejected image. Reason: ${simResult.reason}`);
      return {
        valid: false,
        sarcasm: simResult.reason || "This image does not match the Truckers of Europe 3 job report format."
      };
    }

    console.log("[GeminiVision] [Stage 1/2] Visual format check PASSED. Proceeding to OCR...");

    // ── STAGE 2: Number Extraction (Candidate Image Only) ──
    console.log("[GeminiVision] [Stage 2/2] Extracting OCR stats from candidate image...");
    const result = await extractStatsOnly(base64Image, mimeType, imageUrl);

    if (!result) {
      console.warn("[GeminiVision] OCR extraction failed to reach any AI provider.");
      return null;
    }

    // Basic safety parsing
    if (result && result.valid) {
       result.distance_km = parseGameNumber(result.distance_km);
       result.time_minutes = parseGameNumber(result.time_minutes);
       result.damage_penalty = parseGameNumber(result.damage_penalty);
       result.time_penalty = parseGameNumber(result.time_penalty);
       result.income = parseGameNumber(result.income);
       result.level = parseGameNumber(result.level);
       result.xp = parseGameNumber(result.xp);
    }

    return result;

  } catch (err) {
    console.error("[GeminiVision] Two-stage vision pipeline encountered an error:", err.message);
    return null;
  }
}

module.exports = {
  extractStatsWithGemini,
  verifyVisualSimilarity,
  extractStatsOnly
};
