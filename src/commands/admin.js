const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { isOwner } = require("../owner");

async function execute(interaction) {
  const guildConfig = await getGuildConfig(interaction.guild.id);
  if (!guildConfig.enable_clear_stats || !isOwner(interaction.user.id)) {
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user");
  const { data: player } = await supabase.from("players").select("id").eq("discord_id", target.id).single();
  if (!player) return interaction.editReply("❌ Player not found.");

  await supabase.from("player_stats").update({
    total_distance_km: 0, total_time_minutes: 0, best_avg_speed_kmph: 0,
    clean_deliveries: 0, level: 0, xp: 0, runs: 0, total_damage_penalty: 0,
    total_time_penalty: 0, total_score: 0, total_stars: 0, wallet: 0,
    net_worth: 0
  }).eq("player_id", player.id);

  return interaction.editReply(`✅ Cleared stats for **${target.username}**`);
}

module.exports = { execute };
