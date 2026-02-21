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
  return await Promise.all(
    data.map(async (row, i) => {
      let displayName = row.players?.username || "Unknown";

      if (row.players?.discord_id) {
        try {
          const member = await guild.members
            .fetch(row.players.discord_id)
            .catch(() => null);
          if (member) displayName = member.displayName;
        } catch { }
      }

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

    // 3. Save new ID to Database immediately
    await supabase
      .from("approved_guilds")
      .update({ [dbColumn]: newMsg.id })
      .eq("guild_id", guildId);

    return newMsg.id;
  } catch (err) {
    console.error(`[Leaderboard] Failed to send/save ${dbColumn}:`, err.message);
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

    if (!guildConfig.leaderboard_channel_id) return;

    // 2. Get Message IDs directly from DB (ensures persistence across restarts)
    const { data: guildRow, error } = await supabase
      .from("approved_guilds")
      .select("lb_msg_distance, lb_msg_time, lb_msg_score, lb_msg_guilds")
      .eq("guild_id", guildId)
      .single();

    if (error || !guildRow) return;

    const channel = await client.channels.fetch(guildConfig.leaderboard_channel_id).catch(() => null);
    if (!channel) {
      console.error(`Leaderboard channel not found for guild ${guildId}`);
      return;
    }

    const guild = channel.guild;

    // ───────────── Distance Leaderboard ─────────────
    const { data: topDistance } = await supabase
      .from("player_stats")
      .select("total_distance_km, players!inner(username, discord_id, guild_tag, guild_id)")
      .order("total_distance_km", { ascending: false })
      .limit(5);

    const distanceFields = await getLeaderboardFields(
      topDistance || [],
      guild,
      (row) => `${Math.round(row.total_distance_km)} km`
    );

    const distanceEmbed = {
      title: "🏆 Distance Leaderboard",
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields: distanceFields
    };

    await sendOrUpdate(guildId, channel, "lb_msg_distance", guildRow.lb_msg_distance, distanceEmbed);

    // ───────────── Time Leaderboard ─────────────
    const { data: topTime } = await supabase
      .from("player_stats")
      .select("total_time_minutes, players!inner(username, discord_id, guild_tag, guild_id)")
      .order("total_time_minutes", { ascending: false })
      .limit(5);

    const timeFields = await getLeaderboardFields(
      topTime || [],
      guild,
      (row) => formatMinutes(row.total_time_minutes)
    );

    const timeEmbed = {
      title: "⏱️ Driving Time Leaderboard",
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields: timeFields
    };

    await sendOrUpdate(guildId, channel, "lb_msg_time", guildRow.lb_msg_time, timeEmbed);

    // ───────────── Top Guilds Leaderboard ─────────────
    // Fetch all approved guilds and their current net_worth
    const { data: guildsData } = await supabase
      .from("approved_guilds")
      .select("guild_id, guild_tag, net_worth");

    const { data: guildStats } = await supabase
      .from("player_stats")
      .select(`
        total_score,
        total_time_minutes,
        total_stars,
        total_distance_km,
        players!inner(guild_id)
      `);

    if (guildsData && guildStats) {
      const guildAggregates = new Map();

      // Initialize map with guild data
      for (const guild of guildsData) {
        guildAggregates.set(guild.guild_id, {
          guild_id: guild.guild_id,
          guild_tag: guild.guild_tag || "Unknown Guild",
          total_income: Number(guild.net_worth) || 0, // Read net_worth
          total_score: 0,
          total_time_minutes: 0,
          total_stars: 0,
          total_distance_km: 0
        });
      }

      // Aggregate player stats into their respective guilds
      for (const stat of guildStats) {
        const gid = stat.players?.guild_id;
        if (!gid || !guildAggregates.has(gid)) continue;

        const agg = guildAggregates.get(gid);
        agg.total_score += Number(stat.total_score || 0);
        agg.total_time_minutes += Number(stat.total_time_minutes || 0);
        agg.total_stars += Number(stat.total_stars || 0);
        agg.total_distance_km += Number(stat.total_distance_km || 0);
      }

      // Rank by Income (net_worth)
      const topGuilds = Array.from(guildAggregates.values())
        .sort((a, b) => b.total_income - a.total_income)
        .slice(0, 3);

      if (topGuilds.length > 0) {
        const guildFields = topGuilds.map((g, i) => {
          const hours = Math.floor(g.total_time_minutes / 60);
          const minutes = g.total_time_minutes % 60;
          return {
            name: `#${i + 1} ${g.guild_tag}`,
            value: `Income: **$${Math.round(g.total_income).toLocaleString()}**\n` +
              `Score: **${Math.round(g.total_score).toLocaleString()}**\n` +
              `Time: ${hours}h ${minutes}m\n` +
              `Stars: **${Math.round(g.total_stars).toLocaleString()}**\n` +
              `Distance: ${Math.round(g.total_distance_km).toLocaleString()} km`,
            inline: false
          };
        });

        const guildEmbed = {
          title: "🏆 Top Guilds Leaderboard",
          description: "Ranked by **Net Worth**",
          color: guildConfig.embed_color,
          thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
          fields: guildFields,
          footer: {
            text: `Last updated • ${new Date().toLocaleString()}`
          }
        };

        await sendOrUpdate(guildId, channel, "lb_msg_guilds", guildRow.lb_msg_guilds, guildEmbed);
      }
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
      let displayName = row.players?.username || "Unknown";
      if (row.players?.discord_id) {
        try {
          const user = await client.users.fetch(row.players.discord_id).catch(() => null);
          if (user) displayName = user.displayName || user.username;
        } catch { }
      }
      const tag = row.players?.guild_tag || "";
      const name = `#${i + 1} ${tag} ${displayName}`.trim();
      return { name, value: valueFormatter(row), inline: false };
    })
  );
}

async function updateGlobalWebhook(client) {
  if (globalWebhookUpdating) {
    globalWebhookNeedsUpdate = true;
    return;
  }
  globalWebhookUpdating = true;
  try {
    await performGlobalWebhookUpdate(client);
  } finally {
    globalWebhookUpdating = false;
    if (globalWebhookNeedsUpdate) {
      globalWebhookNeedsUpdate = false;
      setTimeout(() => updateGlobalWebhook(client), 5000);
    }
  }
}

async function performGlobalWebhookUpdate(client) {
  const webhookUrl = process.env.GLOBAL_LB_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const webhookClient = new WebhookClient({ url: webhookUrl });

    // Helper to fetch user avatar
    const getAvatarUrl = async (discordId) => {
      try {
        const user = await client.users.fetch(discordId);
        return user ? user.displayAvatarURL({ extension: 'png', size: 256 }) : null;
      } catch {
        return null;
      }
    };

    // Helper to fetch guild info (for avatar)
    const getGuildAvatarUrl = async (guildId) => {
      try {
        const guild = await client.guilds.fetch(guildId);
        return guild ? guild.iconURL({ extension: 'png', size: 256 }) : null;
      } catch {
        return null;
      }
    };

    // ───────────── Guilds Leaderboard ─────────────
    const { data: guildsData } = await supabase.from("approved_guilds").select("guild_id, guild_tag, net_worth");
    const { data: guildStats } = await supabase.from("player_stats").select("total_score, total_time_minutes, total_stars, total_distance_km, players!inner(guild_id)");

    let guildEmbed = { title: "🏆 Top Global Guilds", description: "Ranked by **Net Worth**", color: 0xff7801, fields: [] };
    
    if (guildsData && guildStats) {
      const guildAggregates = new Map();
      for (const guild of guildsData) {
        guildAggregates.set(guild.guild_id, {
          guild_id: guild.guild_id,
          guild_tag: guild.guild_tag || "Unknown Guild", total_income: Number(guild.net_worth) || 0,
          total_score: 0, total_time_minutes: 0, total_stars: 0, total_distance_km: 0
        });
      }
      for (const stat of guildStats) {
        const gid = stat.players?.guild_id;
        if (!gid || !guildAggregates.has(gid)) continue;
        const agg = guildAggregates.get(gid);
        agg.total_score += Number(stat.total_score || 0);
        agg.total_time_minutes += Number(stat.total_time_minutes || 0);
        agg.total_stars += Number(stat.total_stars || 0);
        agg.total_distance_km += Number(stat.total_distance_km || 0);
      }
      const topGuilds = Array.from(guildAggregates.values()).sort((a, b) => b.total_income - a.total_income).slice(0, 3);
      if (topGuilds.length > 0) {
        guildEmbed.fields = topGuilds.map((g, i) => {
          const hours = Math.floor(g.total_time_minutes / 60);
          const minutes = g.total_time_minutes % 60;
          return {
            name: `#${i + 1} ${g.guild_tag}`,
            value: `Income: **$${Math.round(g.total_income).toLocaleString()}**\nScore: **${Math.round(g.total_score).toLocaleString()}**\nTime: ${hours}h ${minutes}m\nStars: **${Math.round(g.total_stars).toLocaleString()}**\nDistance: ${Math.round(g.total_distance_km).toLocaleString()} km`,
            inline: false
          };
        });
        
        // Fetch #1 Guild Logo for Thumbnail
        const topGuildId = topGuilds[0].guild_id;
        if (topGuildId) {
          const guildAvatar = await getGuildAvatarUrl(topGuildId);
          if (guildAvatar) guildEmbed.thumbnail = { url: guildAvatar };
        }
      }
    }

    // ───────────── Distance Leaderboard ─────────────
    const { data: topDistance } = await supabase.from("player_stats").select("total_distance_km, players!inner(username, discord_id, guild_tag, guild_id)").order("total_distance_km", { ascending: false }).limit(5);
    const distanceFields = await getGlobalLeaderboardFields(client, topDistance || [], (row) => `${Math.round(row.total_distance_km)} km`);
    const distanceEmbed = { title: "🏆 Global Distance Leaderboard", color: 0xff7801, fields: distanceFields };

    if (topDistance && topDistance.length > 0 && topDistance[0].players?.discord_id) {
       const userAvatar = await getAvatarUrl(topDistance[0].players.discord_id);
       if (userAvatar) distanceEmbed.thumbnail = { url: userAvatar };
    }

    // ───────────── Time Leaderboard ─────────────
    const { data: topTime } = await supabase.from("player_stats").select("total_time_minutes, players!inner(username, discord_id, guild_tag, guild_id)").order("total_time_minutes", { ascending: false }).limit(5);
    const timeFields = await getGlobalLeaderboardFields(client, topTime || [], (row) => formatMinutes(row.total_time_minutes));
    
    const timeEmbed = { 
      title: "⏱️ Global Driving Time Leaderboard", 
      color: 0xff7801, 
      fields: timeFields,
      footer: { text: `Managed by NMC • Last updated • ${new Date().toLocaleString()}` }
    };

    if (topTime && topTime.length > 0 && topTime[0].players?.discord_id) {
       const userAvatar = await getAvatarUrl(topTime[0].players.discord_id);
       if (userAvatar) timeEmbed.thumbnail = { url: userAvatar };
    }

    // Combine them (Guilds first, then Distance, then Time)
    const embeds = [guildEmbed, distanceEmbed, timeEmbed];
    const msgId = process.env.GLOBAL_LB_WEBHOOK_MSG_ID;
    
    if (msgId && msgId.trim().length > 0) {
      try {
        await webhookClient.editMessage(msgId, { content: null, embeds });
      } catch (err) {
        console.warn("[Global Webhook] Failed to edit. Check if MSG_ID is correct.", err.message);
      }
    } else {
      await webhookClient.send({ content: null, embeds });
    }
  } catch (err) {
    console.error("Global Webhook update failed:", err);
  }
}

module.exports = { updateLeaderboard, updateGlobalWebhook };