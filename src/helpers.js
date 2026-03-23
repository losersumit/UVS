const { supabase } = require("./stats_system/supabase");

let _activeIdsCache = null;
let _activeIdsCacheTime = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

async function getActiveGuildIds() {
  const now = Date.now();
  if (_activeIdsCache && (now - _activeIdsCacheTime) < CACHE_TTL_MS) {
    return _activeIdsCache;
  }

  const { data } = await supabase
    .from("approved_guilds")
    .select("guild_id")
    .eq("is_suspended", false);

  _activeIdsCache = (data || []).map(g => g.guild_id);
  _activeIdsCacheTime = now;
  return _activeIdsCache;
}

module.exports = { getActiveGuildIds };
