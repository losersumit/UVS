// stats_system/statsService.js
const { supabase } = require("./supabase");
const { validateRun } = require("../anticheat");

async function getOrCreatePlayer(discordId, username, guildId) {
  // Check if player already exists
  let { data: player } = await supabase
    .from("players")
    .select("*")
    .eq("discord_id", discordId)
    .single();

  // Get guild tag
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
        guild_id: guildId,
        guild_tag: guild.guild_tag
      })
      .select()
      .single();

    if (error) throw error;
    
    // Create initial stats row
    await supabase.from("player_stats").insert({ player_id: newPlayer.id });
    return newPlayer;
  }

  // Existing player — VTC LOCK Check
  if (player.guild_id !== guildId) {
    throw new Error("❌ You are registered in another VTC. Leave it first.");
  }

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
        current_level: 0, // Critical for anticheat
        last_xp: 0
      })
      .select().single();
    if (insError) throw insError;
    stats = newStats;
  }

  // ─── ANTICHEAT ───
  const check = validateRun(ocr, stats);

  if (!check.ok) {
    await supabase.from("run_rejections").insert({
      player_id: playerId,
      guild_id: stats.guild_id || null,
      reason: check.reason,
      image_hash: ocr.image_hash
    });
    throw new Error(`❌ Run rejected: ${check.reason}`);
  }
  // ─────────────────

  const newDistance = (stats.total_distance_km || 0) + Number(ocr.distance_km);
  const newTime = (stats.total_time_minutes || 0) + Number(ocr.time_minutes);
  const newAvgSpeed = newTime > 0 ? (newDistance / (newTime / 60)) : 0;
  
  const isClean = Number(ocr.damage_penalty) === 0 && Number(ocr.time_penalty) === 0;

  // Calculate Score
  const runDistance = Number(ocr.distance_km) || 0;
  const runSpeed = ocr.time_minutes > 0 ? (runDistance / (ocr.time_minutes / 60)) : 0;
  
  let baseScore = (runDistance * 1.0) + (runSpeed * 5.0);
  if (isClean) baseScore = baseScore * 1.2;

  const penaltySum = Number(ocr.damage_penalty) + Number(ocr.time_penalty);
  const income = Number(ocr.income) || 0;
  const gross = income + penaltySum;
  const penaltyPercent = gross > 0 ? (penaltySum / gross) * 100 : 0;

  const finalScore = Math.round(baseScore - (baseScore * penaltyPercent / 100));

  let starsEarned = 0;
  if (finalScore > 1000) starsEarned = 3;
  else if (finalScore >= 700) starsEarned = 2;
  else if (finalScore >= 400) starsEarned = 1;

  // Prepare Update Object
  const update = {
    total_distance_km: newDistance,
    total_time_minutes: newTime,
    current_level: ocr.level,
    total_damage_penalty: (stats.total_damage_penalty || 0) + Number(ocr.damage_penalty),
    total_time_penalty: (stats.total_time_penalty || 0) + Number(ocr.time_penalty),
    total_score: (stats.total_score || 0) + finalScore,
    total_stars: (stats.total_stars || 0) + starsEarned,
    last_level: ocr.level,
    last_xp: ocr.xp || stats.last_xp || 0,
    total_income: (stats.total_income || 0) + income
  };

  // Only update speed if it's a new personal best
  if (ocr.time_minutes > 5 && runSpeed > (stats.best_avg_speed_kmph || 0)) {
     // We use the RUN speed for PB, not the lifetime average
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

  // Log successful run
  await supabase.from("runs").insert({
    player_id: playerId,
    image_hash: ocr.image_hash,
    score: finalScore,
    stars: starsEarned
  });

  return { starsEarned };
}

module.exports = { getOrCreatePlayer, applyRunStats };