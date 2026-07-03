require("dotenv").config();
const Groq = require("groq-sdk");
const axios = require("axios");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const imageUrl = "https://raw.githubusercontent.com/recurser/exif-orientation-examples/master/Landscape_1.jpg";
const prompt = "What is in this image? Describe briefly in JSON format: {\"description\": \"string\"}";

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

async function runVision(model, base64Image) {
  try {
    console.log(`Testing model: ${model} with max_tokens: 2048 and no JSON mode...`);
    const options = {
      model,
      temperature: 0.1,
      max_tokens: 2048,
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
    const res = await groq.chat.completions.create(options);
    const content = res.choices[0].message.content;
    console.log(`Raw output:`, content);
    const parsed = parseMaybeJson(content);
    console.log(`Parsed JSON successfully:`, parsed);
  } catch (err) {
    console.error(`Error:`, err.message);
  }
}

async function main() {
  console.log("Downloading image...");
  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer"
  });
  const base64Image = Buffer.from(response.data).toString("base64");

  console.log("\n-----------------\n");
  await runVision("qwen/qwen3.6-27b", base64Image);
}

main();
