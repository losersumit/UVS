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
const { isUserSuspended, alertSuspendedAttempt } = require("./suspendedUsers");
const { EmbedBuilder } = require("discord.js");

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

async function reactWithErrorCode(message, codeString) {
  const digitEmojis = {
    "0": "1530702403089993862",
    "1": "1530702377328316436",
    "2": "1530702384483799040",
    "3": "1530702392650240141",
    "4": "1530702380872634438",
    "5": "1530702386576752650",
    "6": "1530702388875362474",
    "7": "1530702395913277640",
    "8": "1530702407116525578",
    "9": "1530702399478563027"
  };
  try {
    await message.react("1530700762219544637").catch(() => {}); // new reject emoji
    for (const char of codeString) {
      const emojiId = digitEmojis[char];
      if (emojiId) {
        await message.react(emojiId).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[REACT_ERROR] Failed to react with code:", err);
  }
}

function getErrorCodeForError(err) {
  const msg = err.message || "";
  
  if (msg.includes("You are a driver at")) {
    return "102";
  }
  if (msg.includes("This server is not an approved VTC")) {
    return "103";
  }
  if (msg.includes("No Cheating") || msg.includes("duplicate")) {
    return "104";
  }
  if (msg.includes("Invalid distance or time")) {
    return "203";
  }
  if (msg.includes("Invalid income")) {
    return "204";
  }
  if (msg.includes("exceeds limit of") && msg.includes("km")) {
    return "205";
  }
  if (msg.includes("physically impossible")) {
    return "206";
  }
  if (msg.includes("Income") && msg.includes("exceeds limit of") && !msg.includes("per km")) {
    return "207";
  }
  if (msg.includes("Income per km")) {
    return "208";
  }
  if (msg.includes("Level regression detected")) {
    return "209";
  }
  
  return "301";
}

function registerScreenshotListener(client) {
  client.on("messageCreate", async (message) => {
    let mirroredMessage = null;
    try {
      // ignore bots
      if (message.author.bot) return;

      // Get server-specific config
      const guildConfig = await getGuildConfig(message.guild?.id);

      // only allow screenshots in the defined channel
      if (!guildConfig.screenshot_channel_id || message.channel.id !== guildConfig.screenshot_channel_id) return;

      // ══ PRIORITY #1: Mirror to NMC master job-log channel ══
      try {
        mirroredMessage = await mirrorJobLog(client, message, guildConfig, guildConfig.guild_name);
      } catch (err) {
        console.error("[MIRROR] Mirror fire failed:", err.message);
      }

      // ══ SUSPENSION CHECK ══
      const suspension = await isUserSuspended(message.author.id);
      if (suspension) {
        const reason = suspension.reason || "No reason specified";
        await message.reactions.cache.get("⏳")?.remove().catch(() => {});
        await reactWithErrorCode(message, "106");

        // Send standard message in channel
        await message.channel.send(`You are suspended due to: **${reason}**\n-# *This message was meant for <@${message.author.id}>.*`).catch(() => {});

        if (mirroredMessage) {
          try {
            const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
            const firstAttachment = mirroredMessage.attachments.first();
            if (firstAttachment) {
              embed.setImage(`attachment://${firstAttachment.name}`);
            }
            embed.setDescription(embed.data.description + "\n\n<a:rejected_redo:1530700762219544637> Rejected (Code: 106)");
            await mirroredMessage.edit({ embeds: [embed] });
          } catch (editErr) {
            console.error("[MIRROR_EDIT] Failed to edit mirror status:", editErr);
          }
        }

        alertSuspendedAttempt(
          client,
          message.author.id,
          message.author.username,
          message.guild?.name || "Unknown Server"
        ).catch(err => console.error("[SuspendedAlert] Alert failed:", err));
        return;
      }

      // delete any text-only messages in screenshot channel
      if (message.content && message.content.trim().length > 0 && message.attachments.size === 0) {
        await message.delete().catch(() => { });
        return;
      }

      // must have exactly ONE attachment
      if (!message.attachments || message.attachments.size !== 1) {
        if (message.attachments && message.attachments.size > 1) {
          await reactWithErrorCode(message, "105");
          if (mirroredMessage) {
            try {
              const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
              const firstAttachment = mirroredMessage.attachments.first();
              if (firstAttachment) {
                embed.setImage(`attachment://${firstAttachment.name}`);
              }
              embed.setDescription(embed.data.description + "\n\n<a:rejected_redo:1530700762219544637> Rejected (Code: 105)");
              await mirroredMessage.edit({ embeds: [embed] });
            } catch (editErr) {
              console.error("[MIRROR_EDIT] Failed to edit mirror status:", editErr);
            }
          }
        }
        return;
      }

      const attachment = [...message.attachments.values()][0];

      // attachment must be an image
      if (!isValidImage(attachment.url)) {
        await reactWithErrorCode(message, "105");
        if (mirroredMessage) {
          try {
            const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
            const firstAttachment = mirroredMessage.attachments.first();
            if (firstAttachment) {
              embed.setImage(`attachment://${firstAttachment.name}`);
            }
            embed.setDescription(embed.data.description + "\n\n<a:rejected_redo:1530700762219544637> Rejected (Code: 105)");
            await mirroredMessage.edit({ embeds: [embed] });
          } catch (editErr) {
            console.error("[MIRROR_EDIT] Failed to edit mirror status:", editErr);
          }
        }
        return;
      }

      // VALID screenshot detected
      await message.react("⏳");

      // Verify player company/guild lock BEFORE downloading, duplicate hashing, or calling OCR
      await checkPlayerGuild(message.author.id, message.guild.id);

      const imgResp = await axios.get(attachment.url, { responseType: "arraybuffer" });

      // Hash is synchronous
      const imageBuffer = Buffer.from(imgResp.data);
      const imageHash = crypto
        .createHash("sha256")
        .update(imageBuffer)
        .digest("hex");

      const [{ data: existing }, ocrResult] = await Promise.all([
        supabase.from("runs").select("id").eq("image_hash", imageHash).limit(1),
        extractStatsWithGemini(imageBuffer, attachment.url)
      ]);

      // ── Edit mirrored message with OCR extracted data as soon as OCR is complete ──
      if (mirroredMessage && ocrResult && ocrResult.valid) {
        try {
          const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
          const firstAttachment = mirroredMessage.attachments.first();
          if (firstAttachment) {
            embed.setImage(`attachment://${firstAttachment.name}`);
          }
          const totalMin = Number(ocrResult.time_minutes) || 0;
          const hrs = Math.floor(totalMin / 60);
          const mins = totalMin % 60;
          const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
          const ocrText = `🛣️: ${ocrResult.distance_km} km\n⏱️: ${timeStr}\n💶: ${ocrResult.income}\n🏆: ${ocrResult.level}\nDmgP: ${ocrResult.damage_penalty}\nTmP: ${ocrResult.time_penalty}\nXP: ${ocrResult.xp}`;
          embed.setDescription(embed.data.description + "\n\n" + ocrText);
          await mirroredMessage.edit({ embeds: [embed] });
        } catch (editErr) {
          console.error("[MIRROR_EDIT] Failed to edit mirror embed with OCR:", editErr);
        }
      }

      // 1️⃣ Duplicate check (always wins over OCR result)
      if (existing && existing.length > 0) {
        await message.reactions.cache.get("⏳")?.remove().catch(() => {});
        await reactWithErrorCode(message, "104");

        if (mirroredMessage) {
          try {
            const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
            const firstAttachment = mirroredMessage.attachments.first();
            if (firstAttachment) {
              embed.setImage(`attachment://${firstAttachment.name}`);
            }
            embed.setDescription(embed.data.description + "\n\n<a:rejected_redo:1530700762219544637> Rejected (Code: 104)");
            await mirroredMessage.edit({ embeds: [embed] });
          } catch (editErr) {
            console.error("[MIRROR_EDIT] Failed to edit mirror status:", editErr);
          }
        }
        return;
      }

      // 2️⃣ OCR validity check
      if (!ocrResult || ocrResult.valid === false) {
        await message.reactions.cache.get("⏳")?.remove().catch(() => {});
        await reactWithErrorCode(message, "105");

        if (mirroredMessage) {
          try {
            const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
            const firstAttachment = mirroredMessage.attachments.first();
            if (firstAttachment) {
              embed.setImage(`attachment://${firstAttachment.name}`);
            }
            embed.setDescription(embed.data.description + "\n\n<a:rejected_redo:1530700762219544637> Rejected (Code: 105)");
            await mirroredMessage.edit({ embeds: [embed] });
          } catch (editErr) {
            console.error("[MIRROR_EDIT] Failed to edit mirror status:", editErr);
          }
        }
        return;
      }

      ocrResult.image_hash = imageHash;

      let player;
      player = await getOrCreatePlayer(
        message.author.id,
        message.author.username,
        message.author.globalName || message.member?.displayName || message.author.username,
        message.guild.id
      );

      const { starsEarned } = await applyRunStats(
        player.id,
        ocrResult,
        client
      );

      await message.reactions.cache.get("⏳")?.remove().catch(() => {});
      await message.react("1530697317697585153"); // <a:green_tick:1530697317697585153>

      // Use server-specific star emojis
      if (starsEarned >= 1) await message.react(guildConfig.star_1_emoji).catch(() => { });
      if (starsEarned >= 2) await message.react(guildConfig.star_2_emoji).catch(() => { });
      if (starsEarned >= 3) await message.react(guildConfig.star_3_emoji).catch(() => { });

      if (mirroredMessage) {
        try {
          const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
          const firstAttachment = mirroredMessage.attachments.first();
          if (firstAttachment) {
            embed.setImage(`attachment://${firstAttachment.name}`);
          }
          embed.setDescription(embed.data.description + "\n\n<a:green_tick:1530697317697585153> Accepted");
          await mirroredMessage.edit({ embeds: [embed] });
        } catch (editErr) {
          console.error("[MIRROR_EDIT] Failed to edit mirror status:", editErr);
        }
      }

      console.log("GEMINI RESULT:", ocrResult);

    } catch (err) {
      console.error("Screenshot listener error:", err);

      try {
        await message.reactions.cache.get("⏳")?.remove().catch(() => {});
        const code = getErrorCodeForError(err);
        await reactWithErrorCode(message, code);

        if (code === "102") {
          const text = err.message.replace("🚫 ", "");
          await message.channel.send(`${text}\n-# *This message was meant for <@${message.author.id}>.*`).catch(() => {});
        } else if (code === "103") {
          const text = err.message.replace("❌ ", "");
          await message.channel.send(`${text}\n-# *This message was meant for <@${message.author.id}>.*`).catch(() => {});
        }

        if (mirroredMessage) {
          try {
            const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
            const firstAttachment = mirroredMessage.attachments.first();
            if (firstAttachment) {
              embed.setImage(`attachment://${firstAttachment.name}`);
            }
            embed.setDescription(embed.data.description + `\n\n<a:rejected_redo:1530700762219544637> Rejected (Code: ${code})`);
            await mirroredMessage.edit({ embeds: [embed] });
          } catch (editErr) {
            console.error("[MIRROR_EDIT] Failed to edit mirror status:", editErr);
          }
        }
      } catch (cleanupErr) {
        console.error("Failed to execute error cleanup reactions:", cleanupErr);
      }
    }
  });
}

module.exports = { registerScreenshotListener };