const { supabase } = require("../stats_system/supabase");
const { isOwner } = require("../owner");
const { updateLeaderboard, updateGlobalWebhook } = require("../stats_system/leaderboardService");

async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user");
  
  // Find player
  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("id, guild_id")
    .eq("discord_id", target.id)
    .single();

  if (playerErr || !player) {
    return interaction.editReply("❌ Player not found in database.");
  }

  const playerId = player.id;
  const guildId = player.guild_id;

  // Calculate user's total income and run count
  const { data: runsData, error: runsQueryErr } = await supabase
    .from("runs")
    .select("income")
    .eq("player_id", playerId);

  if (runsQueryErr) {
    console.error("Failed to query user runs:", runsQueryErr);
    return interaction.editReply(`❌ Failed to retrieve user runs: ${runsQueryErr.message}`);
  }

  const totalIncome = runsData ? runsData.reduce((sum, run) => sum + (Number(run.income) || 0), 0) : 0;
  const totalRuns = runsData ? runsData.length : 0;

  // Update company/guild stats if applicable
  if (guildId && totalRuns > 0) {
    const { data: guild } = await supabase
      .from("approved_guilds")
      .select("net_worth, runs")
      .eq("guild_id", guildId)
      .single();

    if (guild) {
      const newNetWorth = Math.max(0, (Number(guild.net_worth) || 0) - totalIncome);
      const newRuns = Math.max(0, (Number(guild.runs) || 0) - totalRuns);

      await supabase
        .from("approved_guilds")
        .update({ net_worth: newNetWorth, runs: newRuns })
        .eq("guild_id", guildId);
    }
  }

  // Delete dependencies in correct database order
  await supabase.from("run_rejections").delete().eq("player_id", playerId);
  await supabase.from("runs").delete().eq("player_id", playerId);
  await supabase.from("player_stats").delete().eq("player_id", playerId);
  await supabase.from("players").delete().eq("id", playerId);

  // Trigger leaderboard refresh
  try {
    const { data: allGuilds } = await supabase
      .from("approved_guilds")
      .select("guild_id");

    if (allGuilds) {
      for (const guild of allGuilds) {
        updateLeaderboard(interaction.client, guild.guild_id).catch(err =>
          console.error(`Leaderboard passive update failed for ${guild.guild_id}:`, err)
        );
      }
    }

    if (guildId) {
      updateGlobalWebhook(interaction.client, guildId).catch(err =>
        console.error(`Global webhook trigger failed for ${guildId}:`, err)
      );
    }
  } catch (err) {
    console.error("Failed to trigger leaderboard updates after suspension:", err);
  }

  return interaction.editReply(`✅ Successfully suspended **${target.username}** and completely removed all their contributions.`);
}

module.exports = { execute };
