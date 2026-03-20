// stats_system/leaderboardService.js
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");

function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${h}h ${m}m`;
}

/**
 * Helper to fetch a list of fields with server nicknames
 */
async function getLeaderboardFields(data, guild, valueFormatter) {
  return Promise.all(
    data.map(async (row, i) => {
      let displayName = row.players?.display_name || row.players?.username || "Unknown";

      const tag = row.players?.guild_tag || "";
      const name = `#${i + 1} ${tag} ${displayName}`.trim();

      return {
        name,
        value: valueFormatter(row),
        inline: false
      };
    })
  );
}

/**
 * Core Logic: Edit existing message (from DB) or Send New & Save to DB
 */
async function sendOrUpdate(guildId, channel, dbColumn, currentId, embed) {
  // 1. Try to Edit if we have an ID
  if (currentId) {
    try {
      const msg = await channel.messages.fetch(currentId);
      await msg.edit({ embeds: [embed] });
      return currentId; // Success, ID didn't change
    } catch (err) {
      console.warn(`[Leaderboard] Message ${currentId} not found/deleted. Sending new...`);
      // Fail silently and proceed to send new one
    }
  }

  // 2. Send New Message
  try {
    const newMsg = await channel.send({ embeds: [embed] });
    console.log(`[Leaderboard] Sent new embed for ${dbColumn} in guild ${guildId} (msg: ${newMsg.id})`);

    // 3. Save new ID to Database immediately
    const { error: saveErr } = await supabase
      .from("approved_guilds")
      .update({ [dbColumn]: newMsg.id })
      .eq("guild_id", guildId);

    if (saveErr) console.error(`[Leaderboard] Failed to save ${dbColumn} message ID:`, saveErr.message);

    return newMsg.id;
  } catch (err) {
    console.error(`[Leaderboard] Failed to send ${dbColumn} for guild ${guildId}:`, err.message);
    return null;
  }
}

const updateQueue = new Map();

async function updateLeaderboard(client, guildId) {
  if (!updateQueue.has(guildId)) {
    updateQueue.set(guildId, { isUpdating: false, needsAnotherUpdate: false });
  }

  const state = updateQueue.get(guildId);

  if (state.isUpdating) {
    state.needsAnotherUpdate = true;
    return;
  }

  state.isUpdating = true;

  try {
    await performLeaderboardUpdate(client, guildId);
  } finally {
    state.isUpdating = false;
    if (state.needsAnotherUpdate) {
      state.needsAnotherUpdate = false;
      // Wait 5 seconds to dodge Discord rate limits before processing the queued update
      setTimeout(() => updateLeaderboard(client, guildId), 5000);
    }
  }
}

async function performLeaderboardUpdate(client, guildId) {
  try {
    // 1. Get Config (colors, branding, channel ID)
    const guildConfig = await getGuildConfig(guildId);

    if (!guildConfig.leaderboard_channel_id) {
      console.warn(`[Leaderboard] Skipping guild ${guildId} — no leaderboard_channel_id set in DB.`);
      return;
    }

    // 2. Get stored message ID (only lb_msg_guilds now — single combined message)
    const { data: guildRow, error } = await supabase
      .from("approved_guilds")
      .select("lb_msg_guilds")
      .eq("guild_id", guildId)
      .single();

    if (error || !guildRow) {
      console.error(`[Leaderboard] Failed to fetch guild row for ${guildId}:`, error?.message);
      return;
    }

    const channel = await client.channels.fetch(guildConfig.leaderboard_channel_id).catch((err) => {
      console.error(`[Leaderboard] Cannot fetch channel ${guildConfig.leaderboard_channel_id} for guild ${guildId}:`, err.message);
      return null;
    });
    if (!channel) return;

    // 3. Fetch all data in parallel
    const [
      { data: guildsData },
      { data: guildStats },
      { data: topDistance },
      { data: topTime }
    ] = await Promise.all([
      supabase.from("approved_guilds").select("guild_id, guild_tag, guild_name, net_worth"),
      supabase.from("player_stats").select("total_score, total_time_minutes, total_stars, total_distance_km, clean_deliveries, players!inner(guild_id)"),
      supabase.from("player_stats")
        .select("total_distance_km, players!inner(username, display_name, guild_tag, guild_id)")
        .order("total_distance_km", { ascending: false })
        .limit(5),
      supabase.from("player_stats")
        .select("total_time_minutes, players!inner(username, display_name, guild_tag, guild_id)")
        .order("total_time_minutes", { ascending: false })
        .limit(5)
    ]);

    // ─── EMBED 1: VTC Global Leaderboard (Top 3) ───
    let guildEmbed = null;
    if (guildsData && guildStats) {
      const guildAggregates = new Map();
      for (const g of guildsData) {
        guildAggregates.set(g.guild_id, {
          guild_id: g.guild_id,
          guild_tag: g.guild_tag || "Unknown",
          guild_name: g.guild_name || "Unknown Server",
          net_worth: Number(g.net_worth) || 0,
          member_count: 0
        });
      }
      for (const stat of guildStats) {
        const gid = stat.players?.guild_id;
        if (!gid || !guildAggregates.has(gid)) continue;
        guildAggregates.get(gid).member_count += 1;
      }

      // Sort all guilds
      const sortedGuilds = Array.from(guildAggregates.values())
        .sort((a, b) => b.net_worth - a.net_worth);

      const top3 = sortedGuilds.slice(0, 3);
      
      const fields = top3.map((g, i) => ({
        name: `#${i + 1} ${g.guild_tag} | ${g.guild_name}`,
        value: `💰 **$${Math.round(g.net_worth).toLocaleString()}** Net Worth  •  👥 ${g.member_count} drivers`,
        inline: false
      }));

      guildEmbed = {
        title: "🏆 VTC Global Leaderboard",
        description: `Top **${top3.length}** VTCs ranked by **Net Worth** • ${sortedGuilds.length} approved VTCs total`,
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields
      };
    }

    // ─── EMBED 2: Distance Leaderboard ───
    const distanceFields = await getLeaderboardFields(
      topDistance || [],
      channel.guild,
      (row) => `${Math.round(row.total_distance_km)} km`
    );
    const distanceEmbed = {
      title: "🛤️ Global Distance Leaderboard",
      color: guildConfig.embed_color,
      fields: distanceFields
    };

    // ─── EMBED 3: Time Leaderboard — footer goes here (last embed) ───
    const timeFields = await getLeaderboardFields(
      topTime || [],
      channel.guild,
      (row) => formatMinutes(row.total_time_minutes)
    );
    const timeEmbed = {
      title: "⏱️ Global Driving Time Leaderboard",
      color: guildConfig.embed_color,
      fields: timeFields,
      footer: { text: `Managed by NMC • Last updated • ${new Date().toLocaleString()}` }
    };

    // 4. Combine into one message: Guild LB → Distance → Time
    const embeds = [
      ...(guildEmbed ? [guildEmbed] : []),
      distanceEmbed,
      timeEmbed
    ];

    // 5. Edit existing message or send new one — stored under lb_msg_guilds
    const currentId = guildRow.lb_msg_guilds;
    if (currentId) {
      try {
        const msg = await channel.messages.fetch(currentId);
        await msg.edit({ embeds });
        return;
      } catch (err) {
        console.warn(`[Leaderboard] Message ${currentId} not found for guild ${guildId}. Sending new...`);
      }
    }

    try {
      const newMsg = await channel.send({ embeds });
      console.log(`[Leaderboard] Sent combined leaderboard for guild ${guildId} (msg: ${newMsg.id})`);
      const { error: saveErr } = await supabase
        .from("approved_guilds")
        .update({ lb_msg_guilds: newMsg.id })
        .eq("guild_id", guildId);
      if (saveErr) console.error(`[Leaderboard] Failed to save lb_msg_guilds for ${guildId}:`, saveErr.message);
    } catch (err) {
      console.error(`[Leaderboard] Failed to send combined leaderboard for ${guildId}:`, err.message);
    }

  } catch (err) {
    console.error("Leaderboard update failed:", err);
  }
}

// ─────────────────────────────────────────────────────────────

// GLOBAL WEBHOOK SUPPORT
// ─────────────────────────────────────────────────────────────
const { WebhookClient } = require('discord.js');
let globalWebhookUpdating = false;
let globalWebhookNeedsUpdate = false;

async function getGlobalLeaderboardFields(client, data, valueFormatter) {
  return Promise.all(
    data.map(async (row, i) => {
      let displayName = row.players?.display_name || row.players?.username || "Unknown";
      const tag = row.players?.guild_tag || "";
      const name = `#${i + 1} ${tag} ${displayName}`.trim();
      return { name, value: valueFormatter(row), inline: false };
    })
  );
}

async function updateGlobalWebhook(client, guildId = null) {
  if (globalWebhookUpdating) {
    globalWebhookNeedsUpdate = true;
    return;
  }
  globalWebhookUpdating = true;
  try {
    await performGlobalWebhookUpdate(client, guildId);
  } finally {
    globalWebhookUpdating = false;
    if (globalWebhookNeedsUpdate) {
      globalWebhookNeedsUpdate = false;
      setTimeout(() => updateGlobalWebhook(client, guildId), 5000);
    }
  }
}

async function performGlobalWebhookUpdate(client, guildId = null) {
  const webhookUrl = process.env.GLOBAL_LB_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const webhookClient = new WebhookClient({ url: webhookUrl });

    // Emojis removed string formatting due to external webhook restrictions

    // ───────────── Guilds Leaderboard ─────────────
    let guildsQuery = supabase
      .from("approved_guilds")
      .select("guild_id, guild_tag, guild_name, net_worth, embed_color, webhook_id:webhook_id::text, avatar_url, runs");

    if (guildId) {
      guildsQuery = guildsQuery.eq("guild_id", guildId);
    }

    const { data: guildsData } = await guildsQuery;

    let guildStatsQuery = supabase
      .from("player_stats")
      .select("total_time_minutes, total_distance_km, players!inner(guild_id)");

    if (guildId) {
      guildStatsQuery = guildStatsQuery.eq("players.guild_id", guildId);
    }

    const { data: guildStats } = await guildStatsQuery;

    if (!guildsData) return;

    const guildAggregates = new Map();
    for (const guild of guildsData) {
      guildAggregates.set(guild.guild_id, {
        ...guild,
        total_income: Number(guild.net_worth) || 0,
        total_runs: Number(guild.runs) || 0,
        total_time_minutes: 0,
        total_distance_km: 0,
        driver_count: 0
      });
    }

    if (guildStats) {
      for (const stat of guildStats) {
        const gid = stat.players?.guild_id;
        if (!gid || !guildAggregates.has(gid)) continue;
        const agg = guildAggregates.get(gid);
        agg.total_time_minutes += Number(stat.total_time_minutes || 0);
        agg.total_distance_km += Number(stat.total_distance_km || 0);
        agg.driver_count += 1;
      }
    }

    for (const guild of guildAggregates.values()) {
      const hours = Math.floor(guild.total_time_minutes / 60);
      const minutes = guild.total_time_minutes % 60;
      let description = `**Net Worth:** $${Math.round(guild.total_income).toLocaleString()}\n`;
      description += `**Drivers:** ${guild.driver_count}\n`;
      description += `**Time:** ${hours}h ${minutes}m\n`;
      description += `**Distance:** ${Math.round(guild.total_distance_km).toLocaleString()} km\n`;
      description += `**Runs:** ${guild.total_runs}`;

      let parsedColor = 0xffffff;
      if (typeof guild.embed_color === 'number') {
        parsedColor = guild.embed_color;
      } else if (typeof guild.embed_color === 'string') {
        parsedColor = parseInt(guild.embed_color.replace('#', ''), 16);
      }
      if (isNaN(parsedColor) || parsedColor > 16777215 || parsedColor < 0) {
        parsedColor = 0xffffff;
      }

      const embed = {
        title: `🏢 ${guild.guild_tag || "[VTC]"} ${guild.guild_name || "Unknown Guild"}`,
        description,
        color: parsedColor,
        thumbnail: guild.avatar_url ? { url: guild.avatar_url } : undefined,
        footer: { text: `Managed by NMC • Last updated • ${new Date().toLocaleString()}` }
      };

      const messageId = guild.webhook_id ? String(guild.webhook_id).trim() : null;

      if (messageId) {
        try {
          await webhookClient.editMessage(messageId, { content: null, embeds: [embed] });
          continue;
        } catch (err) {
          console.warn(`[Global Webhook] Failed to edit msg ${messageId} for ${guild.guild_name} (${err.message}). Sending new msg...`);
        }
      }

      try {
        const sentMessage = await webhookClient.send({ content: null, embeds: [embed] });
        console.log(`[Global Webhook] Sent new embed for ${guild.guild_name} with ID ${sentMessage.id}`);

        // Save the new message ID so future updates can edit it instead of re-sending
        const { error: saveErr } = await supabase
          .from("approved_guilds")
          .update({ webhook_id: sentMessage.id })
          .eq("guild_id", guild.guild_id);

        if (saveErr) console.error(`[Global Webhook] Failed to save webhook_id for ${guild.guild_name}:`, saveErr.message);
      } catch (err) {
        console.error(`[Global Webhook] Failed to send new msg for ${guild.guild_name}:`, err.message);
      }
    }

  } catch (err) {
    console.error("Global Webhook update failed:", err);
  }
}

module.exports = { updateLeaderboard, updateGlobalWebhook };
