/**
 * ============================================================================
 * MODULE: connect.js
 * PURPOSE: Implements the /connect slash command that allows VTCs to establish
 *          real-time cross-server communication channels. Handles the full
 *          lifecycle: VTC selection, connection requests, acceptance/decline,
 *          and termination of active connections.
 * ============================================================================
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder
} = require("discord.js");
const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { activeCalls, isGuildInCall, terminateCall } = require("../callManager");
const crypto = require("crypto");

// ─── SLASH COMMAND HANDLER ───
async function execute(interaction) {
  const callerGuildId = interaction.guild.id;
  const callerGuildConfig = await getGuildConfig(callerGuildId);

  // Check if this guild is already in a call
  if (isGuildInCall(callerGuildId)) {
    return interaction.reply({
      content: "⚠️ Your organisation is already engaged in an active connection. Please terminate the current session before initiating a new one.",
      ephemeral: true
    });
  }

  // Fetch all non-suspended, approved VTCs except the caller
  const { data: guilds, error } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag, call_channel_id, avatar_url, embed_color")
    .eq("is_suspended", false)
    .neq("guild_id", callerGuildId)
    .order("guild_name", { ascending: true });

  if (error) {
    console.error("[Connect] Failed to fetch guilds:", error);
    return interaction.reply({
      content: "❌ An error occurred while retrieving the organisation directory.",
      ephemeral: true
    });
  }

  if (!guilds || guilds.length === 0) {
    return interaction.reply({
      content: "⚠️ No other registered organisations are currently available.",
      ephemeral: true
    });
  }

  // Build the select menu with all VTCs
  const options = guilds.map(g => ({
    label: g.guild_name || g.guild_tag || "Unknown",
    description: g.guild_tag ? `Tag: ${g.guild_tag}` : undefined,
    value: g.guild_id
  }));

  // Discord allows max 25 options in a select menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("connect_select_vtc")
    .setPlaceholder("Select an organisation to connect with")
    .addOptions(options.slice(0, 25));

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const selectionEmbed = new EmbedBuilder()
    .setTitle("📡  Establish Connection")
    .setDescription("Select the organisation you wish to connect with from the directory below.")
    .setColor(callerGuildConfig.embed_color || 0xff7801)
    .setTimestamp()
    .setFooter({ text: "Connection Service • Organisation Directory" });

  await interaction.reply({ embeds: [selectionEmbed], components: [row] });
}

// ─── SELECT MENU HANDLER ───
async function handleSelectMenu(interaction) {
  if (interaction.customId !== "connect_select_vtc") return;

  const callerGuildId = interaction.guild.id;
  const targetGuildId = interaction.values[0];

  // Re-check if caller is already in a call
  if (isGuildInCall(callerGuildId)) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️  Connection Unavailable")
          .setDescription("Your organisation is already engaged in an active connection.")
          .setColor(0xff0000)
          .setTimestamp()
      ],
      components: []
    });
  }

  // Re-check if target is already in a call
  if (isGuildInCall(targetGuildId)) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️  Line Busy")
          .setDescription("The selected organisation is currently engaged in another connection. Please try again later.")
          .setColor(0xff0000)
          .setTimestamp()
      ],
      components: []
    });
  }

  // Fetch target guild config
  const { data: targetGuild, error } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag, call_channel_id, avatar_url, embed_color")
    .eq("guild_id", targetGuildId)
    .maybeSingle();

  if (error || !targetGuild) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌  Error")
          .setDescription("Failed to retrieve the target organisation's information.")
          .setColor(0xff0000)
          .setTimestamp()
      ],
      components: []
    });
  }

  // Check if target has a call channel configured
  if (!targetGuild.call_channel_id) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️  Unavailable")
          .setDescription("The requested company is currently out of reach.")
          .setColor(0xffa500)
          .setTimestamp()
      ],
      components: []
    });
  }

  // Fetch caller guild info
  const callerGuildConfig = await getGuildConfig(callerGuildId);
  const callerGuildName = callerGuildConfig.guild_name || callerGuildConfig.guild_tag || interaction.guild.name;
  const targetGuildName = targetGuild.guild_name || targetGuild.guild_tag || "Unknown Organisation";

  // Generate unique call ID
  const callId = crypto.randomUUID();

  // ─── Post incoming call embed in target's call_channel_id ───
  let targetChannel;
  try {
    targetChannel = await interaction.client.channels.fetch(targetGuild.call_channel_id);
  } catch (err) {
    console.error("[Connect] Cannot access target call channel:", err);
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️  Unavailable")
          .setDescription("The requested company is currently out of reach.")
          .setColor(0xffa500)
          .setTimestamp()
      ],
      components: []
    });
  }

  const incomingEmbed = new EmbedBuilder()
    .setTitle("📞  Incoming Connection Request")
    .setDescription(`**${callerGuildName}** is requesting to establish a communication channel with your organisation.`)
    .setColor(0x5865f2)
    .setTimestamp()
    .setFooter({ text: "Connection Service • Respond within 60 seconds" });

  const incomingButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`connect_establish_${callId}`)
      .setLabel("Establish Connection")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`connect_decline_${callId}`)
      .setLabel("Decline Connection")
      .setStyle(ButtonStyle.Danger)
  );

  let targetMessage;
  try {
    targetMessage = await targetChannel.send({ embeds: [incomingEmbed], components: [incomingButtons] });
  } catch (err) {
    console.error("[Connect] Failed to send to target channel:", err);
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️  Unavailable")
          .setDescription("The requested company is currently out of reach.")
          .setColor(0xffa500)
          .setTimestamp()
      ],
      components: []
    });
  }

  // ─── Update caller's embed ───
  const pendingEmbed = new EmbedBuilder()
    .setTitle("📡  Connection Request Transmitted")
    .setDescription(`Awaiting acknowledgement from **${targetGuildName}**.\nThis request will expire in 60 seconds.`)
    .setColor(0x5865f2)
    .setTimestamp()
    .setFooter({ text: "Connection Service • Awaiting Response" });

  await interaction.update({ embeds: [pendingEmbed], components: [] });

  // Fetch the caller's message (the reply to the interaction)
  let callerMessage;
  try {
    callerMessage = await interaction.fetchReply();
  } catch (err) {
    console.error("[Connect] Failed to fetch caller reply:", err);
  }

  // ─── Set up the 60s timeout ───
  const timeoutId = setTimeout(async () => {
    const call = activeCalls.get(callId);
    if (!call || call.status !== "pending") return;

    // Timeout — update both embeds
    const timeoutEmbed = new EmbedBuilder()
      .setTitle("⏱️  Connection Timed Out")
      .setColor(0x2b2d31)
      .setTimestamp()
      .setFooter({ text: "Connection Service" });

    // Edit caller embed
    try {
      if (callerMessage) {
        await callerMessage.edit({ embeds: [timeoutEmbed], components: [] });
      }
    } catch (err) {
      console.error("[Connect] Failed to edit caller timeout:", err);
    }

    // Edit target embed
    try {
      if (targetMessage) {
        await targetMessage.edit({ embeds: [timeoutEmbed], components: [] });
      }
    } catch (err) {
      console.error("[Connect] Failed to edit target timeout:", err);
    }

    activeCalls.delete(callId);
    console.log(`[Connect] Call ${callId} timed out.`);
  }, 60_000);

  // ─── Store call state ───
  activeCalls.set(callId, {
    status: "pending",
    callerGuildId,
    callerGuildName,
    callerChannelId: interaction.channel.id,
    callerMessageId: callerMessage?.id || null,
    targetGuildId,
    targetGuildName,
    targetChannelId: targetGuild.call_channel_id,
    targetMessageId: targetMessage.id,
    startTime: null,
    timeoutId,
    participants: {
      [callerGuildId]: new Set(),
      [targetGuildId]: new Set()
    }
  });

  console.log(`[Connect] Call ${callId} initiated: ${callerGuildName} → ${targetGuildName}`);
}

// ─── BUTTON HANDLER ───
async function handleButton(interaction) {
  const customId = interaction.customId;

  if (customId.startsWith("connect_establish_")) {
    return handleEstablish(interaction);
  }
  if (customId.startsWith("connect_decline_")) {
    return handleDecline(interaction);
  }
  if (customId.startsWith("connect_terminate_")) {
    return handleTerminate(interaction);
  }
}

// ─── ESTABLISH CONNECTION ───
async function handleEstablish(interaction) {
  const callId = interaction.customId.replace("connect_establish_", "");
  const call = activeCalls.get(callId);

  if (!call || call.status !== "pending") {
    return interaction.reply({
      content: "⚠️ This connection request is no longer active.",
      ephemeral: true
    });
  }

  // Clear the timeout
  clearTimeout(call.timeoutId);
  call.timeoutId = null;
  call.status = "active";
  call.startTime = Date.now();

  // ─── Update target embed (the one with the buttons) ───
  const targetActiveEmbed = new EmbedBuilder()
    .setTitle("✅  Connection Established")
    .setDescription(`A communication channel with **${call.callerGuildName}** is now active.\nAll messages in this channel will be relayed to the connected party.`)
    .setColor(0x57f287)
    .setTimestamp()
    .setFooter({ text: "Connection Service • Active" });

  const terminateRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`connect_terminate_${callId}`)
      .setLabel("Terminate Connection")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.update({ embeds: [targetActiveEmbed], components: [terminateRow] });

  // ─── Update caller embed ───
  try {
    const callerChannel = await interaction.client.channels.fetch(call.callerChannelId);
    if (callerChannel && call.callerMessageId) {
      const callerMsg = await callerChannel.messages.fetch(call.callerMessageId).catch(() => null);
      if (callerMsg) {
        const callerActiveEmbed = new EmbedBuilder()
          .setTitle("✅  Connection Established")
          .setDescription(`A communication channel with **${call.targetGuildName}** is now active.\nAll messages in this channel will be relayed to the connected party.`)
          .setColor(0x57f287)
          .setTimestamp()
          .setFooter({ text: "Connection Service • Active" });

        const callerTerminateRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`connect_terminate_${callId}`)
            .setLabel("Terminate Connection")
            .setStyle(ButtonStyle.Danger)
        );

        await callerMsg.edit({ embeds: [callerActiveEmbed], components: [callerTerminateRow] });
      }
    }
  } catch (err) {
    console.error("[Connect] Failed to update caller embed on establish:", err);
  }

  console.log(`[Connect] Call ${callId} established: ${call.callerGuildName} ↔ ${call.targetGuildName}`);
}

// ─── DECLINE CONNECTION ───
async function handleDecline(interaction) {
  const callId = interaction.customId.replace("connect_decline_", "");
  const call = activeCalls.get(callId);

  if (!call || call.status !== "pending") {
    return interaction.reply({
      content: "⚠️ This connection request is no longer active.",
      ephemeral: true
    });
  }

  // Clear timeout
  clearTimeout(call.timeoutId);
  call.timeoutId = null;

  // Update target embed (the one being interacted with)
  const declinedEmbed = new EmbedBuilder()
    .setTitle("🚫  Connection Declined")
    .setDescription(`The connection request from **${call.callerGuildName}** has been declined.`)
    .setColor(0xed4245)
    .setTimestamp()
    .setFooter({ text: "Connection Service" });

  await interaction.update({ embeds: [declinedEmbed], components: [] });

  // Update caller embed
  try {
    const callerChannel = await interaction.client.channels.fetch(call.callerChannelId);
    if (callerChannel && call.callerMessageId) {
      const callerMsg = await callerChannel.messages.fetch(call.callerMessageId).catch(() => null);
      if (callerMsg) {
        const callerDeclinedEmbed = new EmbedBuilder()
          .setTitle("🚫  Connection Declined")
          .setDescription(`The connection request has been declined by **${call.targetGuildName}**.`)
          .setColor(0xed4245)
          .setTimestamp()
          .setFooter({ text: "Connection Service" });

        await callerMsg.edit({ embeds: [callerDeclinedEmbed], components: [] });
      }
    }
  } catch (err) {
    console.error("[Connect] Failed to update caller embed on decline:", err);
  }

  activeCalls.delete(callId);
  console.log(`[Connect] Call ${callId} declined by ${call.targetGuildName}`);
}

// ─── TERMINATE CONNECTION ───
async function handleTerminate(interaction) {
  const callId = interaction.customId.replace("connect_terminate_", "");
  const call = activeCalls.get(callId);

  if (!call || call.status !== "active") {
    return interaction.reply({
      content: "⚠️ There is no active connection to terminate.",
      ephemeral: true
    });
  }

  await interaction.deferUpdate();
  await terminateCall(interaction.client, callId);
}

module.exports = {
  execute,
  handleSelectMenu,
  handleButton
};
