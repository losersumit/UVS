// stats_system/leaderboardService.js
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");

// Store leaderboard message IDs per guild
const leaderboardMessageIds = new Map(); // guildId -> { distance, time, score }

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
        score: null
      });
    }
    const msgIds = leaderboardMessageIds.get(guildId);

    // ───────────── Distance Leaderboard ─────────────
    // Filter by guild_id to show only players from this server
    const { data: topDistance } = await supabase
      .from("player_stats")
      .select("total_distance_km, players!inner(username, discord_id, guild_tag, guild_id)")
      .eq("players.guild_id", guildId)
      .order("total_distance_km", { ascending: false })
      .limit(10);

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
    const { data: topTime } = await supabase
      .from("player_stats")
      .select("total_time_minutes, players!inner(username, discord_id, guild_tag, guild_id)")
      .eq("players.guild_id", guildId)
      .order("total_time_minutes", { ascending: false })
      .limit(10);

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
    const { data: topScore } = await supabase
      .from("player_stats")
      .select("total_score, total_stars, players!inner(username, discord_id, guild_tag, guild_id)")
      .eq("players.guild_id", guildId)
      .order("total_score", { ascending: false })
      .limit(10);

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

    msgIds.distance = await sendOrEdit(msgIds.distance, distanceEmbed);
    msgIds.time = await sendOrEdit(msgIds.time, timeEmbed);
    msgIds.score = await sendOrEdit(msgIds.score, scoreEmbed);

  } catch (err) {
    console.error("Leaderboard update failed:", err);
  }
}

module.exports = { updateLeaderboard };