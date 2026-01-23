const { supabase } = require("./supabase");
const { updateLeaderboard } = require("./leaderboardService");

function registerLeaderboardRealtime(client) {

  // ✅ debounce state (ONE per bot instance)
  let lastUpdate = 0;
  const MIN_INTERVAL = 3000; // 3 seconds

  supabase
    .channel("player-stats-changes")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "player_stats"
      },
      async (payload) => {
        try {

          if (Date.now() - lastUpdate < MIN_INTERVAL) return;
          lastUpdate = Date.now();

          console.log(
            "[REALTIME] player_stats updated:",
            payload.new.player_id
          );

          // Get the guild_id from the player
          const { data: player } = await supabase
            .from("players")
            .select("guild_id")
            .eq("id", payload.new.player_id)
            .single();

          if (player && player.guild_id) {
            await updateLeaderboard(client, player.guild_id);
          } else {
            // Fallback: update all guilds (if player not found or no guild_id)
            // This is less efficient but ensures leaderboards stay updated
            const { data: allGuilds } = await supabase
              .from("approved_guilds")
              .select("guild_id");
            
            if (allGuilds) {
              for (const guild of allGuilds) {
                await updateLeaderboard(client, guild.guild_id).catch(console.error);
              }
            }
          }
        } catch (err) {
          console.error("Realtime leaderboard update failed:", err);
        }
      }
    )
    .subscribe((status) => {
      console.log("[REALTIME] Leaderboard channel status:", status);
    });
}

module.exports = { registerLeaderboardRealtime };
