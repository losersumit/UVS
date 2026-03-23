const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { isOwner } = require("../owner");

async function myvtc(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guild.id;

  const [
    { data: guildsData },
    { data: guildStats }
  ] = await Promise.all([
    supabase.from("approved_guilds").select("guild_id, guild_tag, guild_name, net_worth").eq("is_suspended", false),
    supabase.from("player_stats").select("total_score, total_time_minutes, total_stars, total_distance_km, clean_deliveries, players!inner(guild_id)")
  ]);

  if (!guildsData) {
    return interaction.editReply("❌ Failed to fetch VTC data.");
  }

  const currentGuild = guildsData.find(g => g.guild_id === guildId);
  if (!currentGuild) {
    return interaction.editReply("❌ This server is not an approved VTC.");
  }

  const guildAggregates = new Map();
  for (const g of guildsData) {
    guildAggregates.set(g.guild_id, {
      guild_id: g.guild_id,
      guild_tag: g.guild_tag || "Unknown Guild",
      guild_name: g.guild_name || "Unknown Server",
      net_worth: Number(g.net_worth) || 0,
      total_score: 0,
      total_time_minutes: 0,
      total_stars: 0,
      total_distance_km: 0,
      clean_deliveries: 0,
      member_count: 0
    });
  }

  if (guildStats) {
    for (const stat of guildStats) {
      const gid = stat.players?.guild_id;
      if (!gid || !guildAggregates.has(gid)) continue;
      const agg = guildAggregates.get(gid);
      agg.total_score += Number(stat.total_score || 0);
      agg.total_time_minutes += Number(stat.total_time_minutes || 0);
      agg.total_stars += Number(stat.total_stars || 0);
      agg.total_distance_km += Number(stat.total_distance_km || 0);
      agg.clean_deliveries += Number(stat.clean_deliveries || 0);
      agg.member_count += 1;
    }
  }

  const sortedGuilds = Array.from(guildAggregates.values())
    .sort((a, b) => b.net_worth - a.net_worth);

  const myRank = sortedGuilds.findIndex(g => g.guild_id === guildId) + 1;
  const totalGuilds = sortedGuilds.length;
  const me = guildAggregates.get(guildId);

  const guildConfig = await getGuildConfig(guildId);

  const hours = Math.floor(me.total_time_minutes / 60);
  const mins = me.total_time_minutes % 60;

  await interaction.editReply({
    embeds: [{
      title: `🏢 ${me.guild_tag} | ${me.guild_name}`,
      description: `**Global VTC Rank: #${myRank}** out of ${totalGuilds}`,
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields: [
        { name: "👥 Active Drivers", value: `${me.member_count}`, inline: true },
        { name: "💰 Net Worth", value: `$${Math.round(me.net_worth).toLocaleString()}`, inline: true },
        { name: "🏆 Total Score", value: `${Math.round(me.total_score).toLocaleString()}`, inline: true },
        { name: "🛤️ Total Distance", value: `${Math.round(me.total_distance_km).toLocaleString()} km`, inline: true },
        { name: "⏱️ Driving Time", value: `${hours}h ${mins}m`, inline: true },
        { name: "⭐ Total Stars", value: `${Math.round(me.total_stars).toLocaleString()}`, inline: true },
        { name: "✅ Clean Deliveries", value: `${me.clean_deliveries}`, inline: true }
      ],
      footer: { text: "Managed by NMC" }
    }]
  });
}

async function suspendvtc(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const targetId = interaction.options.getString("guild_id");
  const { error } = await supabase.from("approved_guilds").update({ is_suspended: true }).eq("guild_id", targetId);
  if (error) return interaction.editReply("❌ Failed to suspend VTC.");
  return interaction.editReply(`✅ Suspended VTC **${targetId}** from leaderboards.`);
}

async function restorevtc(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const targetId = interaction.options.getString("guild_id");
  const { error } = await supabase.from("approved_guilds").update({ is_suspended: false }).eq("guild_id", targetId);
  if (error) return interaction.editReply("❌ Failed to restore VTC.");
  return interaction.editReply(`✅ Restored VTC **${targetId}** to leaderboards.`);
}

module.exports = { myvtc, suspendvtc, restorevtc };
