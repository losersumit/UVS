// stats_system/guildConfig.js
// Multi-server configuration system

const { supabase } = require("./supabase");

const guildConfigCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getGuildConfig(guildId) {
  // Check cache first
  const cached = guildConfigCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.config;
  }

  // Fetch from database
  const { data: guild, error } = await supabase
    .from("approved_guilds")
    .select("*, call_channel_id::text")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (error) {
    console.error("Guild config fetch error:", error);
    return getDefaultConfig();
  }

  if (!guild) {
    return getDefaultConfig();
  }

  const config = {
    // Branding
    guild_name: guild.guild_name || guild.guild_tag || "",
    guild_tag: guild.guild_tag || "",
    avatar_url: guild.avatar_url || null,
    embed_color: guild.embed_color || 0xff7801,
    thumbnail: guild.avatar_url || null,

    // Channels
    screenshot_channel_id: guild.screenshot_channel_id || null,
    leaderboard_channel_id: guild.leaderboard_channel_id || null,
    call_channel_id: guild.call_channel_id || null,

    // Emojis (Hardcoded since DB columns were deleted)
    star_1_emoji: "<a:stara:1530926858646847488>",
    star_2_emoji: "<a:starb:1530926845413818439>",
    star_3_emoji: "<a:starc:1530926869191462952>",

    // Features
    enable_clear_stats: guild.enable_clear_stats !== false // default true
  };

  // Cache it
  guildConfigCache.set(guildId, {
    config,
    timestamp: Date.now()
  });

  return config;
}

function getDefaultConfig() {
  return {
    guild_tag: "",
    avatar_url: null,
    embed_color: 0xff7801,
    thumbnail: null,
    screenshot_channel_id: null,
    leaderboard_channel_id: null,
    call_channel_id: null,
    star_1_emoji: "<a:stara:1530926858646847488>",
    star_2_emoji: "<a:starb:1530926845413818439>",
    star_3_emoji: "<a:starc:1530926869191462952>", 
    enable_clear_stats: true
  };
}

function clearGuildConfigCache(guildId) {
  if (guildId) {
    guildConfigCache.delete(guildId);
  } else {
    guildConfigCache.clear();
  }
}

module.exports = { getGuildConfig, clearGuildConfigCache };
