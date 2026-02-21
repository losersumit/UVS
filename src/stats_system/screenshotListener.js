// stats_system/screenshotListener.js
// Listens for screenshots in the stats channel
// This file ONLY detects valid screenshot messages

const crypto = require("crypto");
const { getOrCreatePlayer, applyRunStats } = require("./statsService");
const { extractStatsWithGemini } = require("./geminiVision");
const axios = require("axios");
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");

// image extensions we accept
const VALID_IMAGE_TYPES = ["png", "jpg", "jpeg", "webp"];

function isValidImage(url) {
  try {
    const cleanUrl = url.split("?")[0].toLowerCase();
    return VALID_IMAGE_TYPES.some(ext => cleanUrl.endsWith("." + ext));
  } catch {
    return false;
  }
}

function registerScreenshotListener(client) {
  client.on("messageCreate", async (message) => {
    try {
      // ignore bots
      if (message.author.bot) return;

      // Get server-specific config
      const guildConfig = await getGuildConfig(message.guild?.id);
      
      // only allow screenshots in the defined channel
      if (!guildConfig.screenshot_channel_id || message.channel.id !== guildConfig.screenshot_channel_id) return;
 
      // delete any text-only messages in screenshot channel
      if (message.content && message.content.trim().length > 0 && message.attachments.size === 0) {
         await message.delete().catch(() => {});
         return;
      }

      // must have exactly ONE attachment
      if (!message.attachments || message.attachments.size !== 1) {
        if (message.attachments && message.attachments.size > 1) {
          await message.react("❌").catch(() => {});
        }
        return;
      }

      const attachment = [...message.attachments.values()][0];

      // attachment must be an image
      if (!isValidImage(attachment.url)) {
        return;
      }

      // VALID screenshot detected
      await message.react("⏳");

      const imgResp = await axios.get(attachment.url, { responseType: "arraybuffer" });

      const imageHash = crypto
        .createHash("sha256")
        .update(Buffer.from(imgResp.data))
        .digest("hex");

      const { data: existing } = await supabase
        .from("runs")
        .select("id")
        .eq("image_hash", imageHash)
        .limit(1);

      if (existing && existing.length > 0) {
        await message.reactions.cache.get("⏳")?.remove();
        await message.react("❌");
        await message.reply(
          `No Cheating <@${message.author.id}> <:angry_skull:1460634776967843952> !!`
        );
        return;
      }

      const ocrResult = await extractStatsWithGemini(attachment.url);

      if (!ocrResult || ocrResult.valid === false) {
        await message.reactions.cache.get("⏳")?.remove();
        await message.react("❌");

        if (ocrResult?.sarcasm) {
          await message.reply(ocrResult.sarcasm).catch(() => {});
        }
        return;
      }

      ocrResult.image_hash = imageHash;

      let player;
      try {
        player = await getOrCreatePlayer(
          message.author.id,
          message.author.username,
          message.guild.id
        );
      } catch (err) {
        // Player creation specific error
        await message.reactions.cache.get("⏳")?.remove();
        await message.react("❌");
        await message.reply(err.message);
        return;
      }

      const { starsEarned } = await applyRunStats(
        player.id,
        ocrResult,
        client
      );

      await message.reactions.cache.get("⏳")?.remove();
      await message.react("✅");

      // Use server-specific star emojis
      if (starsEarned >= 1) await message.react(guildConfig.star_1_emoji).catch(() => {});
      if (starsEarned >= 2) await message.react(guildConfig.star_2_emoji).catch(() => {});
      if (starsEarned >= 3) await message.react(guildConfig.star_3_emoji).catch(() => {});

      console.log("GEMINI RESULT:", ocrResult);

    } catch (err) {
      console.error("Screenshot listener error:", err);
      
      // 🔴 FIX: Clean up hourglass and show error on ANY failure
      try {
        await message.reactions.cache.get("⏳")?.remove();
        await message.react("❌");
        // Reply with the error message so you know what went wrong (e.g. Database Error)
        await message.reply(`❌ Error processing run: ${err.message}`).catch(() => {});
      } catch (cleanupErr) {
        // failed to react/reply, just log it
      }
    }
  });
}

module.exports = { registerScreenshotListener };