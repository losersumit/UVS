const { supabase } = require("./supabase");
const { updateLeaderboard } = require("./leaderboardService");

function registerLeaderboardRealtime(client) {

  // ✅ debounce state (ONE per bot instance)
  let lastUpdate = 0;
  const MIN_INTERVAL = 3000; // 3 seconds

  supabase
    .channel("guild-income-changes")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "approved_guilds"
      },
      async (payload) => {
        try {

          if (Date.now() - lastUpdate < MIN_INTERVAL) return;
          lastUpdate = Date.now();

          console.log(
            "[REALTIME] Guild income updated:",
            payload.new.guild_tag
          );

          const { data: allGuilds } = await supabase
            .from("approved_guilds")
            .select("guild_id");

          if (allGuilds) {
            for (const guild of allGuilds) {
              await updateLeaderboard(client, guild.guild_id).catch(console.error);
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
