const { supabase } = require("../stats_system/supabase");
const { isOwner } = require("../owner");
const { updateLeaderboard, updateGlobalWebhook } = require("../stats_system/leaderboardService");

/**
 * Formats a Date object to IST (GMT+5:30) locale string.
 */
function toIST(date) {
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
}

async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user");
  const reason = interaction.options.getString("reason");

  // ── 1. Find player ──
  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("id, guild_id, username")
    .eq("discord_id", target.id)
    .single();

  if (playerErr || !player) {
    return interaction.editReply("❌ Player not found in database.");
  }

  const playerId = player.id;
  const guildId = player.guild_id;

  // ── 2. Calculate total income & runs from the runs table ──
  const { data: runsData, error: runsQueryErr } = await supabase
    .from("runs")
    .select("income")
    .eq("player_id", playerId);

  if (runsQueryErr) {
    console.error("Failed to query user runs:", runsQueryErr);
    return interaction.editReply(`❌ Failed to retrieve user runs: ${runsQueryErr.message}`);
  }

  const totalIncome = runsData
    ? runsData.reduce((sum, run) => sum + (Number(run.income) || 0), 0)
    : 0;
  const totalRuns = runsData ? runsData.length : 0;

  // ── 3. Deduct user's contribution from guild net worth & run count ──
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

  // ── 4. Zero out player stats (row stays, all values reset to 0) ──
  await supabase.from("player_stats").update({
    total_distance_km:    0,
    total_time_minutes:   0,
    best_avg_speed_kmph:  0,
    clean_deliveries:     0,
    level:                0,
    xp:                   0,
    runs:                 0,
    total_damage_penalty: 0,
    total_time_penalty:   0,
    total_score:          0,
    total_stars:          0,
    wallet:               0,
    net_worth:            0
  }).eq("player_id", playerId);

  // ── 5. Insert or Update suspended_users ──
  const now = new Date();
  
  // Check if already suspended
  const { data: existingSuspension } = await supabase
    .from("suspended_users")
    .select("id")
    .eq("discord_id", target.id)
    .maybeSingle();

  let suspendErr;
  if (existingSuspension) {
    const { error } = await supabase
      .from("suspended_users")
      .update({
        player_id:    playerId,
        username:     target.username,
        reason,
        suspended_at: now.toISOString()
      })
      .eq("discord_id", target.id);
    suspendErr = error;
  } else {
    const { error } = await supabase
      .from("suspended_users")
      .insert({
        player_id:    playerId,
        discord_id:   target.id,
        username:     target.username,
        reason,
        suspended_at: now.toISOString()
      });
    suspendErr = error;
  }

  if (suspendErr) {
    console.error("Failed to record suspension:", suspendErr);
    return interaction.editReply(`❌ Failed to record suspension: ${suspendErr.message}`);
  }

  // ── 6. Refresh leaderboards ──
  try {
    const { data: allGuilds } = await supabase.from("approved_guilds").select("guild_id");
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

  return interaction.editReply(
    `✅ **${target.username}** has been suspended and their stats have been cleared.\n` +
    `📋 **Reason:** ${reason}\n` +
    `🕐 **Suspended at:** ${toIST(now)}`
  );
}

module.exports = { execute };
