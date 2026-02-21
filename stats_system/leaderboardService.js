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

async function updateLeaderboard(client, guildId) {
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

    // ───────────── Score Leaderboard ─────────────
    const { data: topScore } = await supabase
      .from("player_stats")
      .select("total_score, total_stars, players!inner(username, discord_id, guild_tag, guild_id)")
      .order("total_score", { ascending: false })
      .limit(5);

    const scoreFields = await getLeaderboardFields(
      topScore || [],
      guild,
      (row) => `Score: **${Math.round(row.total_score)}**\nStars: **${row.total_stars}**`
    );

    const scoreEmbed = {
      title: "⭐ Career Score Leaderboard",
      description: "Ranked by **Total Score**",
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields: scoreFields,
      footer: {
        text: `Last updated • ${new Date().toLocaleString()}`
      }
    };

    await sendOrUpdate(guildId, channel, "lb_msg_score", guildRow.lb_msg_score, scoreEmbed);

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

module.exports = { updateLeaderboard };