const fs = require("fs");
const path = require("path");

const filePath = "C:\\Users\\yangs\\.gemini\\antigravity\\brain\\7009649d-98a3-4186-be19-75873e07511a\\.system_generated\\steps\\111\\content.md";

try {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  console.log(`Total lines: ${lines.length}`);
  lines.forEach((line, index) => {
    if (line.toLowerCase().includes("json") || line.toLowerCase().includes("format")) {
      console.log(`${index + 1}: ${line.trim()}`);
    }
  });
} catch (err) {
  console.error(err);
}
