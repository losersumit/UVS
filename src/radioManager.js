/**
 * ============================================================================
 * MODULE: radioManager.js
 * PURPOSE: Monitors message events for the "+rd " prefix and handles cross-server
 *          radio transmissions. Broadcasts transmissions to other guilds tuned
 *          to the same frequency.
 * ============================================================================
 */

const { supabase } = require("./stats_system/supabase");

/**
 * Formats the sender tag correctly, avoiding double brackets.
 */
function formatSenderPrefix(tag) {
  if (!tag) return "";
  const trimmed = tag.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return `**${trimmed}**`;
  }
  return `**[${trimmed}]**`;
}

/**
 * Handle radio transmissions starting with "+rd"
 */
async function handleRadioMessage(message) {
  // Ignore bots
  if (message.author.bot) return;

  const contentLower = message.content.toLowerCase();
  if (!contentLower.startsWith("+rd")) return;

  // Ensure there is space or it's just +rd
  const match = message.content.match(/^\+rd\s+([\s\S]*)/i);
  const transmissionContent = match ? match[1].trim() : "";

  const senderGuildId = message.guild.id;

  // 1. Fetch sender's radio frequency and configuration
  const { data: senderGuild, error: senderError } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_tag, guild_name, radio_frequency, call_channel_id::text")
    .eq("guild_id", senderGuildId)
    .maybeSingle();

  if (senderError || !senderGuild) {
    console.error("[RadioManager] Error fetching sender guild:", senderError);
    return;
  }

  const frequency = senderGuild.radio_frequency;

  if (frequency === null || frequency === undefined) {
    return message.reply({
      content: "⚠️ This organisation has not configured a radio frequency. Please use `/setradiofrequency` to tune in."
    });
  }

  // 2. Fetch all other approved guilds tuned to the SAME frequency
  const { data: targetGuilds, error: targetsError } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_tag, guild_name, call_channel_id::text")
    .eq("radio_frequency", frequency)
    .eq("is_suspended", false)
    .neq("guild_id", senderGuildId);

  if (targetsError) {
    console.error("[RadioManager] Error fetching target guilds:", targetsError);
    return;
  }

  if (!targetGuilds || targetGuilds.length === 0) {
    // No other guilds on this frequency, but we don't output anything to keep it realistic,
    // or we can optionally react/do nothing. The user said: "apex cannot see to which company the transmission went to".
    // We will react with a radio emoji to show it was sent/processed.
    await message.react("📡").catch(() => {});
    return;
  }

  // Format the prefix using the sender's tag
  const senderPrefix = formatSenderPrefix(senderGuild.guild_tag || senderGuild.guild_name);
  const formattedContent = transmissionContent
    ? `${senderPrefix} : ${transmissionContent}`
    : `${senderPrefix} : *[Transmission with no text]*`;

  // Attachments mapping
  const files = message.attachments.map(att => ({
    attachment: att.url,
    name: att.name
  }));

  // 3. Broadcast to all matching guilds
  let successCount = 0;
  for (const target of targetGuilds) {
    if (!target.call_channel_id) continue;

    try {
      const channel = await message.client.channels.fetch(target.call_channel_id);
      if (channel) {
        await channel.send({
          content: formattedContent,
          files: files.length > 0 ? files : undefined
        });
        successCount++;
      }
    } catch (err) {
      console.error(`[RadioManager] Failed to send to guild ${target.guild_id} channel ${target.call_channel_id}:`, err);
    }
  }

  // React to the message to indicate it was successfully transmitted over the airwaves
  if (successCount > 0) {
    await message.react("📡").catch(() => {});
  } else {
    await message.react("⚠️").catch(() => {});
  }
}

module.exports = { handleRadioMessage };
