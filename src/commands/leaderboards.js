const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { getActiveGuildIds } = require("../helpers");

// ─── Shared helper for standard leaderboard commands ───
async function runLeaderboard(interaction, { statColumn, emoji, title, formatValue }) {
  await interaction.deferReply();
  const isGlobal = interaction.options.getBoolean("global") === true;

  let query = supabase
    .from("player_stats")
    .select(`${statColumn}, players!inner(username, display_name, guild_tag, guild_id)`)
    .gt(statColumn, 0)
    .order(statColumn, { ascending: false })
    .limit(5);

  if (!isGlobal) {
    query = query.eq("players.guild_id", interaction.guild.id);
  } else {
    const activeIds = await getActiveGuildIds();
    if (activeIds.length > 0) query = query.in("players.guild_id", activeIds);
  }

  const { data } = await query;

  if (!data?.length) return interaction.editReply("❌ No records yet.");

  const fields = data.map((row, i) => {
    const tag = row.players?.guild_tag || "";
    return {
      name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
      value: `${emoji} ${formatValue(row[statColumn])}`,
      inline: false
    };
  });

  const guildConfig = await getGuildConfig(interaction.guild.id);
  await interaction.editReply({
    embeds: [{
      title: isGlobal ? `${emoji} Global ${title}` : `${emoji} ${title} (${interaction.guild.name})`,
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields
    }]
  });
}

// ─── Command Handlers ───

async function speedlb(interaction) {
  await runLeaderboard(interaction, {
    statColumn: "best_avg_speed_kmph",
    emoji: "💨",
    title: "Speed Leaderboard",
    formatValue: v => `${v} km/h`
  });
}

async function levellb(interaction) {
  await runLeaderboard(interaction, {
    statColumn: "current_level",
    emoji: "🏅",
    title: "Level Leaderboard",
    formatValue: v => `Level ${v}`
  });
}

async function distancelb(interaction) {
  await runLeaderboard(interaction, {
    statColumn: "total_distance_km",
    emoji: "🛤️",
    title: "Distance Leaderboard",
    formatValue: v => `${Math.round(v).toLocaleString()} km`
  });
}

async function timelb(interaction) {
  await runLeaderboard(interaction, {
    statColumn: "total_time_minutes",
    emoji: "⏱️",
    title: "Driving Time Leaderboard",
    formatValue: v => {
      const hours = Math.floor(v / 60);
      const minutes = v % 60;
      return `${hours}h ${minutes}m`;
    }
  });
}

async function networthlb(interaction) {
  await runLeaderboard(interaction, {
    statColumn: "net_worth",
    emoji: "💰",
    title: "Net Worth Leaderboard",
    formatValue: v => `$${Math.round(v).toLocaleString()}`
  });
}

module.exports = { speedlb, levellb, distancelb, timelb, networthlb };
