// stats_system/suspendedUsers.js
// Helpers for suspended user enforcement: lookup and owner alert embed.

const { supabase } = require("./supabase");

const OWNER_ID = process.env.OWNER_ID || "1084255828107853844";
const ALERT_CHANNEL_ID = "1483730512257224715";

/**
 * Formats a Date object to IST (GMT+5:30) locale string.
 */
function toIST(date) {
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
}

/**
 * Returns true if the given Discord user ID is in the suspended_users table.
 * @param {string} discordId
 * @returns {Promise<boolean>}
 */
async function isUserSuspended(discordId) {
  const { data } = await supabase
    .from("suspended_users")
    .select("id, reason")
    .eq("discord_id", discordId)
    .maybeSingle();
  return data;
}

/**
 * Sends a rich alert embed to the NMC owner alert channel, pinging the owner
 * outside the embed. Fetches suspension reason and timestamp from the DB.
 *
 * @param {import('discord.js').Client} client
 * @param {string} discordId   - The suspended user's Discord ID
 * @param {string} username    - The suspended user's Discord username
 * @param {string} guildName   - The name of the server where the attempt occurred
 */
async function alertSuspendedAttempt(client, discordId, username, guildName) {
  try {
    const { data: suspension } = await supabase
      .from("suspended_users")
      .select("reason, suspended_at")
      .eq("discord_id", discordId)
      .maybeSingle();

    const now = new Date();
    const reason = suspension?.reason || "No reason provided";
    const suspendedAt = suspension?.suspended_at
      ? toIST(new Date(suspension.suspended_at))
      : "Unknown";
    const attemptAt = toIST(now);

    const channel = await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error(`[SuspendedAlert] Could not fetch alert channel ${ALERT_CHANNEL_ID}`);
      return;
    }

    const embed = {
      title: "🚨 Suspended User Alert",
      color: 0xFF3333,
      description: `**${username}** (<@${discordId}>) tried posting a job log in **${guildName}**`,
      fields: [
        { name: "👤 User",         value: `@${username}\n\`${discordId}\``, inline: true },
        { name: "🏢 Server",       value: guildName,                         inline: true },
        { name: "\u200B",          value: "\u200B",                          inline: false },
        { name: "📋 Reason",       value: reason,                            inline: false },
        { name: "🕐 Suspended At", value: suspendedAt,                       inline: true },
        { name: "⏰ Attempt At",   value: attemptAt,                         inline: true }
      ],
      footer: { text: "UVS Security System" },
      timestamp: now.toISOString()
    };

    // Owner ping is sent as message content — outside the embed
    await channel.send({ content: `<@${OWNER_ID}>`, embeds: [embed] });

  } catch (err) {
    console.error("[SuspendedAlert] Failed to send alert:", err);
  }
}

module.exports = { isUserSuspended, alertSuspendedAttempt };
