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
const { registerScreenshotListener } = require("./stats_system/screenshotListener");
const { supabase } = require("./stats_system/supabase");
const { registerLeaderboardRealtime } = require("./stats_system/realtimeLeaderboard");
const { isOwner } = require("./owner");
const { isGuildApproved } = require("./guildGuard");
const { getGuildConfig } = require("./stats_system/guildConfig");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Register Modules
registerScreenshotListener(client);

client.once("ready", async () => { 
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register Realtime Listener
  registerLeaderboardRealtime(client);

  // Register Commands
  const commands = [
    { name: "stats", description: "Check trucking stats", options: [{ name: "user", description: "View stats of another player", type: 6, required: false }] },
    { name: "speedlb", description: "View top average speeds" },
    { name: "levellb", description: "View highest level truckers" },
    { name: "worstdrivers", description: "View worst drivers by penalties" },
    { name: "bestdrivers", description: "View best drivers by clean deliveries" },
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
      .select("*, players!inner(username, discord_id, guild_tag)")
      .eq("players.discord_id", targetUser.id)
      .maybeSingle(); 

    if (error || !stats) {
      return interaction.editReply("❌ No stats found for this user.");
    }

    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const displayName = member?.displayName || targetUser.username;
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
    const { data: levelStats } = await supabase
      .from("player_stats")
      .select("current_level, players!inner(username, discord_id, guild_tag)")
      .gt("current_level", 0)
      .order("current_level", { ascending: false })
      .limit(5);

    if (!levelStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(levelStats.map(async (row, i) => {
      const member = await interaction.guild.members.fetch(row.players.discord_id).catch(() => null);
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${member?.displayName || row.players.username}`.trim(),
        value: `🏅 Level ${row.current_level}`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({ 
      embeds: [{ 
        title: "📈 Level Leaderboard", 
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields 
      }] 
    });
  }

  // COMMAND: SPEED LB
  if (interaction.commandName === "speedlb") {
    await interaction.deferReply();
    const { data: speedStats } = await supabase
      .from("player_stats")
      .select("best_avg_speed_kmph, players!inner(username, discord_id, guild_tag)")
      .gt("best_avg_speed_kmph", 0)
      .order("best_avg_speed_kmph", { ascending: false })
      .limit(5);

    if (!speedStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(speedStats.map(async (row, i) => {
      const member = await interaction.guild.members.fetch(row.players.discord_id).catch(() => null);
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${member?.displayName || row.players.username}`.trim(),
        value: `💨 ${row.best_avg_speed_kmph} km/h`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({ 
      embeds: [{ 
        title: "🏁 Speed Leaderboard", 
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields 
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
        { name: "🏁 /speedlb", value: "View the leaderboard for Top Average Speeds.", inline: true },
        { name: "📈 /levellb", value: "See who has the highest Career Level.", inline: true },
        { name: "⭐ /bestdrivers", value: "Ranking based on Clean Deliveries (no damage/fines).", inline: true },
        { name: "🚨 /worstdrivers", value: "Ranking by total penalties accumulated.", inline: true },
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
    
    // Get all players with penalties
    const { data: allStats } = await supabase
      .from("player_stats")
      .select("total_damage_penalty, total_time_penalty, players!inner(username, discord_id, guild_tag)");

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
      const member = await interaction.guild.members.fetch(row.players.discord_id).catch(() => null);
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${member?.displayName || row.players.username}`.trim(),
        value: `Penalty: **${Math.round(row.combinedPenalty)}**\n` +
               `Damage: ${row.total_damage_penalty || 0} | Time: ${row.total_time_penalty || 0}`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({
      embeds: [{
        title: "🚨 Worst Drivers Leaderboard",
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
    
    // Get all players, sort by clean_deliveries DESC, then total_score DESC
    const { data: bestStats } = await supabase
      .from("player_stats")
      .select("clean_deliveries, total_score, players!inner(username, discord_id, guild_tag)")
      .gt("clean_deliveries", 0)
      .order("clean_deliveries", { ascending: false })
      .order("total_score", { ascending: false })
      .limit(100); // Get more to sort properly

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
      const member = await interaction.guild.members.fetch(row.players.discord_id).catch(() => null);
      const tag = row.players?.guild_tag || "";
      return {
        name: `#${i + 1} ${tag} ${member?.displayName || row.players.username}`.trim(),
        value: `Clean Deliveries: **${row.clean_deliveries || 0}**\n` +
               `Total Score: **${Math.round(row.total_score || 0)}**`,
        inline: false
      };
    }));

    const guildConfig = await getGuildConfig(interaction.guild.id);
    await interaction.editReply({
      embeds: [{
        title: "⭐ Best Drivers Leaderboard",
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