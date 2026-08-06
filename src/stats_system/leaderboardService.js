// stats_system/leaderboardService.js
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");
const { formatCompact, formatDistance, formatHours } = require("../formatters");

// Guild name cache for logging
const guildNameCache = new Map();
async function getGuildName(guildId) {
  if (guildNameCache.has(guildId)) return guildNameCache.get(guildId);
  const { data } = await supabase.from("approved_guilds").select("guild_tag, guild_name").eq("guild_id", guildId).maybeSingle();
  const name = data ? `${data.guild_tag} ${data.guild_name}` : guildId;
  guildNameCache.set(guildId, name);
  return name;
}

/**
 * Helper to fetch a list of fields with server nicknames
 */
async function getLeaderboardFields(data, guild, valueFormatter) {
  return Promise.all(
    data.map(async (row, i) => {
      let displayName = row.players?.display_name || row.players?.username || "Unknown";

      const tag = row.players?.guild_tag || "";
      const name = `#${i + 1} ${tag} ${displayName}`.trim();

      return {
        name,
        value: valueFormatter(row),
        inline: false
      };
    })
  );
}

/**
 * Core Logic: Edit existing message (from DB) or Send New & Save to DB
 */
async function sendOrUpdate(guildId, channel, dbColumn, currentId, embed) {
  // 1. Try to Edit if we have an ID
  if (currentId) {
    try {
      const msg = await channel.messages.fetch(currentId);
      await msg.edit({ embeds: [embed] });
      return currentId; // Success, ID didn't change
    } catch (err) {
      console.warn(`[Leaderboard] Message ${currentId} not found/deleted. Sending new...`);
      // Fail silently and proceed to send new one
    }
  }

  // 2. Send New Message
  try {
    const newMsg = await channel.send({ embeds: [embed] });
    const gName = await getGuildName(guildId);
    console.log(`[Leaderboard] Sent new embed for ${dbColumn} in ${gName} (msg: ${newMsg.id})`);

    // 3. Save new ID to Database immediately
    const { error: saveErr } = await supabase
      .from("approved_guilds")
      .update({ [dbColumn]: newMsg.id })
      .eq("guild_id", guildId);

    if (saveErr) console.error(`[Leaderboard] Failed to save ${dbColumn} message ID:`, saveErr.message);

    return newMsg.id;
  } catch (err) {
    const gErrName = await getGuildName(guildId);
    console.error(`[Leaderboard] Failed to send ${dbColumn} for ${gErrName}:`, err.message);
    return null;
  }
}

const updateQueue = new Map();

async function updateLeaderboard(client, guildId) {
  if (!updateQueue.has(guildId)) {
    updateQueue.set(guildId, { isUpdating: false, needsAnotherUpdate: false });
  }

  const state = updateQueue.get(guildId);

  if (state.isUpdating) {
    state.needsAnotherUpdate = true;
    return;
  }

  state.isUpdating = true;

  try {
    await performLeaderboardUpdate(client, guildId);
  } finally {
    state.isUpdating = false;
    if (state.needsAnotherUpdate) {
      state.needsAnotherUpdate = false;
      // Wait 5 seconds to dodge Discord rate limits before processing the queued update
      setTimeout(() => updateLeaderboard(client, guildId), 5000);
    }
  }
}

async function performLeaderboardUpdate(client, guildId) {
  try {
    // 1. Get Config (colors, branding, channel ID)
    const guildConfig = await getGuildConfig(guildId);

    if (!guildConfig.leaderboard_channel_id) {
      const skipName = await getGuildName(guildId);
      console.warn(`[Leaderboard] Skipping ${skipName} — no leaderboard_channel_id set in DB.`);
      return;
    }

    // 2. Get stored message ID (only lb_msg_guilds now — single combined message)
    const { data: guildRow, error } = await supabase
      .from("approved_guilds")
      .select("lb_msg_guilds")
      .eq("guild_id", guildId)
      .single();

    if (error || !guildRow) {
      const fetchErrName = await getGuildName(guildId);
      console.error(`[Leaderboard] Failed to fetch guild row for ${fetchErrName}:`, error?.message);
      return;
    }

    const channel = await client.channels.fetch(guildConfig.leaderboard_channel_id).catch(async (err) => {
      const chErrName = await getGuildName(guildId);
      console.error(`[Leaderboard] Cannot fetch channel for ${chErrName}:`, err.message);
      return null;
    });
    if (!channel) return;

    // 3. Fetch active guilds first
    const { data: activeGuildsRaw } = await supabase.from("approved_guilds").select("guild_id").eq("is_suspended", false);
    const activeGuildIds = activeGuildsRaw ? activeGuildsRaw.map(g => g.guild_id) : [];

    if (activeGuildIds.length === 0) return; // Nothing to show

    const isHQ = guildId === process.env.HQ_GUILD_ID;

    // 4. Fetch all data in parallel
    // For the HQ server, distance/time LBs are global (all VTCs + independents)
    // For regular VTC servers, they are filtered by the guild's own members
    const distanceQuery = isHQ
      ? supabase.from("player_stats")
          .select("total_distance_km, players!inner(username, display_name, guild_tag, guild_id)")
          .or(`guild_id.in.(${activeGuildIds.join(",")}),guild_id.is.null`, { referencedTable: "players" })
          .gt("total_distance_km", 0)
          .order("total_distance_km", { ascending: false })
          .limit(5)
      : supabase.from("player_stats")
          .select("total_distance_km, players!inner(username, display_name, guild_tag, guild_id)")
          .eq("players.guild_id", guildId)
          .order("total_distance_km", { ascending: false })
          .limit(5);

    const timeQuery = isHQ
      ? supabase.from("player_stats")
          .select("total_time_minutes, players!inner(username, display_name, guild_tag, guild_id)")
          .or(`guild_id.in.(${activeGuildIds.join(",")}),guild_id.is.null`, { referencedTable: "players" })
          .gt("total_time_minutes", 0)
          .order("total_time_minutes", { ascending: false })
          .limit(5)
      : supabase.from("player_stats")
          .select("total_time_minutes, players!inner(username, display_name, guild_tag, guild_id)")
          .eq("players.guild_id", guildId)
          .order("total_time_minutes", { ascending: false })
          .limit(5);

    const [
      { data: guildsData },
      { data: guildStats },
      { data: topDistance },
      { data: topTime }
    ] = await Promise.all([
      supabase.from("approved_guilds").select("guild_id, guild_tag, guild_name, net_worth, runs").eq("is_suspended", false),
      supabase.from("player_stats").select("total_score, total_time_minutes, total_stars, total_distance_km, clean_deliveries, players!inner(guild_id)"),
      distanceQuery,
      timeQuery
    ]);

    // ─── EMBED 1: For HQ → Global UVS Dashboard. For VTC → own VTC stats card. ───
    let guildEmbed = null;

    if (isHQ) {
      // ── Global UVS Dashboard for the Headquarters server ──
      const [{ count: totalPlayers }, { data: allStats }] = await Promise.all([
        supabase.from("players").select("*", { count: "exact", head: true }),
        supabase.from("player_stats").select("total_distance_km, total_time_minutes")
      ]);

      const activeVTCCount = (guildsData || []).filter(g => g.guild_id !== process.env.HQ_GUILD_ID).length;
      const totalDistanceKm = (allStats || []).reduce((s, r) => s + (Number(r.total_distance_km) || 0), 0);
      const totalTimeMin    = (allStats || []).reduce((s, r) => s + (Number(r.total_time_minutes) || 0), 0);

      guildEmbed = {
        title: "🌐 UVS — Network Status",
        description: "Live statistics across all registered VTCs and Independent Drivers.",
        color: guildConfig.embed_color,
        thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
        fields: [
          { name: "👤 Registered Truckers", value: `${(totalPlayers || 0).toLocaleString()}`, inline: true },
          { name: "🏢 Unified VTCs",       value: `${activeVTCCount}`,                       inline: true },
          { name: "🛤️ Total Distance",     value: formatDistance(totalDistanceKm),            inline: true },
          { name: "⏱️ Total Drive Time",   value: formatHours(totalTimeMin),                 inline: true }
        ],
        footer: { text: "Managed by NMC" }
      };

    } else if (guildsData && guildStats) {
      const guildAggregates = new Map();
      for (const g of guildsData) {
        guildAggregates.set(g.guild_id, {
          guild_id: g.guild_id,
          guild_tag: g.guild_tag || "Unknown",
          guild_name: g.guild_name || "Unknown Server",
          net_worth: Number(g.net_worth) || 0,
          runs: Number(g.runs) || 0,
          total_score: 0,
          total_time_minutes: 0,
          total_stars: 0,
          total_distance_km: 0,
          clean_deliveries: 0,
          member_count: 0
        });
      }
      for (const stat of guildStats) {
        const gid = stat.players?.guild_id;
        if (!gid || !guildAggregates.has(gid)) continue;
        const agg = guildAggregates.get(gid);
        agg.total_score += Number(stat.total_score || 0);
        agg.total_time_minutes += Number(stat.total_time_minutes || 0);
        agg.total_stars += Number(stat.total_stars || 0);
        agg.total_distance_km += Number(stat.total_distance_km || 0);
        agg.clean_deliveries += Number(stat.clean_deliveries || 0);
        agg.member_count += 1;
      }

      // Sort all guilds
      const sortedGuilds = Array.from(guildAggregates.values())
        .sort((a, b) => b.net_worth - a.net_worth);

      const me = guildAggregates.get(guildId);
      
      if (me) {
        const myRank = sortedGuilds.findIndex(g => g.guild_id === guildId) + 1;
        const totalGuilds = sortedGuilds.length;
        const hours = Math.floor(me.total_time_minutes / 60);
        const mins = me.total_time_minutes % 60;

        guildEmbed = {
          title: `🏢 ${me.guild_tag} | ${me.guild_name}`,
          description: `**Global VTC Rank: #${myRank}** out of ${totalGuilds}`,
          color: guildConfig.embed_color,
          thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
          fields: [
            { name: "👥 Active Drivers", value: `${me.member_count}`, inline: true },
            { name: "💰 Net Worth", value: `$${Math.round(me.net_worth).toLocaleString()}`, inline: true },
            { name: "🏆 Total Score", value: `${Math.round(me.total_score).toLocaleString()}`, inline: true },
            { name: "🛤️ Total Distance", value: `${Math.round(me.total_distance_km).toLocaleString()} km`, inline: true },
            { name: "⏱️ Driving Time", value: `${hours}h ${mins}m`, inline: true },
            { name: "⭐ Total Stars", value: `${Math.round(me.total_stars).toLocaleString()}`, inline: true },
            { name: "✅ Clean Deliveries", value: `${me.clean_deliveries}`, inline: true },
            { name: "🚛 Total Runs", value: `${me.runs}`, inline: true }
          ]
        };
      }
    }

    // ─── EMBED 2: Distance Leaderboard ───
    const myGuildRow = guildsData?.find(g => g.guild_id === guildId);
    const myTag = myGuildRow?.guild_tag ? `${myGuildRow.guild_tag}` : "";

    const distanceFields = await getLeaderboardFields(
      topDistance || [],
      channel.guild,
      (row) => formatDistance(row.total_distance_km)
    );
    const distanceEmbed = {
      title: `🛤️ Distance Leaderboard ${myTag}`.trim(),
      color: guildConfig.embed_color,
      fields: distanceFields
    };

    // ─── EMBED 3: Time Leaderboard — footer goes here (last embed) ───
    const timeFields = await getLeaderboardFields(
      topTime || [],
      channel.guild,
      (row) => formatHours(row.total_time_minutes)
    );
    const timeEmbed = {
      title: `⏱️ Driving Time Leaderboard ${myTag}`.trim(),
      color: guildConfig.embed_color,
      fields: timeFields,
      footer: { text: "Managed by NMC • For viewing global leaderboards, please use bot commands." }
    };

    // 4. Combine into one message: Guild LB → Distance → Time
    const embeds = [
      ...(guildEmbed ? [guildEmbed] : []),
      distanceEmbed,
      timeEmbed
    ];

    // 5. Edit existing message or send new one — stored under lb_msg_guilds
    const currentId = guildRow.lb_msg_guilds;
    if (currentId) {
      try {
        const msg = await channel.messages.fetch(currentId);
        await msg.edit({ embeds });
        return;
      } catch (err) {
        const editErrName = await getGuildName(guildId);
        console.warn(`[Leaderboard] Message ${currentId} not found for ${editErrName}. Sending new...`);
      }
    }

    try {
      const newMsg = await channel.send({ embeds });
      const sentName = await getGuildName(guildId);
      console.log(`[Leaderboard] Sent combined leaderboard for ${sentName} (msg: ${newMsg.id})`);
      const { error: saveErr } = await supabase
        .from("approved_guilds")
        .update({ lb_msg_guilds: newMsg.id })
        .eq("guild_id", guildId);
      if (saveErr) { const sName = await getGuildName(guildId); console.error(`[Leaderboard] Failed to save lb_msg_guilds for ${sName}:`, saveErr.message); }
    } catch (err) {
      const sendErrName = await getGuildName(guildId);
      console.error(`[Leaderboard] Failed to send combined leaderboard for ${sendErrName}:`, err.message);
    }

  } catch (err) {
    console.error("Leaderboard update failed:", err);
  }
}

// ─────────────────────────────────────────────────────────────

// GLOBAL WEBHOOK SUPPORT
// ─────────────────────────────────────────────────────────────
const { WebhookClient } = require('discord.js');
let globalWebhookUpdating = false;
let globalWebhookNeedsUpdate = false;

async function getGlobalLeaderboardFields(client, data, valueFormatter) {
  return Promise.all(
    data.map(async (row, i) => {
      let displayName = row.players?.display_name || row.players?.username || "Unknown";
      const tag = row.players?.guild_tag || "";
      const name = `#${i + 1} ${tag} ${displayName}`.trim();
      return { name, value: valueFormatter(row), inline: false };
    })
  );
}

async function updateGlobalWebhook(client, guildId = null) {
  if (globalWebhookUpdating) {
    globalWebhookNeedsUpdate = true;
    return;
  }
  globalWebhookUpdating = true;
  try {
    await performGlobalWebhookUpdate(client, guildId);
  } finally {
    globalWebhookUpdating = false;
    if (globalWebhookNeedsUpdate) {
      globalWebhookNeedsUpdate = false;
      setTimeout(() => updateGlobalWebhook(client, guildId), 5000);
    }
  }
}

async function performGlobalWebhookUpdate(client, guildId = null) {
  const webhookUrlsStr = process.env.GLOBAL_LB_WEBHOOK_URL;
  if (!webhookUrlsStr) return;

  const webhookUrls = webhookUrlsStr.split(",").map(url => url.trim()).filter(url => url.length > 0);
  if (webhookUrls.length === 0) return;

  try {
    // ───────────── Guilds Leaderboard ─────────────
    let guildsQuery = supabase
      .from("approved_guilds")
      .select("guild_id, guild_tag, guild_name, net_worth, embed_color, webhook_id:webhook_id::text, avatar_url, runs")
      .eq("is_suspended", false);

    if (guildId) {
      guildsQuery = guildsQuery.eq("guild_id", guildId);
    }

    const { data: guildsData } = await guildsQuery;

    let guildStatsQuery = supabase
      .from("player_stats")
      .select("total_time_minutes, total_distance_km, players!inner(guild_id)");

    if (guildId) {
      guildStatsQuery = guildStatsQuery.eq("players.guild_id", guildId);
    }

    const { data: guildStats } = await guildStatsQuery;

    if (!guildsData) return;

    const guildAggregates = new Map();
    for (const guild of guildsData) {
      guildAggregates.set(guild.guild_id, {
        ...guild,
        total_income: Number(guild.net_worth) || 0,
        total_runs: Number(guild.runs) || 0,
        total_time_minutes: 0,
        total_distance_km: 0,
        driver_count: 0
      });
    }

    if (guildStats) {
      for (const stat of guildStats) {
        const gid = stat.players?.guild_id;
        if (!gid || !guildAggregates.has(gid)) continue;
        const agg = guildAggregates.get(gid);
        agg.total_time_minutes += Number(stat.total_time_minutes || 0);
        agg.total_distance_km += Number(stat.total_distance_km || 0);
        agg.driver_count += 1;
      }
    }

    for (const guild of guildAggregates.values()) {
      // Skip the HQ guild — it does not get a personal VTC card in the webhook
      if (guild.guild_id === process.env.HQ_GUILD_ID) continue;
      let description = 
        `💰 Net Worth   : **$${formatCompact(guild.total_income)}**\n` +
        `👥 Drivers     : **${guild.driver_count}**\n` +
        `⏱️ Time        : **${formatHours(guild.total_time_minutes)}**\n` +
        `🛣️ Distance    : **${formatDistance(guild.total_distance_km)}**\n` +
        `🚛 Runs        : **${guild.total_runs}**`;

      let parsedColor = 0xffffff;
      if (typeof guild.embed_color === 'number') {
        parsedColor = guild.embed_color;
      } else if (typeof guild.embed_color === 'string') {
        parsedColor = parseInt(guild.embed_color.replace('#', ''), 16);
      }
      if (isNaN(parsedColor) || parsedColor > 16777215 || parsedColor < 0) {
        parsedColor = 0xffffff;
      }

      const { data: latestRun } = await supabase
        .from("runs")
        .select("created_at, players!inner(guild_id)")
        .eq("players.guild_id", guild.guild_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let footerText = "• No jobs logged yet •";
      if (latestRun && latestRun.created_at) {
        footerText = `• Latest Job • ${new Date(latestRun.created_at).toLocaleString()}`;
      }

      const embed = {
        title: `🏢 ${guild.guild_tag || "[VTC]"} ${guild.guild_name || "Unknown Guild"}`,
        description,
        color: parsedColor,
        thumbnail: guild.avatar_url ? { url: guild.avatar_url } : undefined,
        footer: { text: footerText }
      };

      const storedIds = guild.webhook_id ? String(guild.webhook_id).split(",").map(id => id.trim()) : [];
      const newIds = [];

      for (let idx = 0; idx < webhookUrls.length; idx++) {
        const url = webhookUrls[idx];
        const messageId = storedIds[idx] || null;
        const webhookClient = new WebhookClient({ url });

        let sentId = null;
        if (messageId) {
          try {
            await webhookClient.editMessage(messageId, { content: null, embeds: [embed] });
            sentId = messageId;
          } catch (err) {
            console.warn(`[Global Webhook] Failed to edit msg ${messageId} on webhook ${idx}: ${err.message}. Sending new msg...`);
          }
        }

        if (!sentId) {
          try {
            const sentMessage = await webhookClient.send({ content: null, embeds: [embed] });
            sentId = sentMessage.id;
            console.log(`[Global Webhook] Sent new embed on webhook ${idx} (ID: ${sentId})`);
          } catch (err) {
            console.error(`[Global Webhook] Failed to send to webhook ${idx}:`, err.message);
          }
        }

        if (sentId) {
          newIds.push(sentId);
        } else {
          newIds.push(messageId || "");
        }
      }

      const serializedIds = newIds.join(",");
      const { error: saveErr } = await supabase
        .from("approved_guilds")
        .update({ webhook_id: serializedIds })
        .eq("guild_id", guild.guild_id);

      if (saveErr) console.error(`[Global Webhook] Failed to save webhook_id for ${guild.guild_tag} ${guild.guild_name}:`, saveErr.message);
    }

  } catch (err) {
    console.error("Global Webhook update failed:", err);
  }
}

module.exports = { updateLeaderboard, updateGlobalWebhook };
