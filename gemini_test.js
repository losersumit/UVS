require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const mime = require("mime-types");

const ai = new GoogleGenAI({
    apiKey: "AQ.Ab8RN6K5llH3fHVfREWnb8SPb65in8k6tNAWKZfIjIvGkH3IgA"
});

const PROMPT = `
You are an OCR system for the game Truckers of Europe 3.

Analyze the "Job Finished" screen.

Extract these exact values into JSON. All numerical fields must be returned as strings representing the exact value seen in the screenshot, preserving any dots or commas.

{
  "valid": true,
  "distance_km": "string",
  "time_minutes": "string",
  "damage_penalty": "string",
  "time_penalty": "string",
  "income": "string",
  "level": "string",
  "xp": "string"
}

IMPORTANT:
- In this game, dots (.) are thousands separators, NOT decimals.
- Return the exact text seen.
- Convert time like "7h 30m" into total minutes as a string ("450").
- Return ONLY JSON.

If this is NOT a valid "Job Finished" screen, return:

{
  "valid": false,
  "sarcasm": "A short, funny roast about why this isn't a truck job result."
}
`;

async function main() {
    try {
        const imagePath = "D:\\.uvs\\.uvs\\xzvsdvsd.png";

        console.log("Using:", imagePath);

        if (!fs.existsSync(imagePath)) {
            console.error("❌ File not found.");
            return;
        }

        const imageBytes = fs.readFileSync(imagePath);

        const response = await ai.models.generateContent({
            // CHANGE THIS if your API key doesn't have access.
            model: "gemini-3.1-flash-lite",

            contents: [
                {
                    inlineData: {
                        mimeType: mime.lookup(imagePath) || "image/png",
                        data: imageBytes.toString("base64")
                    }
                },
                {
                    text: PROMPT
                }
            ],

            config: {
                responseMimeType: "application/json"
            }
        });

        console.log("\n===== OCR RESULT =====\n");

        try {
            console.log(JSON.stringify(JSON.parse(response.text), null, 2));
        } catch {
            console.log(response.text);
        }

    } catch (err) {
        console.error(err);
    }
}

main();