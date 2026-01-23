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
    .select("*")
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
    guild_tag: guild.guild_tag || "",
    avatar_url: guild.avatar_url || null,
    embed_color: guild.embed_color || 0xff7801,
    thumbnail: guild.avatar_url || null,
    
    // Channels
    screenshot_channel_id: guild.screenshot_channel_id || null,
    leaderboard_channel_id: guild.leaderboard_channel_id || null,
    
    // Emojis
    star_1_emoji: guild.star_1_emoji || "⭐",
    star_2_emoji: guild.star_2_emoji || "⭐",
    star_3_emoji: guild.star_3_emoji || "⭐",
    
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
    star_1_emoji: "⭐",
    star_2_emoji: "⭐",
    star_3_emoji: "⭐",
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
