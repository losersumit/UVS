const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");

async function execute(interaction) {
  await interaction.deferReply();
  const guildConfig = await getGuildConfig(interaction.guild.id);

  const screenshotChannel = guildConfig.screenshot_channel_id
    ? `<#${guildConfig.screenshot_channel_id}>`
    : "the designated channel";

  const leaderboardChannel = guildConfig.leaderboard_channel_id
    ? `<#${guildConfig.leaderboard_channel_id}>`
    : "the server leaderboards";

  const { data: guildsData } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_tag, guild_name")
    .eq("is_suspended", false)
    .order("guild_tag", { ascending: true });

  const guildList = (guildsData || []).map(g => {
    const name = g.guild_name || interaction.client.guilds.cache.get(g.guild_id)?.name || "Unknown Server";
    return `**${g.guild_tag}** ${name}`;
  }).join("\n");

  const helpEmbed = {
    title: "🚛 UVS Bot Help & Commands",
    description: `I am a career tracking bot for **Truckers of Europe 3**! \n\n**How it works:**\n1. Upload your **'Job Finished'** screenshot to ${screenshotChannel}.\n2. I will automatically scan the image (OCR), verify the data, and update your career stats.\n3. Compete with others on ${leaderboardChannel}!`,
    color: guildConfig.embed_color,
    thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
    fields: [
      { name: "📊 /stats [user]", value: "View your personal career stats or check another driver's profile.", inline: false },
      { name: "🏁 /speedlb [global]", value: "View Top Average Speeds. Default is current server only. Set `global: True` for all servers.", inline: true },
      { name: "📈 /levellb [global]", value: "See highest Career Levels. Default is current server only. Set `global: True` to include all servers.", inline: true },
      { name: "🛤️ /distancelb [global]", value: "Rank by Total Distance. Default is current server only. Set `global: True` to include all servers.", inline: true },
      { name: "⏱️ /timelb [global]", value: "Rank by Total Time Driven. Default is current server only. Set `global: True` to include all servers.", inline: true },
      { name: "💰 /networthlb [global]", value: "Rank by total money earned from saved runs. Default is current server only. Set `global: True` to include all servers.", inline: true },
      { name: "⭐ /bestdrivers [global]", value: "Rank by Clean Deliveries. Default is current server only. Set `global: True` to include all servers.", inline: true },
      { name: "🚨 /worstdrivers [global]", value: "Rank by total penalties. Default is current server only. Set `global: True` to include all servers.", inline: true },
      { name: "🛠️ /clearstats", value: "**(Owner Only)** Reset a user's stats completely.", inline: true },
      { name: "📡 /setradiofrequency [freq]", value: "Tune into a radio frequency between 100.00 and 120.00 MHz (e.g., `119.88`).", inline: true },
      { name: "📻 Radio Broadcast (+rd)", value: "Prefix any message in any channel with `+rd ` to broadcast it to all other VTCs sharing your frequency. The message will be received in their designated call channel. (Note: **100.00 MHz** is the Help & Support frequency monitored by NMC).", inline: false },
      { name: "✅ Approved VTCs", value: guildList || "No VTCs found.", inline: false },
      { name: "ℹ️ /help", value: "Show this information menu.", inline: true }
    ],
    footer: {
      text: "Operated by NMC"
    }
  };

  await interaction.editReply({ embeds: [helpEmbed] });
}

module.exports = { execute };
