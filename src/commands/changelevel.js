const { EmbedBuilder } = require("discord.js");
const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { isOwner } = require("../owner");

// Custom Animated & Static Emojis
const EMOJIS = {
  green_tick: "<a:green_tick:1530697317697585153>",
  rejected_redo: "<a:rejected_redo:1530700762219544637>"
};

async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    return interaction.reply({
      content: `${EMOJIS.rejected_redo} Permission denied. This command is restricted to the bot owner.`,
      ephemeral: true
    });
  }

  // Non-ephemeral deferred reply as requested
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser("user");
  const targetIdInput = interaction.options.getString("user_id")?.trim();
  const targetUsernameInput = interaction.options.getString("username")?.trim();
  const newLevel = interaction.options.getInteger("new_level");

  // Validate that at least one user identifier was provided
  if (!targetUser && !targetIdInput && !targetUsernameInput) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setDescription(`${EMOJIS.rejected_redo} **Error:** Please provide at least one user identifier (\`user\`, \`user_id\`, or \`username\`).`);
    return interaction.editReply({ embeds: [errorEmbed] });
  }

  // Find player by discord_id or username
  let player = null;

  // 1. Check if user mention was passed
  if (targetUser) {
    const { data } = await supabase
      .from("players")
      .select("id, discord_id, username, display_name, guild_tag")
      .eq("discord_id", targetUser.id)
      .maybeSingle();
    player = data;
  }

  // 2. Fallback to user_id if not found or not provided
  if (!player && targetIdInput) {
    const { data } = await supabase
      .from("players")
      .select("id, discord_id, username, display_name, guild_tag")
      .eq("discord_id", targetIdInput)
      .maybeSingle();
    player = data;
  }

  // 3. Fallback to username if still not found
  if (!player && targetUsernameInput) {
    const cleanUsername = targetUsernameInput.replace(/^@/, "");
    const { data } = await supabase
      .from("players")
      .select("id, discord_id, username, display_name, guild_tag")
      .ilike("username", cleanUsername)
      .maybeSingle();
    player = data;
  }

  if (!player) {
    const notFoundEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setDescription(`${EMOJIS.rejected_redo} **Player Not Found:** Could not locate any registered driver matching the provided details in the database.`);
    return interaction.editReply({ embeds: [notFoundEmbed] });
  }

  // Fetch current stats for the player
  const { data: currentStats } = await supabase
    .from("player_stats")
    .select("level")
    .eq("player_id", player.id)
    .maybeSingle();

  const oldLevel = currentStats ? (currentStats.level ?? 0) : 0;

  // Update or insert level in player_stats (also sync username if available)
  if (currentStats) {
    const updatePayload = { level: newLevel };
    if (player.username) {
      updatePayload.username = player.username;
    }
    const { error: updateError } = await supabase
      .from("player_stats")
      .update(updatePayload)
      .eq("player_id", player.id);

    if (updateError) {
      console.error("[changelevel] Failed to update player level:", updateError);
      const dbErrEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription(`${EMOJIS.rejected_redo} **Database Error:** Failed to update level: \`${updateError.message}\``);
      return interaction.editReply({ embeds: [dbErrEmbed] });
    }
  } else {
    // If stats row didn't exist yet, insert it
    const insertPayload = {
      player_id: player.id,
      level: newLevel
    };
    if (player.username) {
      insertPayload.username = player.username;
    }
    const { error: insertError } = await supabase
      .from("player_stats")
      .insert(insertPayload);

    if (insertError) {
      console.error("[changelevel] Failed to insert player stats:", insertError);
      const dbErrEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription(`${EMOJIS.rejected_redo} **Database Error:** Failed to record level: \`${insertError.message}\``);
      return interaction.editReply({ embeds: [dbErrEmbed] });
    }
  }

  const guildConfig = await getGuildConfig(interaction.guild.id);
  const embedColor = guildConfig?.embed_color || 0x2b2d31;

  const targetMention = player.discord_id ? `<@${player.discord_id}>` : `\`${player.username}\``;
  const tagPrefix = player.guild_tag ? `[${player.guild_tag}] ` : "";
  const displayName = player.display_name || player.username || "Unknown Driver";

  // Compact, beautiful embed matching UVS theme
  const successEmbed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(
      `### ${EMOJIS.green_tick} Driver Level Updated\n` +
      `**Driver:** ${tagPrefix}**${displayName}** (${targetMention})\n` +
      `**Level:** \`${oldLevel}\` ➔ \`${newLevel}\`\n` +
      `**Discord ID:** \`${player.discord_id || "N/A"}\``
    )
    .setFooter({
      text: `Updated by ${interaction.user.tag}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    })
    .setTimestamp();

  return interaction.editReply({ embeds: [successEmbed] });
}

module.exports = { execute };
