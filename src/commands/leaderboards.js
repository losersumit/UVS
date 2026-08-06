const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { getActiveGuildIds } = require("../helpers");
const { formatCompact, formatDistance, formatHours } = require("../formatters");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const GLOBAL_THUMBNAIL = "https://i.ibb.co/Ng8v1s3c/VTC-logo.png";
const PAGE_SIZE = 5;

// ─── Config for each leaderboard type ───
const LB_CONFIG = {
  speedlb: {
    statColumn: "best_avg_speed_kmph",
    select: "best_avg_speed_kmph, players!inner(username, display_name, guild_tag, guild_id)",
    emoji: "💨",
    title: "Speed Leaderboard",
    formatValue: v => `${v} km/h`,
    ascending: false,
    fetchAll: false
  },
  levellb: {
    statColumn: "level",
    select: "level, players!inner(username, display_name, guild_tag, guild_id)",
    emoji: "🏅",
    title: "Level Leaderboard",
    formatValue: v => `Level ${v}`,
    ascending: false,
    fetchAll: false
  },
  distancelb: {
    statColumn: "total_distance_km",
    select: "total_distance_km, players!inner(username, display_name, guild_tag, guild_id)",
    emoji: "🛤️",
    title: "Distance Leaderboard",
    formatValue: v => formatDistance(v),
    ascending: false,
    fetchAll: false
  },
  timelb: {
    statColumn: "total_time_minutes",
    select: "total_time_minutes, players!inner(username, display_name, guild_tag, guild_id)",
    emoji: "⏱️",
    title: "Driving Time Leaderboard",
    formatValue: v => formatHours(v),
    ascending: false,
    fetchAll: false
  },
  networthlb: {
    statColumn: "net_worth",
    select: "net_worth, players!inner(username, display_name, guild_tag, guild_id)",
    emoji: "💰",
    title: "Net Worth Leaderboard",
    formatValue: v => `$${formatCompact(v)}`,
    ascending: false,
    fetchAll: false
  }
};

// ─── Core: fetch ALL rows, apply guild filter, return sorted array ───
async function fetchLeaderboardData(commandName, guildId, isGlobal) {
  const cfg = LB_CONFIG[commandName];
  if (!cfg) return [];

  let query = supabase
    .from("player_stats")
    .select(cfg.select)
    .gt(cfg.statColumn, 0)
    .order(cfg.statColumn, { ascending: cfg.ascending })
    .limit(500); // generous cap for pagination

  if (!isGlobal) {
    query = query.eq("players.guild_id", guildId);
  } else {
    const activeIds = await getActiveGuildIds();
    if (activeIds.length > 0) {
      query = query.or(
        `guild_id.in.(${activeIds.join(",")}),guild_id.is.null`,
        { referencedTable: "players" }
      );
    } else {
      query = query.is("players.guild_id", null);
    }
  }

  const { data } = await query;
  return data || [];
}

// ─── Build paginated embed + buttons ───
async function buildLeaderboardResponse(commandName, guildId, isGlobal, page, guildName) {
  const cfg = LB_CONFIG[commandName];
  const data = await fetchLeaderboardData(commandName, guildId, isGlobal);

  const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
  const safePage   = Math.min(Math.max(0, page), totalPages - 1);
  const slice      = data.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const guildConfig = await getGuildConfig(guildId);
  const thumbnail   = isGlobal ? GLOBAL_THUMBNAIL : (guildConfig.thumbnail || null);

  const fields = slice.map((row, i) => {
    const globalRank = safePage * PAGE_SIZE + i + 1;
    const tag = row.players?.guild_tag || "";
    const name = `#${globalRank} ${tag} ${row.players?.display_name || row.players?.username || "Unknown"}`.trim();
    return { name, value: `${cfg.emoji} ${cfg.formatValue(row[cfg.statColumn])}`, inline: false };
  });

  if (!fields.length) fields.push({ name: "No data", value: "No records found.", inline: false });

  const embed = {
    title: isGlobal
      ? `${cfg.emoji} Global ${cfg.title}`
      : `${cfg.emoji} ${cfg.title} (${guildName})`,
    color: guildConfig.embed_color,
    thumbnail: thumbnail ? { url: thumbnail } : undefined,
    fields,
    footer: { text: `Page ${safePage + 1} / ${totalPages}` }
  };

  // ─── Pagination Buttons ───
  // Custom ID format: lb_page:<commandName>:<isGlobal>:<page>
  const prevBtn = new ButtonBuilder()
    .setCustomId(`lb_page:${commandName}:${isGlobal}:${safePage - 1}`)
    .setLabel("◀ Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage === 0);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`lb_page:${commandName}:${isGlobal}:${safePage + 1}`)
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= totalPages - 1);

  const row = new ActionRowBuilder().addComponents(prevBtn, nextBtn);

  return { embeds: [embed], components: [row] };
}

// ─── Exported for use by index.js button handler ───
async function renderLeaderboardPage(commandName, guildId, isGlobal, page, guildName) {
  return buildLeaderboardResponse(commandName, guildId, isGlobal, page, guildName);
}

// ─── Command Handlers ───
async function runLeaderboard(interaction, commandName) {
  await interaction.deferReply();

  const isHQ     = interaction.guild?.id === process.env.HQ_GUILD_ID;
  const isGlobal = isHQ || interaction.options.getBoolean("global") === true;
  const guildId  = interaction.guild.id;

  const response = await buildLeaderboardResponse(commandName, guildId, isGlobal, 0, interaction.guild.name);
  await interaction.editReply(response);
}

async function speedlb(interaction)    { await runLeaderboard(interaction, "speedlb"); }
async function levellb(interaction)    { await runLeaderboard(interaction, "levellb"); }
async function distancelb(interaction) { await runLeaderboard(interaction, "distancelb"); }
async function timelb(interaction)     { await runLeaderboard(interaction, "timelb"); }
async function networthlb(interaction) { await runLeaderboard(interaction, "networthlb"); }

module.exports = { speedlb, levellb, distancelb, timelb, networthlb, renderLeaderboardPage };
