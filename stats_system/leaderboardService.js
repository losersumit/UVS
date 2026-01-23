// stats_system/leaderboardService.js
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");

// Store leaderboard message IDs per guild
const leaderboardMessageIds = new Map(); // guildId -> { distance, time, score, guilds }

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
        } catch {}
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


async function updateLeaderboard(client, guildId) {
  try {
    // Get server-specific config
    const guildConfig = await getGuildConfig(guildId);
    
    if (!guildConfig.leaderboard_channel_id) {
      return; // No leaderboard channel configured for this server
    }
    
    const channel = await client.channels.fetch(guildConfig.leaderboard_channel_id);
    if (!channel) {
      console.error(`Leaderboard channel not found for guild ${guildId}`);
      return;
    }
    
    const guild = channel.guild;
    
    // Get or initialize message IDs for this guild
    if (!leaderboardMessageIds.has(guildId)) {
      leaderboardMessageIds.set(guildId, {
        distance: null,
        time: null,
        score: null,
        guilds: null
      });
    }
    const msgIds = leaderboardMessageIds.get(guildId);

    // ───────────── Distance Leaderboard ─────────────
    // GLOBAL leaderboard - shows all players across all servers
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

    // ───────────── Time Leaderboard ─────────────
    // GLOBAL leaderboard - shows all players across all servers
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

    // ───────────── SCORE + STARS LEADERBOARD ─────────────
    // GLOBAL leaderboard - shows all players across all servers
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

    // ───────────── Send / Edit Helper ─────────────
    async function sendOrEdit(msgId, embed) {
      if (msgId) {
        try {
          const msg = await channel.messages.fetch(msgId);
          await msg.edit({ embeds: [embed] });
          return msg.id;
        } catch (e) {
          console.log("Leaderboard message not found, sending new one...");
        }
      }
      const newMsg = await channel.send({ embeds: [embed] });
      return newMsg.id;
    }

    // ───────────── TOP GUILDS LEADERBOARD ─────────────
    // Rank guilds by SUM(total_score) of all their members
    const { data: guildStats } = await supabase
      .from("player_stats")
      .select(`
        total_score,
        total_time_minutes,
        total_stars,
        total_distance_km,
        players!inner(guild_id, guild_tag)
      `);

    if (guildStats && guildStats.length > 0) {
      // Aggregate by guild_id
      const guildAggregates = new Map();
      
      for (const stat of guildStats) {
        const guildId = stat.players?.guild_id;
        if (!guildId) continue;
        
        if (!guildAggregates.has(guildId)) {
          guildAggregates.set(guildId, {
            guild_id: guildId,
            guild_tag: stat.players?.guild_tag || "",
            total_score: 0,
            total_time_minutes: 0,
            total_stars: 0,
            total_distance_km: 0
          });
        }
        
        const agg = guildAggregates.get(guildId);
        agg.total_score += Number(stat.total_score || 0);
        agg.total_time_minutes += Number(stat.total_time_minutes || 0);
        agg.total_stars += Number(stat.total_stars || 0);
        agg.total_distance_km += Number(stat.total_distance_km || 0);
      }
      
      // Sort by total_score DESC and take TOP 3
      const topGuilds = Array.from(guildAggregates.values())
        .sort((a, b) => b.total_score - a.total_score)
        .slice(0, 3);
      
      if (topGuilds.length > 0) {
        const guildFields = topGuilds.map((g, i) => {
          const hours = Math.floor(g.total_time_minutes / 60);
          const minutes = g.total_time_minutes % 60;
          return {
            name: `#${i + 1} ${g.guild_tag || "Unknown Guild"}`,
            value: `Score: **${Math.round(g.total_score)}**\n` +
                   `Time: ${hours}h ${minutes}m\n` +
                   `Stars: **${g.total_stars}**\n` +
                   `Distance: ${Math.round(g.total_distance_km)} km`,
            inline: false
          };
        });
        
        const guildEmbed = {
          title: "🏆 Top Guilds Leaderboard",
          description: "Ranked by **Total Score** (sum of all members)",
          color: guildConfig.embed_color,
          thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
          fields: guildFields,
          footer: {
            text: `Last updated • ${new Date().toLocaleString()}`
          }
        };
        
        msgIds.guilds = await sendOrEdit(msgIds.guilds, guildEmbed);
      }
    }

    msgIds.distance = await sendOrEdit(msgIds.distance, distanceEmbed);
    msgIds.time = await sendOrEdit(msgIds.time, timeEmbed);
    msgIds.score = await sendOrEdit(msgIds.score, scoreEmbed);

  } catch (err) {
    console.error("Leaderboard update failed:", err);
  }
}

module.exports = { updateLeaderboard };