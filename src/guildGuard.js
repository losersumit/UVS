/**
 * ============================================================================
 * MODULE: guildGuard.js
 * PURPOSE: A security middleware that verifies if a Discord Server (Guild) 
 *          is authorized to invite and use the Bot. Checks interactions 
 *          against the 'approved_guilds' database table.
 * ============================================================================
 */
// .uvs/src/guildGuard.js
// Controls which servers (VTCs) are allowed to use the bot

const { supabase } = require("./stats_system/supabase");

async function isGuildApproved(guildId) {
  const { data, error } = await supabase
    .from("approved_guilds")
    .select("guild_id, is_suspended")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("Guild approval check failed:", error);
    return false;
  }

  // Suspended guilds should not be able to use the bot
  if (data.is_suspended) {
    return false;
  }

  return true;
}

module.exports = { isGuildApproved };
