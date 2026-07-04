// stats_system/screenshotListener.js
// Listens for screenshots in the stats channel
// This file ONLY detects valid screenshot messages

const crypto = require("crypto");
const { getOrCreatePlayer, applyRunStats, checkPlayerGuild } = require("./statsService");
const { extractStatsWithGemini } = require("./geminiVision");
const axios = require("axios");
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");
const { mirrorJobLog } = require("./jobLogMirror");

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

      // ══ PRIORITY #1: Mirror to NMC master job-log channel ══
      // Runs BEFORE deletion, reactions, or any validation.
      mirrorJobLog(client, message, guildConfig, guildConfig.guild_name).catch(err =>
        console.error("[MIRROR] Mirror fire failed:", err.message)
      );

      // delete any text-only messages in screenshot channel
      if (message.content && message.content.trim().length > 0 && message.attachments.size === 0) {
        await message.delete().catch(() => { });
        return;
      }

      // must have exactly ONE attachment
      if (!message.attachments || message.attachments.size !== 1) {
        if (message.attachments && message.attachments.size > 1) {
          await message.react("❌").catch(() => { });
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

      // Verify player company/guild lock BEFORE downloading, duplicate hashing, or calling OCR
      await checkPlayerGuild(message.author.id, message.guild.id);

      const imgResp = await axios.get(attachment.url, { responseType: "arraybuffer" });

      // Hash is synchronous (CPU only) — compute once, reuse in both tasks below
      const imageBuffer = Buffer.from(imgResp.data);
      const imageHash = crypto
        .createHash("sha256")
        .update(imageBuffer)
        .digest("hex");

      // ── Fire DB duplicate check and OCR simultaneously ──────────────────────
      // Both are independent I/O — running in parallel saves ~200–400ms per run.
      // Duplicate check is always evaluated FIRST; if it's a dupe the OCR result
      // is simply discarded. Correctness is fully preserved.
      const [{ data: existing }, ocrResult] = await Promise.all([
        supabase.from("runs").select("id").eq("image_hash", imageHash).limit(1),
        extractStatsWithGemini(imageBuffer, attachment.url)
      ]);
      // ────────────────────────────────────────────────────────────────────────

      // 1️⃣ Duplicate check (always wins over OCR result)
      if (existing && existing.length > 0) {
        await message.reactions.cache.get("⏳")?.remove();
        await message.react("❌");
        await message.reply(
          `No Cheating <@${message.author.id}> <:angry_skull:1460634776967843952> !!`
        );
        return;
      }

      // 2️⃣ OCR validity check
      if (!ocrResult || ocrResult.valid === false) {
        await message.reactions.cache.get("⏳")?.remove();
        await message.react("❌");

        if (ocrResult?.sarcasm) {
          await message.reply(ocrResult.sarcasm).catch(() => { });
        }
        return;
      }

      ocrResult.image_hash = imageHash;

      let player;
      try {
        player = await getOrCreatePlayer(
          message.author.id,
          message.author.username,
          message.author.globalName || message.member?.displayName || message.author.username,
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
      if (starsEarned >= 1) await message.react(guildConfig.star_1_emoji).catch(() => { });
      if (starsEarned >= 2) await message.react(guildConfig.star_2_emoji).catch(() => { });
      if (starsEarned >= 3) await message.react(guildConfig.star_3_emoji).catch(() => { });

      console.log("GEMINI RESULT:", ocrResult);

    } catch (err) {
      console.error("Screenshot listener error:", err);

      // 🔴 FIX: Clean up hourglass and show error on ANY failure
      try {
        await message.reactions.cache.get("⏳")?.remove();
        await message.react("❌");
        // Reply with the error message so you know what went wrong (e.g. Database Error)
        const errorText = err.message.startsWith("🚫") ? err.message : `❌ Error processing run: ${err.message}`;
        await message.reply(errorText).catch(() => { });
      } catch (cleanupErr) {
        // failed to react/reply, just log it
      }
    }
  });
}

module.exports = { registerScreenshotListener };