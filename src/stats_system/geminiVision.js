// stats_system/geminiVision.js
const { extractWithFallback } = require("../modelRouter");

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
 * @param {Buffer} imageBuffer  — already-downloaded image bytes (from screenshotListener)
 */
async function extractStatsWithGemini(imageBuffer) {
  try {
    // Convert the buffer we already have — no second HTTP download needed
    const base64Image = imageBuffer.toString("base64");

    const prompt = `
You are an OCR system for the game Truckers of Europe 3. 
Analyze the "Job Finished" screen.
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
{ "valid": false, "sarcasm": "A short, funny roast about why this isn't a truck job result." }
`;

    const result = await extractWithFallback(prompt, base64Image);
    
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
    console.error("Vision pipeline failed:", err.message);
    return null;
  }
}

module.exports = { extractStatsWithGemini };