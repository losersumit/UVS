// stats_system/jobLogMirror.js
// Mirrors ALL messages from any guild's screenshot channel to the
// NMC master job-log channel. Runs BEFORE any validation/deletion.
// Downloads attachments so no dead CDN links appear later.

const axios = require("axios");
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");

const MIRROR_CHANNEL_ID = process.env.JOB_LOG_MIRROR_CHANNEL_ID;

/**
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Message} message
 * @param {object} guildConfig  - from getGuildConfig()
 * @param {string} guildName    - human-readable VTC name
 */
async function mirrorJobLog(client, message, guildConfig, guildName) {
  if (!MIRROR_CHANNEL_ID) return;

  try {
    const mirrorChannel = await client.channels
      .fetch(MIRROR_CHANNEL_ID)
      .catch(() => null);
    if (!mirrorChannel) return;

    const displayName =
      message.member?.displayName || message.author.username;
    const vtcName  = guildName || guildConfig.guild_tag || message.guild.name;
    const color    = guildConfig.embed_color || 0xff7801;
    const vtcLogo  = guildConfig.avatar_url  || null;

    // ── Build embed ────────────────────────────────────────────
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({
        name:    vtcName,
        iconURL: vtcLogo || undefined,
      })
      .addFields(
        { name: "👤 Driver",   value: displayName, inline: true },
        { name: "🏢 VTC",     value: vtcName,     inline: true },
        {
          name:   "🕐 Posted",
          value:  `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`,
          inline: true,
        }
      )
      .setFooter({ text: `${message.guild.name} • Job Log Mirror` })
      .setTimestamp();

    // Add text content if any
    if (message.content?.trim()) {
      embed.setDescription(message.content.trim());
    }

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
    // (e.g. if another bot posted an embed in that channel)
    for (const srcEmbed of message.embeds) {
      if (srcEmbed.description) {
        embed.setDescription(
          (embed.data.description ? embed.data.description + "\n\n" : "") +
          srcEmbed.description
        );
      }
    }

    await mirrorChannel.send({ embeds: [embed], files });
    console.log(
      `[MIRROR] ✅ Mirrored job log from ${vtcName} by ${displayName}`
    );
  } catch (err) {
    console.error("[MIRROR] Error:", err.message);
  }
}

module.exports = { mirrorJobLog };
