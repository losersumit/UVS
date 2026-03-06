// stats_system/statsService.js
const { supabase } = require("./supabase");
const { validateRun } = require("../anticheat");
const { updateLeaderboard, updateGlobalWebhook } = require("./leaderboardService");

async function getOrCreatePlayer(discordId, username, displayName, guildId) {
  // Check if player already exists (GLOBAL - not per-server)
  let { data: player } = await supabase
    .from("players")
    .select("*")
    .eq("discord_id", discordId)
    .single();

  // Verify server is approved (for display/branding purposes only)
  const { data: guild } = await supabase
    .from("approved_guilds")
    .select("guild_tag")
    .eq("guild_id", guildId)
    .single();

  if (!guild) throw new Error("❌ This server is not an approved VTC.");

  // New player registration
  if (!player) {
    const { data: newPlayer, error } = await supabase
      .from("players")
      .insert({
        discord_id: discordId,
        username,
        display_name: displayName,
        guild_id: guildId, // Store for display purposes only, not for locking
        guild_tag: guild.guild_tag
      })
      .select()
      .single();

    if (error) throw error;

    // Create initial stats row
    await supabase.from("player_stats").insert({ player_id: newPlayer.id });
    return newPlayer;
  }

  // Existing player — UPDATE NAME IF CHANGED
  if (player.username !== username || player.display_name !== displayName) {
    const { data: updatedPlayer } = await supabase
      .from("players")
      .update({ username, display_name: displayName })
      .eq("id", player.id)
      .select()
      .single();
    if (updatedPlayer) player = updatedPlayer;
  }

  // Existing player — NO GUILD LOCKING
  return player;
}

async function applyRunStats(playerId, ocr, client) {
  let { data: stats, error: fetchError } = await supabase
    .from("player_stats")
    .select("*")
    .eq("player_id", playerId)
    .single();

  // Fallback if row missing (rare, but safe)
  if (fetchError || !stats) {
    const { data: newStats, error: insError } = await supabase
      .from("player_stats")
      .insert({
        player_id: playerId,
        total_distance_km: 0,
        total_time_minutes: 0,
        current_level: 0,
        last_xp: 0
      })
      .select().single();
    if (insError) throw insError;
    stats = newStats;
  }

  // ─── ANTICHEAT ───
  const check = validateRun(ocr, stats);

  if (!check.ok) {
    const { data: player } = await supabase
      .from("players")
      .select("guild_id")
      .eq("id", playerId)
      .single();

    await supabase.from("run_rejections").insert({
      player_id: playerId,
      guild_id: player?.guild_id || null,
      reason: check.reason,
      image_hash: ocr.image_hash
    });
    throw new Error(`❌ Run rejected: ${check.reason}`);
  }
  // ─────────────────

  // 1. SANITIZE INPUTS (Fixes NaN issues that cause DB inserts to fail)
  const damagePenalty = Number(ocr.damage_penalty) || 0;
  const timePenalty = Number(ocr.time_penalty) || 0;
  const distanceKm = Number(ocr.distance_km) || 0;
  const timeMinutes = Number(ocr.time_minutes) || 0;
  const income = Number(ocr.income) || 0;

  const newDistance = (stats.total_distance_km || 0) + distanceKm;
  const newTime = (stats.total_time_minutes || 0) + timeMinutes;

  const isClean = damagePenalty === 0 && timePenalty === 0;

  // Calculate Score
  const runSpeed = timeMinutes > 0 ? (distanceKm / (timeMinutes / 60)) : 0;

  let baseScore = (distanceKm * 1.0) + (runSpeed * 5.0);
  if (isClean) baseScore = baseScore * 1.2;

  const penaltySum = damagePenalty + timePenalty;
  const gross = income + penaltySum;
  const penaltyPercent = gross > 0 ? (penaltySum / gross) * 100 : 0;

  let finalScore = Math.round(baseScore - (baseScore * penaltyPercent / 100));

  // Safety: Ensure finalScore is valid number
  if (isNaN(finalScore) || !isFinite(finalScore)) {
    finalScore = 0;
  }

  let starsEarned = 0;
  if (finalScore > 1000) starsEarned = 3;
  else if (finalScore >= 700) starsEarned = 2;
  else if (finalScore >= 400) starsEarned = 1;

  // Prepare Update Object
  const update = {
    total_distance_km: newDistance,
    total_time_minutes: newTime,
    current_level: ocr.level,
    total_damage_penalty: (stats.total_damage_penalty || 0) + damagePenalty,
    total_time_penalty: (stats.total_time_penalty || 0) + timePenalty,
    total_score: (stats.total_score || 0) + finalScore,
    total_stars: (stats.total_stars || 0) + starsEarned,
    last_level: ocr.level,
    last_xp: ocr.xp || stats.last_xp || 0,
    total_income: (stats.total_income || 0) + income
  };

  // Only update speed if it's a new personal best
  if (timeMinutes > 5 && runSpeed > (stats.best_avg_speed_kmph || 0)) {
    update.best_avg_speed_kmph = Number(runSpeed.toFixed(1));
  }

  if (isClean) {
    update.clean_deliveries = (stats.clean_deliveries || 0) + 1;
  }

  const { error: updError } = await supabase
    .from("player_stats")
    .update(update)
    .eq("player_id", playerId);

  if (updError) throw updError;

  // 2. INSERT RUN AND CHECK FOR ERROR (Fixes silent failure)
  const { error: runError } = await supabase.from("runs").insert({
    player_id: playerId,
    image_hash: ocr.image_hash,
    score: finalScore,
    stars: starsEarned,
    income: income,
    distance: distanceKm,
    time_taken: timeMinutes
  });

  if (runError) {
    console.error("❌ FAILED TO SAVE RUN HASH:", runError);
    // Throw error so the user sees the rejection message in Discord
    throw new Error(`Database Error: Could not save run. ${runError.message}`);
  }

  // 3. UPDATE GUILD INCOME
  try {
    const { data: player } = await supabase
      .from("players")
      .select("guild_id")
      .eq("id", playerId)
      .single();

    if (player && player.guild_id && income > 0) {
      const { data: guild } = await supabase
        .from("approved_guilds")
        .select("net_worth, runs")
        .eq("guild_id", player.guild_id)
        .single();

      if (guild) {
        const newGuildIncome = (Number(guild.net_worth) || 0) + income;
        const newRuns = (Number(guild.runs) || 0) + 1;
        await supabase
          .from("approved_guilds")
          .update({ net_worth: newGuildIncome, runs: newRuns })
          .eq("guild_id", player.guild_id);
      }
    }
  } catch (guildUpdateErr) {
    console.error("⚠️ Failed to update guild income:", guildUpdateErr);
    // Non-fatal error for the user's run, so we just log it
  }

  // 4. TRIGGER LEADERBOARD REFRESH DIRECTLY
  try {
    const { data: allGuilds } = await supabase
      .from("approved_guilds")
      .select("guild_id");

    if (allGuilds) {
      for (const guild of allGuilds) {
        // Run asynchronously without blocking the user response
        updateLeaderboard(client, guild.guild_id).catch(err =>
          console.error(`Leaderboard passive update failed for ${guild.guild_id}:`, err)
        );
      }
    }

    // Also trigger the Global Webhook update
    updateGlobalWebhook(client).catch(err =>
      console.error("Global webhook trigger failed:", err)
    );
  } catch (err) {
    console.error("Failed to trigger leaderboard updates:", err);
  }

  return { starsEarned };
}

module.exports = { getOrCreatePlayer, applyRunStats };