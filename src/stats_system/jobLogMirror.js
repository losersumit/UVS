// stats_system/jobLogMirror.js
// Mirrors ALL messages from any guild's screenshot channel to the
// NMC master job-log channel. Runs BEFORE any validation/deletion.
// Downloads attachments so no dead CDN links appear later.

const axios = require("axios");
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");

const MIRROR_CHANNEL_ID = process.env.JOB_LOG_MIRROR_CHANNEL_ID;

function formatISTDate(timestamp) {
  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  
  const parts = formatter.formatToParts(date);
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  
  return `${month} ${day} ${hour}:${minute}`;
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Message} message
 * @param {object} guildConfig  - from getGuildConfig()
 * @param {string} guildName    - human-readable VTC name
 */
async function mirrorJobLog(client, message, guildConfig, guildName) {
  if (!MIRROR_CHANNEL_ID) return null;

  try {
    const mirrorChannel = await client.channels
      .fetch(MIRROR_CHANNEL_ID)
      .catch(() => null);
    if (!mirrorChannel) return null;

    const displayName =
      message.member?.displayName || message.author.username;
    const vtcTag = guildConfig.guild_tag || `[${guildName || message.guild.name}]`;
    const color    = guildConfig.embed_color || 0xff7801;

    // ── Build compact description ──────────────────────────────
    const formattedDate = formatISTDate(message.createdTimestamp);
    let description = `👤: ${displayName}\n🏢: ${vtcTag}\n🗓️: ${formattedDate}`;

    // Add text content if any
    if (message.content?.trim()) {
      description += `\n\n${message.content.trim()}`;
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setDescription(description);

    // ── Download attachments ───────────────────────────────────
    const files = [];
    let firstImageName = null;

    for (const [, att] of message.attachments) {
      try {
        const resp = await axios.get(att.url, {
          responseType: "arraybuffer",
          timeout: 20_000,
        });
        const ext      = (att.name || "file").split(".").pop().toLowerCase();
        const safeName = `mirror_${att.id}.${ext}`;
        files.push(new AttachmentBuilder(Buffer.from(resp.data), { name: safeName }));

        // Use first image as the embed image
        if (!firstImageName && ["png", "jpg", "jpeg", "webp"].includes(ext)) {
          firstImageName = safeName;
        }
      } catch (dlErr) {
        console.error(`[MIRROR] Failed to download ${att.url}:`, dlErr.message);
      }
    }

    if (firstImageName) {
      embed.setImage(`attachment://${firstImageName}`);
    }

    // ── Forward any existing embeds as fields ──────────────────
    for (const srcEmbed of message.embeds) {
      if (srcEmbed.description) {
        embed.setDescription(
          (embed.data.description ? embed.data.description + "\n\n" : "") +
          srcEmbed.description
        );
      }
    }

    const mirroredMessage = await mirrorChannel.send({ embeds: [embed], files });
    console.log(
      `[MIRROR] ✅ Mirrored job log from ${vtcTag} by ${displayName}`
    );
    return mirroredMessage;
  } catch (err) {
    console.error("[MIRROR] Error:", err.message);
    return null;
  }
}

module.exports = { mirrorJobLog };
