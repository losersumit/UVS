// stats_system/geminiVision.js
const axios = require("axios");
const { extractWithFallback } = require("../modelRouter");

async function extractStatsWithGemini(imageUrl) {
  try {
    // 1. Download image as Base64
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const base64Image = Buffer.from(response.data).toString("base64");

    const prompt = `
You are an OCR system for the game Truckers of Europe 3. 
Analyze the "Job Finished" screen.
Extract these exact values into JSON:

{
  "valid": true,
  "distance_km": number, (e.g. 2350)
  "time_minutes": number, (convert "24h 10m" to 1450 total minutes)
  "damage_penalty": number, (remove currency symbol)
  "time_penalty": number, (remove currency symbol)
  "income": number, (Total money earned)
  "level": number, (The level shown on the left the green bar)
  "xp": number (current XP if visible, else 0)
}

If this is NOT a valid "Job Finished" screen, return:
{ "valid": false, "sarcasm": "A short, funny roast about why this isn't a truck job result." }
`;

    const result = await extractWithFallback(prompt, base64Image);
    
    // Basic safety parsing
    if (result && result.valid) {
       result.distance_km = Number(result.distance_km) || 0;
       result.time_minutes = Number(result.time_minutes) || 0;
       result.income = Number(result.income) || 0;
       result.level = Number(result.level) || 0;
    }

    return result;

  } catch (err) {
    console.error("Vision pipeline failed:", err.message);
    return null;
  }
}

module.exports = { extractStatsWithGemini };