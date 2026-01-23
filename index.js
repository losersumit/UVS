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
    { name: "clearstats", description: "Clear a user's stats (Owner Only)", options: [{ name: "user", description: "User to clear", type: 6, required: true }] }
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

    // Get server-specific branding
    const guildConfig = await getGuildConfig(interaction.guild.id);

    const embed = {
      title: `📊 Stats for ${stats.players.guild_tag} ${displayName}`,
      color: guildConfig.embed_color,
      thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
      fields: [
        { name: "Level", value: `${stats.current_level || 0}`, inline: true },
        { name: "Total Distance", value: `${Math.round(stats.total_distance_km || 0)} km`, inline: true },
        { name: "Driving Time", value: `${hours}h ${minutes}m`, inline: true },
        { name: "Best Avg Speed", value: `${stats.best_avg_speed_kmph || 0} km/h`, inline: true },
        { name: "Total Score", value: `${Math.round(stats.total_score || 0)}`, inline: true },
        { name: "Total Stars", value: `⭐ ${stats.total_stars || 0}`, inline: true },
        { name: "Clean Deliveries", value: `${stats.clean_deliveries || 0}`, inline: true },
        { name: "Penalties", value: `Dm: ${stats.total_damage_penalty} | Tm: ${stats.total_time_penalty}`, inline: true }
      ]
    };
    await interaction.editReply({ embeds: [embed] });
  }

  // COMMAND: LEVEL LB
  if (interaction.commandName === "levellb") {
    await interaction.deferReply();
    const { data: levelStats } = await supabase
      .from("player_stats")
      .select("current_level, players!inner(username, discord_id)")
      .gt("current_level", 0)
      .order("current_level", { ascending: false })
      .limit(10);

    if (!levelStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(levelStats.map(async (row, i) => {
      const member = await interaction.guild.members.fetch(row.players.discord_id).catch(() => null);
      return {
        name: `#${i + 1} ${member?.displayName || row.players.username}`,
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
      .select("best_avg_speed_kmph, players!inner(username, discord_id)")
      .gt("best_avg_speed_kmph", 0)
      .order("best_avg_speed_kmph", { ascending: false })
      .limit(10);

    if (!speedStats?.length) return interaction.editReply("❌ No records yet.");

    const fields = await Promise.all(speedStats.map(async (row, i) => {
      const member = await interaction.guild.members.fetch(row.players.discord_id).catch(() => null);
      return {
        name: `#${i + 1} ${member?.displayName || row.players.username}`,
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