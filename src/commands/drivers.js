const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { getActiveGuildIds } = require("../helpers");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const GLOBAL_THUMBNAIL = "https://i.ibb.co/Ng8v1s3c/VTC-logo.png";
const PAGE_SIZE = 5;

// ─── Shared: apply guild/global filter to a Supabase query ───
async function applyFilter(query, guildId, isGlobal) {
  if (!isGlobal) {
    return query.eq("players.guild_id", guildId);
  }
  const activeIds = await getActiveGuildIds();
  if (activeIds.length > 0) {
    return query.or(
      `guild_id.in.(${activeIds.join(",")}),guild_id.is.null`,
      { referencedTable: "players" }
    );
  }
  return query.is("players.guild_id", null);
}

// ─── Build worst drivers paginated response ───
async function buildWorstDriversResponse(guildId, isGlobal, page, guildName) {
  let query = supabase
    .from("player_stats")
    .select("total_damage_penalty, total_time_penalty, players!inner(username, display_name, guild_tag, guild_id)");

  query = await applyFilter(query, guildId, isGlobal);
  const { data: allStats } = await query;

  const sorted = (allStats || [])
    .map(s => ({ ...s, combinedPenalty: (s.total_damage_penalty || 0) + (s.total_time_penalty || 0) }))
    .filter(s => s.combinedPenalty > 0)
    .sort((a, b) => b.combinedPenalty - a.combinedPenalty);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage   = Math.min(Math.max(0, page), totalPages - 1);
  const slice      = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const guildConfig = await getGuildConfig(guildId);
  const thumbnail   = isGlobal ? GLOBAL_THUMBNAIL : (guildConfig.thumbnail || null);

  const fields = slice.length
    ? slice.map((row, i) => {
        const globalRank = safePage * PAGE_SIZE + i + 1;
        const tag = row.players?.guild_tag || "";
        return {
          name: `#${globalRank} ${tag} ${row.players?.display_name || row.players?.username || "Unknown"}`.trim(),
          value: `Penalty: **${Math.round(row.combinedPenalty)}**\nDamage: ${row.total_damage_penalty || 0} | Time: ${row.total_time_penalty || 0}`,
          inline: false
        };
      })
    : [{ name: "No data", value: "No drivers with penalties yet.", inline: false }];

  const embed = {
    title: isGlobal ? "🚨 Global Worst Drivers" : `🚨 Worst Drivers (${guildName})`,
    description: "Ranked by **Combined Penalties** (Damage + Time)",
    color: guildConfig.embed_color,
    thumbnail: thumbnail ? { url: thumbnail } : undefined,
    fields,
    footer: { text: `Page ${safePage + 1} / ${totalPages}` }
  };

  const prevBtn = new ButtonBuilder()
    .setCustomId(`lb_page:worstdrivers:${isGlobal}:${safePage - 1}`)
    .setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0);
  const nextBtn = new ButtonBuilder()
    .setCustomId(`lb_page:worstdrivers:${isGlobal}:${safePage + 1}`)
    .setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages - 1);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(prevBtn, nextBtn)] };
}

// ─── Build best drivers paginated response ───
async function buildBestDriversResponse(guildId, isGlobal, page, guildName) {
  let query = supabase
    .from("player_stats")
    .select("clean_deliveries, total_score, players!inner(username, display_name, guild_tag, guild_id)")
    .gt("clean_deliveries", 0);

  query = await applyFilter(query, guildId, isGlobal);
  const { data: allStats } = await query;

  const sorted = (allStats || [])
    .sort((a, b) => {
      if (b.clean_deliveries !== a.clean_deliveries) return b.clean_deliveries - a.clean_deliveries;
      return (b.total_score || 0) - (a.total_score || 0);
    });

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage   = Math.min(Math.max(0, page), totalPages - 1);
  const slice      = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const guildConfig = await getGuildConfig(guildId);
  const thumbnail   = isGlobal ? GLOBAL_THUMBNAIL : (guildConfig.thumbnail || null);

  const fields = slice.length
    ? slice.map((row, i) => {
        const globalRank = safePage * PAGE_SIZE + i + 1;
        const tag = row.players?.guild_tag || "";
        return {
          name: `#${globalRank} ${tag} ${row.players?.display_name || row.players?.username || "Unknown"}`.trim(),
          value: `Clean Deliveries: **${row.clean_deliveries || 0}**\nTotal Score: **${Math.round(row.total_score || 0)}**`,
          inline: false
        };
      })
    : [{ name: "No data", value: "No records found.", inline: false }];

  const embed = {
    title: isGlobal ? "⭐ Global Best Drivers" : `⭐ Best Drivers (${guildName})`,
    description: "Ranked by **Clean Deliveries** (tie-breaker: Total Score)",
    color: guildConfig.embed_color,
    thumbnail: thumbnail ? { url: thumbnail } : undefined,
    fields,
    footer: { text: `Page ${safePage + 1} / ${totalPages}` }
  };

  const prevBtn = new ButtonBuilder()
    .setCustomId(`lb_page:bestdrivers:${isGlobal}:${safePage - 1}`)
    .setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0);
  const nextBtn = new ButtonBuilder()
    .setCustomId(`lb_page:bestdrivers:${isGlobal}:${safePage + 1}`)
    .setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages - 1);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(prevBtn, nextBtn)] };
}

// ─── Exported builders for button handler in index.js ───
async function renderDriversPage(commandName, guildId, isGlobal, page, guildName) {
  if (commandName === "worstdrivers") return buildWorstDriversResponse(guildId, isGlobal, page, guildName);
  if (commandName === "bestdrivers")  return buildBestDriversResponse(guildId, isGlobal, page, guildName);
  return null;
}

// ─── Command Handlers ───
async function worstdrivers(interaction) {
  await interaction.deferReply();
  const isHQ     = interaction.guild?.id === process.env.HQ_GUILD_ID;
  const isGlobal = isHQ || interaction.options.getBoolean("global") === true;
  const response = await buildWorstDriversResponse(interaction.guild.id, isGlobal, 0, interaction.guild.name);
  await interaction.editReply(response);
}

async function bestdrivers(interaction) {
  await interaction.deferReply();
  const isHQ     = interaction.guild?.id === process.env.HQ_GUILD_ID;
  const isGlobal = isHQ || interaction.options.getBoolean("global") === true;
  const response = await buildBestDriversResponse(interaction.guild.id, isGlobal, 0, interaction.guild.name);
  await interaction.editReply(response);
}

module.exports = { worstdrivers, bestdrivers, renderDriversPage };
