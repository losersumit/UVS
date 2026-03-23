const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { getActiveGuildIds } = require("../helpers");

async function execute(interaction) {
  await interaction.deferReply();
  const targetUser = interaction.options.getUser("user") || interaction.user;

  const { data: stats, error } = await supabase
    .from("player_stats")
    .select("*, players!inner(username, display_name, guild_tag)")
    .eq("players.discord_id", targetUser.id)
    .maybeSingle();

  if (error || !stats) {
    return interaction.editReply("❌ No stats found for this user.");
  }

  const displayName = stats.players?.display_name || stats.players?.username || targetUser.username;
  const hours = Math.floor((stats.total_time_minutes || 0) / 60);
  const minutes = (stats.total_time_minutes || 0) % 60;
  const totalMoneyEarned = stats.net_worth || 0;

  // Get all player stats in one query to calculate ranks efficiently
  const { data: allStatsRaw } = await supabase
    .from("player_stats")
    .select("current_level, total_distance_km, total_time_minutes, best_avg_speed_kmph, total_score, total_stars, clean_deliveries, total_damage_penalty, total_time_penalty, players!inner(guild_id)");

  const activeIds = await getActiveGuildIds();
  const allStats = (allStatsRaw || []).filter(s => activeIds.includes(s.players?.guild_id));

  // Calculate all ranks in a single pass
  const userValues = {
    level: stats.current_level || 0,
    distance: stats.total_distance_km || 0,
    time: stats.total_time_minutes || 0,
    speed: stats.best_avg_speed_kmph || 0,
    score: stats.total_score || 0,
    stars: stats.total_stars || 0,
    clean: stats.clean_deliveries || 0,
    penalty: (stats.total_damage_penalty || 0) + (stats.total_time_penalty || 0)
  };

  const ranks = { level: 1, distance: 1, time: 1, speed: 1, score: 1, stars: 1, clean: 1, penalty: 1 };

  for (const s of allStats) {
    if ((s.current_level || 0) > userValues.level) ranks.level++;
    if ((s.total_distance_km || 0) > userValues.distance) ranks.distance++;
    if ((s.total_time_minutes || 0) > userValues.time) ranks.time++;
    if ((s.best_avg_speed_kmph || 0) > userValues.speed) ranks.speed++;
    if ((s.total_score || 0) > userValues.score) ranks.score++;
    if ((s.total_stars || 0) > userValues.stars) ranks.stars++;
    if ((s.clean_deliveries || 0) > userValues.clean) ranks.clean++;
    const penalty = (s.total_damage_penalty || 0) + (s.total_time_penalty || 0);
    if (penalty < userValues.penalty) ranks.penalty++;
  }

  const guildConfig = await getGuildConfig(interaction.guild.id);

  const embed = {
    title: `📊 Stats for ${stats.players.guild_tag} ${displayName}`,
    color: guildConfig.embed_color,
    thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
    fields: [
      { name: "Level", value: `${userValues.level} (Rank #${ranks.level})`, inline: true },
      { name: "Total Distance", value: `${Math.round(userValues.distance)} km (Rank #${ranks.distance})`, inline: true },
      { name: "Driving Time", value: `${hours}h ${minutes}m (Rank #${ranks.time})`, inline: true },
      { name: "Best Avg Speed", value: `${userValues.speed} km/h (Rank #${ranks.speed})`, inline: true },
      { name: "XP", value: `${stats.last_xp || 0} (Rank #${ranks.score})`, inline: true },
      { name: "Total Stars", value: `⭐ ${userValues.stars} (Rank #${ranks.stars})`, inline: true },
      { name: "Clean Deliveries", value: `${userValues.clean} (Rank #${ranks.clean})`, inline: true },
      { name: "Total Money Earned", value: `$${Math.round(totalMoneyEarned).toLocaleString()}`, inline: true },
      { name: "Penalties", value: `Dm: ${stats.total_damage_penalty} | Tm: ${stats.total_time_penalty} (Rank #${ranks.penalty})`, inline: true }
    ]
  };
  await interaction.editReply({ embeds: [embed] });
}

module.exports = { execute };
