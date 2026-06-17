/**
 * ============================================================================
 * MODULE: callManager.js
 * PURPOSE: Manages the in-memory state for cross-server VTC calls initiated
 *          via the /connect command. Handles call lifecycle, participant
 *          tracking, and message forwarding between connected channels.
 * ============================================================================
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// ─── Active Calls Store ───
// Map<callId, CallState>
const activeCalls = new Map();

/**
 * Look up an active or pending call that involves a given channel.
 * Returns { callId, call, side } where side is 'caller' | 'target'.
 */
function getCallByChannel(channelId) {
  for (const [callId, call] of activeCalls) {
    if (call.callerChannelId === channelId) {
      return { callId, call, side: "caller" };
    }
    if (call.targetChannelId === channelId) {
      return { callId, call, side: "target" };
    }
  }
  return null;
}

/**
 * Check if a guild is currently involved in any call (pending or active).
 */
function isGuildInCall(guildId) {
  for (const [, call] of activeCalls) {
    if (call.callerGuildId === guildId || call.targetGuildId === guildId) {
      return true;
    }
  }
  return false;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. "2m 34s" or "0m 12s"
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * Handle message forwarding for active calls.
 * Called from the messageCreate event in index.js.
 */
async function handleCallMessage(message) {
  // Ignore bot messages
  if (message.author.bot) return;

  const result = getCallByChannel(message.channel.id);
  if (!result) return;

  const { call } = result;

  // Only forward messages during active calls
  if (call.status !== "active") return;

  // Determine which side sent the message and where to forward
  const isCaller = message.channel.id === call.callerChannelId;
  const senderGuildId = isCaller ? call.callerGuildId : call.targetGuildId;
  const senderTag = isCaller ? (call.callerGuildTag || call.callerGuildName) : (call.targetGuildTag || call.targetGuildName);
  const targetChannelId = isCaller ? call.targetChannelId : call.callerChannelId;

  // Track participant
  if (!call.participants[senderGuildId]) {
    call.participants[senderGuildId] = new Set();
  }
  call.participants[senderGuildId].add(message.author.id);

  // Build the forwarded message content
  const prefix = `**[${senderTag}]** : `;
  const content = message.content ? `${prefix}${message.content}` : prefix;

  // Collect attachments
  const files = message.attachments.map(att => ({
    attachment: att.url,
    name: att.name
  }));

  // Forward to the other channel
  try {
    const targetChannel = await message.client.channels.fetch(targetChannelId);
    if (targetChannel) {
      await targetChannel.send({
        content,
        files: files.length > 0 ? files : undefined
      });
    }
  } catch (err) {
    console.error("[CallManager] Failed to forward message:", err);
  }
}

/**
 * Terminate a call and post summary embeds to both channels.
 */
async function terminateCall(client, callId) {
  const call = activeCalls.get(callId);
  if (!call) return;

  // Clear timeout if still running
  if (call.timeoutId) {
    clearTimeout(call.timeoutId);
    call.timeoutId = null;
  }

  const duration = call.startTime ? Date.now() - call.startTime : 0;
  const durationStr = formatDuration(duration);

  // Build summary embeds — each side only sees their own participants
  const buildSummaryEmbed = (guildId, guildName, otherGuildName) => {
    const participantSet = call.participants[guildId];
    const participantList = participantSet && participantSet.size > 0
      ? Array.from(participantSet).map(id => `<@${id}>`).join("\n")
      : "*No participants recorded.*";

    return new EmbedBuilder()
      .setTitle("📋  Communication Log")
      .setDescription(`The communication channel with **${otherGuildName}** has been terminated.`)
      .addFields(
        { name: "Duration", value: durationStr, inline: true },
        { name: "Participants", value: participantList, inline: true }
      )
      .setColor(0x2b2d31)
      .setTimestamp()
      .setFooter({ text: `${guildName} • Connection Summary` });
  };

  // Post summary to caller channel
  try {
    const callerChannel = await client.channels.fetch(call.callerChannelId);
    if (callerChannel) {
      const embed = buildSummaryEmbed(call.callerGuildId, call.callerGuildName, call.targetGuildName);
      await callerChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("[CallManager] Failed to post caller summary:", err);
  }

  // Post summary to target channel
  try {
    const targetChannel = await client.channels.fetch(call.targetChannelId);
    if (targetChannel) {
      const embed = buildSummaryEmbed(call.targetGuildId, call.targetGuildName, call.callerGuildName);
      await targetChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("[CallManager] Failed to post target summary:", err);
  }

  // Edit both embeds to remove the Terminate button
  const terminatedEmbed = new EmbedBuilder()
    .setTitle("📋  Connection Terminated")
    .setDescription(`The communication channel has been closed.\n**Duration:** ${durationStr}`)
    .setColor(0x2b2d31)
    .setTimestamp();

  try {
    const callerChannel = await client.channels.fetch(call.callerChannelId);
    if (callerChannel && call.callerMessageId) {
      const msg = await callerChannel.messages.fetch(call.callerMessageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [terminatedEmbed], components: [] });
    }
  } catch (err) {
    console.error("[CallManager] Failed to edit caller embed on terminate:", err);
  }

  try {
    const targetChannel = await client.channels.fetch(call.targetChannelId);
    if (targetChannel && call.targetMessageId) {
      const msg = await targetChannel.messages.fetch(call.targetMessageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [terminatedEmbed], components: [] });
    }
  } catch (err) {
    console.error("[CallManager] Failed to edit target embed on terminate:", err);
  }

  // Clean up
  activeCalls.delete(callId);
  console.log(`[CallManager] Call ${callId} terminated. Duration: ${durationStr}`);
}

module.exports = {
  activeCalls,
  getCallByChannel,
  isGuildInCall,
  formatDuration,
  handleCallMessage,
  terminateCall
};
