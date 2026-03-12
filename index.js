/**
 * ============================================================================
 * MODULE: index.js
 * PURPOSE: The main boot file and entry point for the UVS Discord Bot. 
 *          Handles Discord client initialization, registers slash commands, 
 *          manages interaction events (buttons/commands), and mounts the 
 *          various subsystems (realtime, screenshots, inspector).
 * ============================================================================
 */
require('dotenv').config();

// ─── ENV SAFETY CHECK ───
function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`❌ Missing required env var: ${name}`);
  }
}

[
  "DISCORD_TOKEN"
].forEach(requireEnv);
// ───────────────────────

const { Client, GatewayIntentBits } = require('discord.js');
const { registerScreenshotListener } = require("./src/stats_system/screenshotListener");
const { supabase } = require("./src/stats_system/supabase");
const { registerLeaderboardRealtime } = require("./src/stats_system/realtimeLeaderboard");
const { updateLeaderboard, updateGlobalWebhook } = require("./src/stats_system/leaderboardService");
const { registerDailyInspector, runDailyInspection } = require("./src/stats_system/dailyInspector");
const { isOwner } = require("./src/owner");
const { isGuildApproved } = require("./src/guildGuard");
const { getGuildConfig } = require("./src/stats_system/guildConfig");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Register Modules
registerScreenshotListener(client);

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register Realtime Listener
  registerLeaderboardRealtime(client);

  // Register Daily AI Inspector Cron Jobs
  registerDailyInspector(client);

  // Update Global Webhook on Restart
  updateGlobalWebhook(client).catch(err =>
    console.error("Global webhook update on restart failed:", err)
  );

  // Refresh all guild leaderboards on Restart — edit existing messages only
  (async () => {
    try {
      const { data: allGuilds } = await supabase
        .from("approved_guilds")
        .select("guild_id, lb_msg_guilds")
        .not("lb_msg_guilds", "is", null); // only guilds with an existing leaderboard message

      if (allGuilds && allGuilds.length > 0) {
        console.log(`[Leaderboard] Editing leaderboards for ${allGuilds.length} guild(s) on restart...`);
        for (const guild of allGuilds) {
          await updateLeaderboard(client, guild.guild_id).catch(err =>
            console.error(`[Leaderboard] Restart refresh failed for ${guild.guild_id}:`, err)
          );
        }
        console.log("[Leaderboard] All guild leaderboards refreshed.");
      } else {
        console.log("[Leaderboard] No existing leaderboard messages to refresh on restart.");
      }
    } catch (err) {
      console.error("[Leaderboard] Failed to refresh leaderboards on restart:", err);
    }
  })();

  // Register Commands
  const commands = [
    { name: "stats", description: "Check trucking stats", options: [{ name: "user", description: "View stats of another player", type: 6, required: false }] },
    { name: "speedlb", description: "View top average speeds", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "levellb", description: "View highest level truckers", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "distancelb", description: "View top drivers by total distance", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "timelb", description: "View top drivers by total time", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "worstdrivers", description: "View worst drivers by penalties", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "bestdrivers", description: "View best drivers by clean deliveries", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "vtclb", description: "View complete stats and global rank for your current VTC" },
    { name: "clearstats", description: "Clear a user's stats (Owner Only)", options: [{ name: "user", description: "User to clear", type: 6, required: true }] },
    { name: "help", description: "Show bot instructions and commands" }
  ];

  await client.application.commands.set(commands);
  console.log("✅ Application commands registered.");
});

client.on("guildCreate", async (guild) => {
  if (!await isGuildApproved(guild.id)) {
    console.log(`❌ Unauthorized guild: ${guild.name}`);
    await guild.leave();
  } else {
    console.log(`✅ Joined approved guild: ${guild.name}`);
  }
});

// ─── INTERACTION HANDLER ───
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.guild && !await isGuildApproved(interaction.guild.id)) {
    return interaction.reply({ content: "❌ Unauthorized server.", ephemeral: true });
  }

  // COMMAND: STATS
  if (interaction.commandName === "stats") {
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

    // Get all player stats in one query to calculate ranks efficiently
    const { data: allStats } = await supabase
      .from("player_stats")
      .select("current_level, total_distance_km, total_time_minutes, best_avg_speed_kmph, total_score, total_stars, clean_deliveries, total_damage_penalty, total_time_penalty");

    // Calculate ranks
    const userLevel = stats.current_level || 0;
    const userDistance = stats.total_distance_km || 0;
    const userTime = stats.total_time_minutes || 0;
    const userSpeed = stats.best_avg_speed_kmph || 0;
    const userScore = stats.total_score || 0;
    const userStars = stats.total_stars || 0;
    const userClean = stats.clean_deliveries || 0;
    const userPenalty = (stats.total_damage_penalty || 0) + (stats.total_time_penalty || 0);

    const levelRank = (allStats || []).filter(s => (s.current_level || 0) > userLevel).length + 1;
    const distanceRank = (allStats || []).filter(s => (s.total_distance_km || 0) > userDistance).length + 1;
    const timeRank = (allStats || []).filter(s => (s.total_time_minutes || 0) > userTime).length + 1;
    const speedRank = (allStats || []).filter(s => (s.best_avg_speed_kmph || 0) > userSpeed).length + 1;
    const scoreRank = (allStats || []).filter(s => (s.total_score || 0) > userScore).length + 1;
    const starsRank = (allStats || []).filter(s => (s.total_stars || 0) > userStars).length + 1;
    const cleanRank = (allStats || []).filter(s => (s.clean_deliveries || 0) > userClean).length + 1;
    const penaltyRank = (allStats || []).filter(s => {
      const penalty = (s.total_damage_penalty || 0) + (s.total_time_penalty || 0);
      return penalty < userPenalty;
    }).length + 1;

    // Get server-specific branding
    const guildConfig = await getGuildConfig(interaction.guild.id);

    const embed = {
      title: `📊 Stats for ${stats.players.guild_tag} ${displayName}`,
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields: [
        { name: "Level", value: `${stats.current_level || 0} (Rank #${levelRank})`, inline: true },
        { name: "Total Distance", value: `${Math.round(stats.total_distance_km || 0)} km (Rank #${distanceRank})`, inline: true },
        { name: "Driving Time", value: `${hours}h ${minutes}m (Rank #${timeRank})`, inline: true },
        { name: "Best Avg Speed", value: `${stats.best_avg_speed_kmph || 0} km/h (Rank #${speedRank})`, inline: true },
        { name: "Total Score", value: `${Math.round(stats.total_score || 0)} (Rank #${scoreRank})`, inline: true },
        { name: "Total Stars", value: `⭐ ${stats.total_stars || 0} (Rank #${starsRank})`, inline: true },
        { name: "Clean Deliveries", value: `${stats.clean_deliveries || 0} (Rank #${cleanRank})`, inline: true },
        { name: "Penalties", value: `Dm: ${stats.total_damage_penalty} | Tm: ${stats.total_time_penalty} (Rank #${penaltyRank})`, inline: true }
      ]
    };
    await interaction.editReply({ embeds: [embed] });
  }

  // COMMAND: LEVEL LB
  if (interaction.commandName === "levellb") {
    await interaction.deferReply();
    const isGlobal = interaction.options.getBoolean("global") === true;

    let query = supabase
      .from("player_stats")
      .select("current_level, players!inner(username, display_name, guild_tag, guild_id)")
      .gt("current_level", 0)
      .order("current_level", { ascending: false })
      .limit(5);

    if (!isGlobal) {
      query = query.eq("players.guild_id", interaction.guild.id);
    }

    const { data: levelStats } = await query;

    if (!levelStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(levelStats.map(async (row, i) => {
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
        value: `🏅 Level ${row.current_level}`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({
      embeds: [{
        title: isGlobal ? "📈 Global Level Leaderboard" : `📈 Level Leaderboard (${interaction.guild.name})`,
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields
      }]
    });
  }

  // COMMAND: SPEED LB
  if (interaction.commandName === "speedlb") {
    await interaction.deferReply();
    const isGlobal = interaction.options.getBoolean("global") === true;

    let query = supabase
      .from("player_stats")
      .select("best_avg_speed_kmph, players!inner(username, display_name, guild_tag, guild_id)")
      .gt("best_avg_speed_kmph", 0)
      .order("best_avg_speed_kmph", { ascending: false })
      .limit(5);

    if (!isGlobal) {
      query = query.eq("players.guild_id", interaction.guild.id);
    }

    const { data: speedStats } = await query;

    if (!speedStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(speedStats.map(async (row, i) => {
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
        value: `💨 ${row.best_avg_speed_kmph} km/h`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({
      embeds: [{
        title: isGlobal ? "🏁 Global Speed Leaderboard" : `🏁 Speed Leaderboard (${interaction.guild.name})`,
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields
      }]
    });
  }

  // COMMAND: DISTANCE LB
  if (interaction.commandName === "distancelb") {
    await interaction.deferReply();
    const isGlobal = interaction.options.getBoolean("global") === true;

    let query = supabase
      .from("player_stats")
      .select("total_distance_km, players!inner(username, display_name, guild_tag, guild_id)")
      .gt("total_distance_km", 0)
      .order("total_distance_km", { ascending: false })
      .limit(5);

    if (!isGlobal) {
      query = query.eq("players.guild_id", interaction.guild.id);
    }

    const { data: distanceStats } = await query;

    if (!distanceStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(distanceStats.map(async (row, i) => {
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
        value: `🛤️ ${Math.round(row.total_distance_km).toLocaleString()} km`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({
      embeds: [{
        title: isGlobal ? "🛤️ Global Distance Leaderboard" : `🛤️ Distance Leaderboard (${interaction.guild.name})`,
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields
      }]
    });
  }

  // COMMAND: TIME LB
  if (interaction.commandName === "timelb") {
    await interaction.deferReply();
    const isGlobal = interaction.options.getBoolean("global") === true;

    let query = supabase
      .from("player_stats")
      .select("total_time_minutes, players!inner(username, display_name, guild_tag, guild_id)")
      .gt("total_time_minutes", 0)
      .order("total_time_minutes", { ascending: false })
      .limit(5);

    if (!isGlobal) {
      query = query.eq("players.guild_id", interaction.guild.id);
    }

    const { data: timeStats } = await query;

    if (!timeStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(timeStats.map(async (row, i) => {
      const tag = row.players?.guild_tag || "";
      const hours = Math.floor(row.total_time_minutes / 60);
      const minutes = row.total_time_minutes % 60;
      return {
        name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
        value: `⏱️ ${hours}h ${minutes}m`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({
      embeds: [{
        title: isGlobal ? "⏱️ Global Driving Time Leaderboard" : `⏱️ Driving Time Leaderboard (${interaction.guild.name})`,
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields
      }]
    });
  }

  // COMMAND: VTCLB
  if (interaction.commandName === "vtclb") {
    await interaction.deferReply();
    const guildId = interaction.guild.id;

    // 1. Get all guilds to calculate rank
    const { data: guildsData } = await supabase
      .from("approved_guilds")
      .select("guild_id, guild_tag, guild_name, net_worth");

    if (!guildsData) {
      return interaction.editReply("❌ Failed to fetch VTC data.");
    }

    const currentGuild = guildsData.find(g => g.guild_id === guildId);
    if (!currentGuild) {
      return interaction.editReply("❌ This server is not an approved VTC.");
    }

    // 2. Count active drivers per guild (from players table — lighter query)
    const { data: playerRows } = await supabase
      .from("players")
      .select("guild_id");

    const memberCounts = new Map();
    if (playerRows) {
      for (const p of playerRows) {
        if (!p.guild_id) continue;
        memberCounts.set(p.guild_id, (memberCounts.get(p.guild_id) || 0) + 1);
      }
    }

    // 3. Sort all guilds by net worth
    const sorted = guildsData
      .map(g => ({
        guild_id: g.guild_id,
        guild_tag: g.guild_tag || "Unknown",
        guild_name: g.guild_name || interaction.client.guilds.cache.get(g.guild_id)?.name || "Unknown Server",
        total_income: Number(g.net_worth) || 0,
        member_count: memberCounts.get(g.guild_id) || 0
      }))
      .sort((a, b) => b.total_income - a.total_income);

    const myRank = sorted.findIndex(g => g.guild_id === guildId) + 1;
    const top5 = sorted.slice(0, 5);
    const isInTop5 = myRank <= 5;

    const guildConfig = await getGuildConfig(guildId);

    // 4. Build top 5 fields
    const fields = top5.map((g, i) => ({
      name: `#${i + 1} ${g.guild_tag} | ${g.guild_name}`,
      value: `💰 **$${Math.round(g.total_income).toLocaleString()}** net worth  •  👥 ${g.member_count} drivers`,
      inline: false
    }));

    // 5. Only show "Your Rank" if outside top 5
    if (!isInTop5) {
      const mine = sorted[myRank - 1];
      fields.push(
        { name: "─────────────────────", value: `**Your Rank: #${myRank}** out of ${sorted.length}`, inline: false },
        { name: `${mine.guild_tag} | ${mine.guild_name}`, value: `💰 **$${Math.round(mine.total_income).toLocaleString()}** net worth  •  👥 ${mine.member_count} drivers`, inline: false }
      );
    }

    await interaction.editReply({
      embeds: [{
        title: "🏆 VTC Global Leaderboard",
        description: `Top **${top5.length}** VTCs ranked by **Net Worth** • ${sorted.length} approved VTCs total`,
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields,
        footer: { text: "Managed by NMC" }
      }]
    });
  }

  // COMMAND: HELP
  if (interaction.commandName === "help") {
    await interaction.deferReply();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    // 1. Fetch channel mentions for dynamic description
    const screenshotChannel = guildConfig.screenshot_channel_id
      ? `<#${guildConfig.screenshot_channel_id}>`
      : "the designated channel";

    const leaderboardChannel = guildConfig.leaderboard_channel_id
      ? `<#${guildConfig.leaderboard_channel_id}>`
      : "the server leaderboards";

    // 2. Fetch Approved Guilds List from Database
    // Select guild_id, tag, and name as requested
    const { data: guildsData } = await supabase
      .from("approved_guilds")
      .select("guild_id, guild_tag, guild_name")
      .order("guild_tag", { ascending: true });

    // 3. Format the list: "[TAG] Name"
    // We try to use the DB name. If empty, we try to fetch the name from Discord cache.
    const guildList = (guildsData || []).map(g => {
      const name = g.guild_name || interaction.client.guilds.cache.get(g.guild_id)?.name || "Unknown Server";
      return `**${g.guild_tag}** ${name}`;
    }).join("\n");

    const helpEmbed = {
      title: "🚛 UVS Bot Help & Commands",
      description: `I am a career tracking bot for **Truckers of Europe 3**! \n\n**How it works:**\n1. Upload your **'Job Finished'** screenshot to ${screenshotChannel}.\n2. I will automatically scan the image (OCR), verify the data, and update your career stats.\n3. Compete with others on ${leaderboardChannel}!`,
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields: [
        { name: "📊 /stats [user]", value: "View your personal career stats or check another driver's profile.", inline: false },
        { name: "🏁 /speedlb [global]", value: "View Top Average Speeds. Default is current server only. Set `global: True` for all servers.", inline: true },
        { name: "📈 /levellb [global]", value: "See highest Career Levels. Default is current server only. Set `global: True` to include all servers.", inline: true },
        { name: "🛤️ /distancelb [global]", value: "Rank by Total Distance. Default is current server only. Set `global: True` to include all servers.", inline: true },
        { name: "⏱️ /timelb [global]", value: "Rank by Total Time Driven. Default is current server only. Set `global: True` to include all servers.", inline: true },
        { name: "⭐ /bestdrivers [global]", value: "Rank by Clean Deliveries. Default is current server only. Set `global: True` to include all servers.", inline: true },
        { name: "🚨 /worstdrivers [global]", value: "Rank by total penalties. Default is current server only. Set `global: True` to include all servers.", inline: true },
        { name: "🏢 /vtclb", value: "View complete stats and global rank for your VTC.", inline: true },
        { name: "🛠️ /clearstats", value: "**(Owner Only)** Reset a user's stats completely.", inline: true },
        // 👇 The new field listing all approved guilds inside the embed 👇
        { name: "✅ Approved VTCs", value: guildList || "No VTCs found.", inline: false },
        { name: "ℹ️ /help", value: "Show this information menu.", inline: true }
      ],
      footer: {
        text: "Operated by NMC"
      }
    };

    await interaction.editReply({ embeds: [helpEmbed] });
  }

  // COMMAND: WORST DRIVERS
  if (interaction.commandName === "worstdrivers") {
    await interaction.deferReply();
    const isGlobal = interaction.options.getBoolean("global") === true;

    // Get all players with penalties
    let query = supabase
      .from("player_stats")
      .select("total_damage_penalty, total_time_penalty, players!inner(username, display_name, guild_tag, guild_id)");

    if (!isGlobal) {
      query = query.eq("players.guild_id", interaction.guild.id);
    }

    const { data: allStats } = await query;

    if (!allStats?.length) return interaction.editReply("❌ No records yet.");

    // Calculate combined penalties and sort
    const withPenalties = allStats
      .map(stat => ({
        ...stat,
        combinedPenalty: (stat.total_damage_penalty || 0) + (stat.total_time_penalty || 0)
      }))
      .filter(s => s.combinedPenalty > 0)
      .sort((a, b) => b.combinedPenalty - a.combinedPenalty)
      .slice(0, 3);

    if (!withPenalties.length) return interaction.editReply("❌ No drivers with penalties yet.");

    const fields = await Promise.all(withPenalties.map(async (row, i) => {
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
        value: `Penalty: **${Math.round(row.combinedPenalty)}**\n` +
          `Damage: ${row.total_damage_penalty || 0} | Time: ${row.total_time_penalty || 0}`,
        inline: false
      };
    }));

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

  // COMMAND: BEST DRIVERS
  if (interaction.commandName === "bestdrivers") {
    await interaction.deferReply();
    const isGlobal = interaction.options.getBoolean("global") === true;

    // Get all players, sort by clean_deliveries DESC, then total_score DESC
    let query = supabase
      .from("player_stats")
      .select("clean_deliveries, total_score, players!inner(username, display_name, guild_tag, guild_id)")
      .gt("clean_deliveries", 0)
      .order("clean_deliveries", { ascending: false })
      .order("total_score", { ascending: false })
      .limit(100); // Get more to sort properly

    if (!isGlobal) {
      query = query.eq("players.guild_id", interaction.guild.id);
    }

    const { data: bestStats } = await query;

    if (!bestStats?.length) return interaction.editReply("❌ No records yet.");

    // Sort by clean_deliveries DESC, then total_score DESC, take TOP 3
    const sorted = bestStats
      .sort((a, b) => {
        if (b.clean_deliveries !== a.clean_deliveries) {
          return b.clean_deliveries - a.clean_deliveries;
        }
        return (b.total_score || 0) - (a.total_score || 0);
      })
      .slice(0, 3);

    const fields = await Promise.all(sorted.map(async (row, i) => {
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${row.players.display_name || row.players.username}`.trim(),
        value: `Clean Deliveries: **${row.clean_deliveries || 0}**\n` +
          `Total Score: **${Math.round(row.total_score || 0)}**`,
        inline: false
      };
    }));

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

  // COMMAND: CLEAR STATS
  if (interaction.commandName === "clearstats") {
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
      clean_deliveries: 0, current_level: 0, total_damage_penalty: 0,
      total_time_penalty: 0, total_score: 0, total_stars: 0, total_income: 0
    }).eq("player_id", player.id);

    return interaction.editReply(`✅ Cleared stats for **${target.username}**`);
  }
});

client.login(process.env.DISCORD_TOKEN);