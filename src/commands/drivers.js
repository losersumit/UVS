const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { getActiveGuildIds } = require("../helpers");

async function worstdrivers(interaction) {
  await interaction.deferReply();
  const isGlobal = interaction.options.getBoolean("global") === true;

  let query = supabase
    .from("player_stats")
    .select("total_damage_penalty, total_time_penalty, players!inner(username, display_name, guild_tag, guild_id)");

  if (!isGlobal) {
    query = query.eq("players.guild_id", interaction.guild.id);
  } else {
    const activeIds = await getActiveGuildIds();
    if (activeIds.length > 0) query = query.in("players.guild_id", activeIds);
  }

  const { data: allStats } = await query;

  if (!allStats?.length) return interaction.editReply("❌ No records yet.");

  const withPenalties = allStats
    .map(stat => ({
      ...stat,
      combinedPenalty: (stat.total_damage_penalty || 0) + (stat.total_time_penalty || 0)
    }))
    .filter(s => s.combinedPenalty > 0)
    .sort((a, b) => b.combinedPenalty - a.combinedPenalty)
    .slice(0, 3);

  if (!withPenalties.length) return interaction.editReply("❌ No drivers with penalties yet.");

  const fields = withPenalties.map((row, i) => {
    const tag = row.players?.guild_tag || "";
    return {
      name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
      value: `Penalty: **${Math.round(row.combinedPenalty)}**\n` +
        `Damage: ${row.total_damage_penalty || 0} | Time: ${row.total_time_penalty || 0}`,
      inline: false
    };
  });

  const guildConfig = await getGuildConfig(interaction.guild.id);
  await interaction.editReply({
    embeds: [{
      title: isGlobal ? "🚨 Global Worst Drivers" : `🚨 Worst Drivers (${interaction.guild.name})`,
      description: "Ranked by **Combined Penalties** (Damage + Time)",
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields
    }]
  });
}

async function bestdrivers(interaction) {
  await interaction.deferReply();
  const isGlobal = interaction.options.getBoolean("global") === true;

  let query = supabase
    .from("player_stats")
    .select("clean_deliveries, total_score, players!inner(username, display_name, guild_tag, guild_id)")
    .gt("clean_deliveries", 0)
    .order("clean_deliveries", { ascending: false })
    .order("total_score", { ascending: false })
    .limit(100);

  if (!isGlobal) {
    query = query.eq("players.guild_id", interaction.guild.id);
  } else {
    const activeIds = await getActiveGuildIds();
    if (activeIds.length > 0) query = query.in("players.guild_id", activeIds);
  }

  const { data: bestStats } = await query;

  if (!bestStats?.length) return interaction.editReply("❌ No records yet.");

  const sorted = bestStats
    .sort((a, b) => {
      if (b.clean_deliveries !== a.clean_deliveries) {
        return b.clean_deliveries - a.clean_deliveries;
      }
      return (b.total_score || 0) - (a.total_score || 0);
    })
    .slice(0, 3);

  const fields = sorted.map((row, i) => {
    const tag = row.players?.guild_tag || "";
    return {
      name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
      value: `Clean Deliveries: **${row.clean_deliveries || 0}**\n` +
        `Total Score: **${Math.round(row.total_score || 0)}**`,
      inline: false
    };
  });

  const guildConfig = await getGuildConfig(interaction.guild.id);
  await interaction.editReply({
    embeds: [{
      title: isGlobal ? "⭐ Global Best Drivers" : `⭐ Best Drivers (${interaction.guild.name})`,
      description: "Ranked by **Clean Deliveries** (tie-breaker: Total Score)",
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields
    }]
  });
}

module.exports = { worstdrivers, bestdrivers };
