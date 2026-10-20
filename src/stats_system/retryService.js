/**
 * ============================================================================
 * MODULE: retryService.js
 * PURPOSE: Manages persistence and 15-minute retry cycles for job reports
 *          that failed with error code 105 or 301 (e.g. AI timeouts / OCR failures).
 *          - Saves image to disk in S:\.uvs\retry_images\
 *          - Persists metadata (channelId, messageId, guildId, authorId, filename)
 *          - Keeps waiting emoji (⏳) on the job report Discord message
 *          - Runs every 15 minutes: reprocesses pending images
 *          - On success: cleans up file/metadata and triggers success reactions & stats
 *          - On error 105/301: remains in queue with ⏳ for next 15-min attempt
 *          - On definitive anticheat/validation error: sets final error code and removes
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");
const { getOrCreatePlayer, applyRunStats, checkPlayerGuild } = require("./statsService");
const { extractStatsWithGemini } = require("./geminiVision");
const { addUnbCash } = require("./unbService");

const RETRY_DIR = path.resolve(__dirname, "../../retry_images");
const METADATA_FILE = path.join(RETRY_DIR, "pending_retries.json");

// Ensure directory exists
if (!fs.existsSync(RETRY_DIR)) {
  fs.mkdirSync(RETRY_DIR, { recursive: true });
}

function loadQueue() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const raw = fs.readFileSync(METADATA_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("[RetryService] Failed to load pending retries metadata:", err);
  }
  return [];
}

function saveQueue(queue) {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(queue, null, 2), "utf-8");
  } catch (err) {
    console.error("[RetryService] Failed to save pending retries metadata:", err);
  }
}

/**
 * Saves a failed job report image (error code 105 or 301) to disk and registers
 * it for periodic retry every 15 minutes.
 */
async function scheduleImageRetry({
  message,
  mirroredMessage,
  imageBuffer,
  contentType,
  authorId,
  guildId,
  authorUsername,
  authorDisplayName,
  originalUrl
}) {
  const queue = loadQueue();
  
  // Prevent duplicate queuing for the same message
  if (queue.some(item => item.messageId === message.id)) {
    console.log(`[RetryService] Message ${message.id} is already in retry queue.`);
    return;
  }

  // Determine file extension
  let ext = "png";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) ext = "jpg";
  else if (contentType?.includes("webp")) ext = "webp";

  const filename = `${message.id}_${Date.now()}.${ext}`;
  const filePath = path.join(RETRY_DIR, filename);

  try {
    fs.writeFileSync(filePath, imageBuffer);
  } catch (writeErr) {
    console.error(`[RetryService] Failed to save image ${filename}:`, writeErr);
    return;
  }

  const retryItem = {
    messageId: message.id,
    channelId: message.channel.id,
    guildId: guildId || message.guild?.id,
    mirroredMessageId: mirroredMessage ? mirroredMessage.id : null,
    mirroredChannelId: mirroredMessage ? mirroredMessage.channel.id : null,
    authorId: authorId || message.author.id,
    authorUsername: authorUsername || message.author.username,
    authorDisplayName: authorDisplayName || message.author.globalName || message.member?.displayName || message.author.username,
    filename,
    contentType: contentType || "image/jpeg",
    originalUrl,
    queuedAt: Date.now(),
    attempts: 0
  };

  queue.push(retryItem);
  saveQueue(queue);

  // Keep the waiting emoji ⏳ on the original message
  try {
    await message.react("⏳").catch(() => {});
  } catch (reactErr) {
    console.error("[RetryService] Failed to keep waiting emoji on message:", reactErr);
  }

  console.log(`[RetryService] Job report ${message.id} queued for 15-minute retry. Saved as: ${filename}`);
}

/**
 * Processes a single pending retry item.
 * Returns true if the item was resolved (succeeded or definitively rejected and deleted),
 * or false if it should remain in the retry queue.
 */
async function processRetryItem(client, item) {
  const filePath = path.join(RETRY_DIR, item.filename);

  if (!fs.existsSync(filePath)) {
    console.warn(`[RetryService] File ${filePath} not found. Removing from queue.`);
    return true; // remove
  }

  let channel, message, mirroredMessage;
  try {
    channel = await client.channels.fetch(item.channelId).catch(() => null);
    if (channel) {
      message = await channel.messages.fetch(item.messageId).catch(() => null);
    }
  } catch (fetchErr) {
    console.warn(`[RetryService] Original message ${item.messageId} could not be fetched:`, fetchErr.message);
  }

  if (item.mirroredChannelId && item.mirroredMessageId) {
    try {
      const mChannel = await client.channels.fetch(item.mirroredChannelId).catch(() => null);
      if (mChannel) {
        mirroredMessage = await mChannel.messages.fetch(item.mirroredMessageId).catch(() => null);
      }
    } catch (mErr) {
      // ignore mirror fetch error
    }
  }

  // If the original message was deleted by the user, clean up
  if (!message) {
    console.log(`[RetryService] Message ${item.messageId} no longer exists. Deleting retry file.`);
    try { fs.unlinkSync(filePath); } catch {}
    return true;
  }

  const imageBuffer = fs.readFileSync(filePath);
  const imageHash = crypto.createHash("sha256").update(imageBuffer).digest("hex");

  try {
    // 1. Check duplicate runs
    const { data: existing } = await supabase
      .from("runs")
      .select("id")
      .eq("image_hash", imageHash)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[RetryService] Message ${item.messageId} is already recorded in runs (duplicate). Cleaning up.`);
      try { fs.unlinkSync(filePath); } catch {}
      return true;
    }

    // 2. Perform OCR & anticheat format verification
    const ocrResult = await extractStatsWithGemini(imageBuffer, item.originalUrl, item.contentType);

    if (!ocrResult || ocrResult.valid === false) {
      console.log(`[RetryService] Item ${item.messageId} attempt failed (OCR/Layout check returned invalid/null). Will retry in next cycle.`);
      // Ensure waiting emoji ⏳ stays on message
      await message.react("⏳").catch(() => {});
      return false; // keep in queue
    }

    // 3. OCR Succeeded! Verify guild and apply run stats
    const guildConfig = await getGuildConfig(item.guildId);

    // Update mirror with OCR data
    if (mirroredMessage && ocrResult.valid) {
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
        console.error("[RetryService] Failed to edit mirror embed with OCR:", editErr.message);
      }
    }

    await checkPlayerGuild(item.authorId, item.guildId);

    ocrResult.image_hash = imageHash;

    const player = await getOrCreatePlayer(
      item.authorId,
      item.authorUsername,
      item.authorDisplayName,
      item.guildId
    );

    const { starsEarned } = await applyRunStats(player.id, ocrResult, client);

    // UNB Economy Integration
    if (guildConfig.enable_unb_economy) {
      const incomeAmount = Number(ocrResult.income) || 0;
      if (incomeAmount > 0) {
        addUnbCash(item.guildId, item.authorId, incomeAmount, "UVS Job Log Payout").catch(() => {});
      }
    }

    // Remove waiting emoji ⏳ and add success checkmark
    await message.reactions.cache.get("⏳")?.remove().catch(() => {});
    await message.react("1530697317697585153").catch(() => {}); // <a:green_tick:1530697317697585153>

    // HQ VTC Logo react
    const isHQServer = item.guildId === process.env.HQ_GUILD_ID;
    if (isHQServer && player.guild_id) {
      try {
        const { data: vtcRow } = await supabase
          .from("approved_guilds")
          .select("logo_emojis")
          .eq("guild_id", player.guild_id)
          .maybeSingle();

        if (vtcRow?.logo_emojis) {
          const emojiMatch = vtcRow.logo_emojis.match(/<a?:[\w]+:(\d+)>/);
          if (emojiMatch) {
            await message.react(emojiMatch[1]).catch(() => {});
          }
        }
      } catch (logoErr) {
        console.error("[RetryService] Failed to react with VTC logo:", logoErr.message);
      }
    }

    // Add star reactions
    if (starsEarned >= 1 && guildConfig.star_1_emoji) await message.react(guildConfig.star_1_emoji).catch(() => {});
    if (starsEarned >= 2 && guildConfig.star_2_emoji) await message.react(guildConfig.star_2_emoji).catch(() => {});
    if (starsEarned >= 3 && guildConfig.star_3_emoji) await message.react(guildConfig.star_3_emoji).catch(() => {});

    // Update mirror status to Accepted
    if (mirroredMessage) {
      try {
        const embed = EmbedBuilder.from(mirroredMessage.embeds[0]);
        const firstAttachment = mirroredMessage.attachments.first();
        if (firstAttachment) {
          embed.setImage(`attachment://${firstAttachment.name}`);
        }
        embed.setDescription(embed.data.description + "\n\n<a:green_tick:1530697317697585153> Accepted (via Retry)");
        await mirroredMessage.edit({ embeds: [embed] });
      } catch (editErr) {
        console.error("[RetryService] Failed to edit mirror status:", editErr.message);
      }
    }

    console.log(`[RetryService] Successfully processed retry for message ${item.messageId}! Deleting local file.`);
    try { fs.unlinkSync(filePath); } catch {}
    return true; // Resolved!

  } catch (err) {
    console.error(`[RetryService] Error while processing retry for message ${item.messageId}:`, err.message);

    // If anticheat rejected the run definitively (e.g. impossible speed, regression)
    if (err.message && err.message.includes("Run rejected:")) {
      console.log(`[RetryService] Run definitively rejected for ${item.messageId}: ${err.message}. Removing from retry.`);
      try { fs.unlinkSync(filePath); } catch {}
      await message.reactions.cache.get("⏳")?.remove().catch(() => {});
      return true; // remove from retry queue
    }

    // Otherwise, keep ⏳ and retry again on next cycle
    await message.react("⏳").catch(() => {});
    return false;
  }
}

/**
 * Runs the retry cycle across all pending items.
 */
async function runRetryCycle(client) {
  const queue = loadQueue();
  if (queue.length === 0) return;

  console.log(`[RetryService] Running 15-minute retry cycle for ${queue.length} pending job reports...`);

  const updatedQueue = [];
  for (const item of queue) {
    item.attempts = (item.attempts || 0) + 1;
    try {
      const resolved = await processRetryItem(client, item);
      if (!resolved) {
        updatedQueue.push(item);
      }
    } catch (itemErr) {
      console.error(`[RetryService] Unexpected error on item ${item.messageId}:`, itemErr);
      updatedQueue.push(item);
    }
  }

  saveQueue(updatedQueue);
  console.log(`[RetryService] Retry cycle complete. Remaining items in queue: ${updatedQueue.length}`);
}

/**
 * Registers the cron job to run every 15 minutes.
 */
function registerRetryService(client) {
  // Cron schedule: "*/15 * * * *" runs at every 15th minute
  cron.schedule("*/15 * * * *", () => {
    runRetryCycle(client).catch(err => {
      console.error("[RetryService] Cron execution failed:", err);
    });
  });

  console.log("⏱️ [RetryService] Scheduled job report retry cron for every 15 minutes.");
}

module.exports = {
  scheduleImageRetry,
  registerRetryService,
  runRetryCycle,
  loadQueue
};
