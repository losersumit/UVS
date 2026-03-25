/**
 * leaderboardChannelCleaner.js
 *
 * Deletes all messages in each guild's leaderboard channel
 * EXCEPT the one stored in lb_msg_guilds (the pinned combined leaderboard).
 *
 * - Runs on bot restart
 * - Scheduled daily at 1:00 AM
 */

const cron = require("node-cron");
const { supabase } = require("./supabase");

async function cleanLeaderboardChannels(client) {
  console.log("🧹 [LeaderboardCleaner] Starting leaderboard channel cleanup...");

  const { data: guilds, error } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_tag, leaderboard_channel_id, lb_msg_guilds");

  if (error || !guilds) {
    console.error("❌ [LeaderboardCleaner] Failed to fetch guilds:", error?.message);
    return;
  }

  for (const guild of guilds) {
    if (!guild.leaderboard_channel_id) {
      console.log(`⏭️  [LeaderboardCleaner] [${guild.guild_tag}] No leaderboard_channel_id — skipping.`);
      continue;
    }

    console.log(`🔍 [LeaderboardCleaner] [${guild.guild_tag}] Cleaning channel ${guild.leaderboard_channel_id} ...`);

    let channel;
    try {
      channel = await client.channels.fetch(guild.leaderboard_channel_id);
    } catch (err) {
      console.warn(`  ⚠️  [LeaderboardCleaner] Could not fetch channel: ${err.message}`);
      continue;
    }

    let messages;
    try {
      messages = await channel.messages.fetch({ limit: 100 });
    } catch (err) {
      console.warn(`  ⚠️  [LeaderboardCleaner] Could not fetch messages: ${err.message}`);
      continue;
    }

    const keepId = guild.lb_msg_guilds ? String(guild.lb_msg_guilds).trim() : null;
    let deleted = 0;
    let skipped = 0;

    for (const [id, msg] of messages) {
      if (keepId && id === keepId) {
        console.log(`  ✅ Keeping lb_msg_guilds message: ${id}`);
        skipped++;
        continue;
      }
      try {
        await msg.delete();
        deleted++;
        console.log(`  🗑️  Deleted message ${id}`);
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.warn(`  ⚠️  [LeaderboardCleaner] Could not delete ${id}: ${err.message}`);
      }
    }

    console.log(`  ✔️  [LeaderboardCleaner] [${guild.guild_tag}] Done — deleted ${deleted}, kept ${skipped}.`);
  }

  console.log("✅ [LeaderboardCleaner] All leaderboard channels cleaned.");
}

function registerLeaderboardChannelCleaner(client) {
  // Schedule daily at 1:00 AM
  cron.schedule("0 1 * * *", () => {
    cleanLeaderboardChannels(client);
  });

  console.log("✅ [LeaderboardCleaner] Cron scheduled for 1:00 AM daily.");

  // Fire immediately on bot restart
  cleanLeaderboardChannels(client);
}

module.exports = { registerLeaderboardChannelCleaner, cleanLeaderboardChannels };
