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
const suspenduserCmd = require("./src/commands/suspenduser");
const changeguildCmd = require("./src/commands/changeguild");
const helpCmd = require("./src/commands/help");
const radioCmd = require("./src/commands/radio");
const radiochannelCmd = require("./src/commands/radiochannel");
const codesCmd = require("./src/commands/codes");
const { handleRadioMessage } = require("./src/radioManager");
const { updateRadioDirectory } = require("./src/stats_system/radioDirectory");
const { handleMemberJoin, handleMemberLeave, syncAllMembers } = require("./src/stats_system/surveillanceService");

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
  suspenduser: suspenduserCmd.execute,
  changeguild: changeguildCmd.execute,
  help: helpCmd.execute,
  setradiofrequency: radioCmd.execute,
  setradiochannel: radiochannelCmd.execute,
  codes: codesCmd.execute,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
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

  // Initialize/Update Central Radio Directory on Restart
  updateRadioDirectory(client).catch(err =>
    console.error("Central radio directory update on restart failed:", err)
  );

  // Run surveillance member sync on Restart
  syncAllMembers(client).catch(err =>
    console.error("Surveillance member sync on restart failed:", err)
  );

  // ─── SUSPENDED GUILD SWEEP ───
  // On every restart, leave any guild that is suspended or not in approved_guilds
  (async () => {
    try {
      const { data: approvedGuilds, error } = await supabase
        .from("approved_guilds")
        .select("guild_id, is_suspended");

      if (error) {
        console.error("[SuspendedSweep] Failed to fetch approved guilds:", error);
        return;
      }

      const approvedMap = new Map(
        (approvedGuilds || []).map(g => [g.guild_id, g.is_suspended])
      );

      for (const [guildId, guild] of client.guilds.cache) {
        const isSuspended = approvedMap.get(guildId);
        const isNotApproved = !approvedMap.has(guildId);

        if (isSuspended || isNotApproved) {
          const reason = isSuspended ? "suspended" : "not approved";
          console.log(`[SuspendedSweep] Leaving ${reason} guild: ${guild.name} (${guildId})`);
          await guild.leave().catch(err =>
            console.error(`[SuspendedSweep] Failed to leave ${guildId}:`, err)
          );
        }
      }

      console.log("[SuspendedSweep] Startup guild sweep complete.");
    } catch (err) {
      console.error("[SuspendedSweep] Sweep failed:", err);
    }
  })();

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
    { name: "suspenduser", description: "Suspend a user and completely remove their contributions (Owner Only)", options: [{ name: "user", description: "User to suspend", type: 6, required: true }, { name: "reason", description: "Reason for suspension", type: 3, required: true }] },
    { name: "changeguild", description: "Change a user's guild/company (Owner Only)", options: [{ name: "user", description: "User to move", type: 6, required: true }] },
    { name: "suspendvtc", description: "Suspend a VTC from leaderboards (Owner Only)", options: [{ name: "guild_id", type: 3, description: "ID of the server", required: true }] },
    { name: "restorevtc", description: "Restore a suspended VTC to leaderboards (Owner Only)", options: [{ name: "guild_id", type: 3, description: "ID of the server", required: true }] },
    { name: "help", description: "Show bot instructions and commands" },
    {
      name: "setradiofrequency",
      description: "Set the radio frequency for cross-server transmissions",
      options: [
        {
          name: "frequency",
          description: "Frequency between 100.00 and 120.00 MHz (e.g., 119.88)",
          type: 10, // NUMBER type
          required: true
        }
      ]
    },
    {
      name: "setradiochannel",
      description: "Set the channel where incoming radio transmissions are delivered",
      options: [
        {
          name: "channel",
          description: "The text channel UVS has access to",
          type: 7, // CHANNEL type
          required: true,
          channel_types: [0, 5, 10, 11, 12] // GuildText, GuildAnnouncement, threads
        }
      ]
    },
    {
      name: "codes",
      description: "View the job log error codes (Owner Only)"
    }
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
  // ─── Slash Commands ───
  if (interaction.isChatInputCommand()) {
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
    return;
  }
});

// ─── RADIO MESSAGE MONITORING (+rd) ───
client.on("messageCreate", async (message) => {
  try {
    await handleRadioMessage(message);
  } catch (err) {
    console.error("[RadioMessage] Error:", err);
  }
});

// ─── MEMBER SURVEILLANCE LISTENERS ───
client.on("guildMemberAdd", async (member) => {
  try {
    await handleMemberJoin(member);
  } catch (err) {
    console.error("[Surveillance] Error in guildMemberAdd:", err);
  }
});

client.on("guildMemberRemove", async (member) => {
  try {
    await handleMemberLeave(member);
  } catch (err) {
    console.error("[Surveillance] Error in guildMemberRemove:", err);
  }
});

client.login(process.env.DISCORD_TOKEN);