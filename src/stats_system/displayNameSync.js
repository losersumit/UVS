const cron = require("node-cron");
const { supabase } = require("./supabase");

async function syncDisplayNames(client) {
    console.log("🔄 [DisplayNameSync] Starting display name synchronization...");
    try {
        // Fetch all players to get their discord_id and guild_id
        const { data: players, error } = await supabase
            .from("players")
            .select("id, discord_id, guild_id");
            
        if (error) {
            console.error("❌ [DisplayNameSync] Error fetching players from database:", error);
            return;
        }

        if (!players || players.length === 0) {
            console.log("ℹ️ [DisplayNameSync] No players found to sync.");
            return;
        }

        let updatedCount = 0;

        for (const player of players) {
            // Only attempt to update if they have both discord_id and guild_id
            if (!player.discord_id || !player.guild_id) {
                continue;
            }
            
            try {
                // Fetch the guild where the user is supposedly registered
                const guild = await client.guilds.fetch(player.guild_id).catch(() => null);
                if (!guild) {
                    continue; 
                }
                
                // Fetch the member from that guild to get their guild-specific display name
                const member = await guild.members.fetch(player.discord_id).catch(() => null);
                if (!member) {
                    continue; 
                }
                
                const currentDisplayName = member.displayName;

                // Update the player row with the correct display name
                const { error: updateError } = await supabase
                    .from("players")
                    .update({ display_name: currentDisplayName })
                    .eq("id", player.id);

                if (updateError) {
                    console.error(`❌ [DisplayNameSync] Failed to update player ${player.discord_id}:`, updateError);
                } else {
                    updatedCount++;
                }
            } catch (err) {
                console.error(`❌ [DisplayNameSync] Error processing player ${player.discord_id}:`, err);
            }
        }

        console.log(`✅ [DisplayNameSync] Successfully synced display names for ${updatedCount}/${players.length} players.`);

    } catch (err) {
        console.error("❌ [DisplayNameSync] Fatal error during sync:", err);
    }
}

function registerDisplayNameSync(client) {
    // Run everyday at Midnight server time
    cron.schedule("0 0 * * *", () => {
        syncDisplayNames(client);
    });

    console.log("✅ Display Name Sync Cron scheduled for midnight.");

    // Fire immediately on bot restart
    syncDisplayNames(client);
}

module.exports = { registerDisplayNameSync, syncDisplayNames };
