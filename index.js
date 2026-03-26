/**
 * ============================================================================
 * MODULE: index.js
 * PURPOSE: The main boot file and entry point for the UVS Discord Bot. 
 *          Handles Discord client initialization, registers slash commands, 
 *          and routes interactions to command modules.
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

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { registerScreenshotListener } = require("./src/stats_system/screenshotListener");
const { supabase } = require("./src/stats_system/supabase");
const { registerLeaderboardRealtime } = require("./src/stats_system/realtimeLeaderboard");
const { updateLeaderboard, updateGlobalWebhook } = require("./src/stats_system/leaderboardService");
const { registerDailyInspector } = require("./src/stats_system/dailyInspector");
const { registerDisplayNameSync } = require("./src/stats_system/displayNameSync");
const { registerLeaderboardChannelCleaner } = require("./src/stats_system/leaderboardChannelCleaner");
const { isGuildApproved } = require("./src/guildGuard");

// ─── Command Modules ───
const statsCmd = require("./src/commands/stats");
const { speedlb, levellb, distancelb, timelb, networthlb } = require("./src/commands/leaderboards");
const { worstdrivers, bestdrivers } = require("./src/commands/drivers");
const { suspendvtc, restorevtc } = require("./src/commands/vtc");
const adminCmd = require("./src/commands/admin");
const helpCmd = require("./src/commands/help");

// ─── Command Router ───
const commandHandlers = {
  stats: statsCmd.execute,
  speedlb,
  levellb,
  distancelb,
  timelb,
  networthlb,
  worstdrivers,
  bestdrivers,
  suspendvtc,
  restorevtc,
  clearstats: adminCmd.execute,
  help: helpCmd.execute,
};

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

  client.user.setPresence({
    activities: [{ name: "/help", type: ActivityType.Playing }],
    status: "online"
  });

  // Register Realtime Listener
  registerLeaderboardRealtime(client);

  // Register Daily AI Inspector Cron Jobs
  registerDailyInspector(client);

  // Register Display Name Sync Cron Job
  registerDisplayNameSync(client);

  // Register Leaderboard Channel Cleaner (on restart + 1 AM daily)
  registerLeaderboardChannelCleaner(client);

  // Update Global Webhook on Restart
  updateGlobalWebhook(client).catch(err =>
    console.error("Global webhook update on restart failed:", err)
  );

  // Refresh all guild leaderboards on Restart
  (async () => {
    try {
      const { data: allGuilds } = await supabase
        .from("approved_guilds")
        .select("guild_id, lb_msg_guilds");

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
    { name: "networthlb", description: "View top drivers by their Net Worth", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "worstdrivers", description: "View worst drivers by penalties", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "bestdrivers", description: "View best drivers by clean deliveries", options: [{ name: "global", description: "Show all approved VTC members", type: 5, required: false }] },
    { name: "clearstats", description: "Clear a user's stats (Owner Only)", options: [{ name: "user", description: "User to clear", type: 6, required: true }] },
    { name: "suspendvtc", description: "Suspend a VTC from leaderboards (Owner Only)", options: [{ name: "guild_id", type: 3, description: "ID of the server", required: true }] },
    { name: "restorevtc", description: "Restore a suspended VTC to leaderboards (Owner Only)", options: [{ name: "guild_id", type: 3, description: "ID of the server", required: true }] },
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

  const handler = commandHandlers[interaction.commandName];
  if (handler) {
    try {
      await handler(interaction);
    } catch (err) {
      console.error(`❌ Command error [${interaction.commandName}]:`, err);
      const reply = { content: "❌ An error occurred while processing this command.", ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);