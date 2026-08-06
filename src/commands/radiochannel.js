/**
 * ============================================================================
 * MODULE: radiochannel.js
 * PURPOSE: Implements the /setradiochannel slash command. Allows VTCs to
 *          configure the Discord channel where incoming radio transmissions
 *          are delivered (call_channel_id in approved_guilds).
 * ============================================================================
 */

const { EmbedBuilder, ChannelType } = require("discord.js");
const { supabase } = require("../stats_system/supabase");

async function setradiochannel(interaction) {
  // Radio module is disabled in the HQ server
  if (interaction.guild.id === process.env.HQ_GUILD_ID) return;

  const channel = interaction.options.getChannel("channel");

  await interaction.deferReply(); // non-ephemeral

  // ── 1. Verify the channel is a text-based channel ──────────────────────────
  const textBased = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ];

  if (!textBased.includes(channel.type)) {
    const embed = new EmbedBuilder()
      .setTitle("📡  Invalid Channel Type")
      .setDescription(
        `<#${channel.id}> is not a text-based channel.\n\nPlease select a **text channel** or **announcement channel** that the bot can send messages to.`
      )
      .setColor(0xe74c3c)
      .setTimestamp()
      .setFooter({ text: "Radio Service · Channel Setup" });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── 2. Verify the bot can actually see & send in that channel ───────────────
  const botMember = interaction.guild.members.me;
  const perms = channel.permissionsFor(botMember);

  const canViewAndSend =
    perms &&
    perms.has("ViewChannel") &&
    perms.has("SendMessages");

  if (!canViewAndSend) {
    const embed = new EmbedBuilder()
      .setTitle("🔒  Access Denied")
      .setDescription(
        `I do **not** have access to <#${channel.id}>.\n\nPlease ensure I have the **View Channel** and **Send Messages** permissions in that channel, then try again.`
      )
      .setColor(0xe74c3c)
      .setTimestamp()
      .setFooter({ text: "Radio Service · Channel Setup" });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── 3. Persist to database ─────────────────────────────────────────────────
  const { error } = await supabase
    .from("approved_guilds")
    .update({ call_channel_id: channel.id })
    .eq("guild_id", interaction.guild.id);

  if (error) {
    console.error("[RadioChannel] Failed to update call_channel_id:", error);
    const embed = new EmbedBuilder()
      .setTitle("⚠️  Database Error")
      .setDescription(
        "An unexpected error occurred while saving your radio channel configuration. Please try again later."
      )
      .setColor(0xe74c3c)
      .setTimestamp()
      .setFooter({ text: "Radio Service · Channel Setup" });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── 4. Success ─────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle("📡  Radio Channel Configured")
    .setDescription(
      `All incoming radio transmissions for **${interaction.guild.name}** will now be delivered to <#${channel.id}>.\n\n` +
      `Make sure your radio frequency is also set via \`/setradiofrequency\` so other VTCs can reach you.`
    )
    .addFields(
      { name: "Channel", value: `<#${channel.id}>`, inline: true },
      { name: "Channel ID", value: `\`${channel.id}\``, inline: true }
    )
    .setColor(0xff7801)
    .setTimestamp()
    .setFooter({ text: "Radio Service · Channel Setup" });

  return interaction.editReply({ embeds: [embed] });
}

module.exports = { execute: setradiochannel };
