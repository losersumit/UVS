// stats_system/leaderboardService.js
// [MIGRATION MODE] Syncs existing message IDs to DB only.

const { supabase } = require("./supabase");

async function syncLeaderboardIds(client, guildId) {
  try {
    console.log(`[MIGRATION] Starting sync for Guild ID: ${guildId}`);

    // 1. Get Guild Config from DB
    const { data: guildRow, error } = await supabase
      .from("approved_guilds")
      .select("*")
      .eq("guild_id", guildId)
      .single();

    if (error || !guildRow) {
      console.log(`[MIGRATION] ❌ Guild ${guildId} not found in DB.`);
      return;
    }

    if (!guildRow.leaderboard_channel_id) {
      console.log(`[MIGRATION] ⚠️ No leaderboard channel set for ${guildRow.guild_tag}`);
      return;
    }

    // 2. Fetch Channel
    const channel = await client.channels.fetch(guildRow.leaderboard_channel_id).catch(() => null);
    if (!channel) {
      console.error(`[MIGRATION] ❌ Channel ${guildRow.leaderboard_channel_id} not found.`);
      return;
    }

    // 3. Fetch Last 4 Messages ONLY
    const messages = await channel.messages.fetch({ limit: 4 });
    console.log(`[MIGRATION] Scanned ${messages.size} messages in ${channel.name}`);

    // 4. Identify IDs
    const updates = {};
    let foundCount = 0;

    messages.forEach((msg) => {
      // Must be from this bot and have an embed
      if (msg.author.id !== client.user.id || msg.embeds.length === 0) return;

      const title = msg.embeds[0].title;

      if (title === "🏆 Distance Leaderboard") {
        updates.lb_msg_distance = msg.id;
        foundCount++;
      } else if (title === "⏱️ Driving Time Leaderboard") {
        updates.lb_msg_time = msg.id;
        foundCount++;
      } else if (title === "⭐ Career Score Leaderboard") {
        updates.lb_msg_score = msg.id;
        foundCount++;
      } else if (title === "🏆 Top Guilds Leaderboard") {
        updates.lb_msg_guilds = msg.id;
        foundCount++;
      }
    });

    // 5. Update Database
    if (foundCount > 0) {
      const { error: updateError } = await supabase
        .from("approved_guilds")
        .update(updates)
        .eq("guild_id", guildId);

      if (updateError) {
        console.error(`[MIGRATION] ❌ DB Update Failed:`, updateError);
      } else {
        console.log(`[MIGRATION] ✅ Success! Synced ${foundCount} IDs for ${guildRow.guild_tag}`);
      }
    } else {
      console.log(`[MIGRATION] ⚠️ No leaderboard messages found in the last 4 messages.`);
    }

  } catch (err) {
    console.error(`[MIGRATION] ❌ Critical Error for ${guildId}:`, err);
  }
}

// Export as updateLeaderboard so realtime listener doesn't crash, 
// even though we are using it for sync.
module.exports = { updateLeaderboard: syncLeaderboardIds };