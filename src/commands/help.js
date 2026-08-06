const { getGuildConfig } = require("../stats_system/guildConfig");

async function execute(interaction) {
  await interaction.deferReply();
  const guildConfig = await getGuildConfig(interaction.guild.id);
  const isHQ = interaction.guild.id === process.env.HQ_GUILD_ID;

  const screenshotChannel = guildConfig.screenshot_channel_id
    ? `<#${guildConfig.screenshot_channel_id}>`
    : "the designated channel";

  const leaderboardChannel = guildConfig.leaderboard_channel_id
    ? `<#${guildConfig.leaderboard_channel_id}>`
    : "the server leaderboards";

  // ── Command description varies slightly between HQ and VTC servers ──
  const lbOptionNote = isHQ
    ? "All leaderboard commands are **global** in this server — no option needed."
    : "Default is current server only. Set `global: True` for all servers.";

  const radioFields = isHQ
    ? [
        { name: "📡 Radio Module", value: "🚫 The radio broadcast module is **disabled** in this server.", inline: false }
      ]
    : [
        { name: "📡 /setradiofrequency [freq]", value: "Tune into a radio frequency between 100.00 and 120.00 MHz (e.g., `119.88`).", inline: true },
        { name: "📻 Radio Broadcast (+rd)", value: "Prefix any message with `+rd ` to broadcast it to all VTCs sharing your frequency. Their designated call channel will receive it. (**100.00 MHz** is the Help & Support frequency monitored by NMC).", inline: false }
      ];

  const helpEmbed = {
    title: "🚛 UVS Bot Help & Commands",
    description: isHQ
      ? `I am a career tracking bot for **Truckers of Europe 3**!\n\n**How it works:**\n1. Upload your **'Job Finished'** screenshot to ${screenshotChannel}.\n2. I will automatically scan the image (OCR), verify the data, and update your career stats.\n3. Compete with other drivers on ${leaderboardChannel}!\n\nThis is the **Main VTC Server** — all drivers from any VTC (or Independent) can log their jobs here.`
      : `I am a career tracking bot for **Truckers of Europe 3**!\n\n**How it works:**\n1. Upload your **'Job Finished'** screenshot to ${screenshotChannel}.\n2. I will automatically scan the image (OCR), verify the data, and update your career stats.\n3. Compete with others on ${leaderboardChannel}!`,
    color: guildConfig.embed_color,
    thumbnail: guildConfig.thumbnail ? { url: guildConfig.thumbnail } : undefined,
    fields: [
      { name: "📊 /stats [user]", value: "View your personal career stats or check another driver's profile.", inline: false },
      { name: "🏁 /speedlb",    value: `View Top Average Speeds. ${lbOptionNote}`, inline: true },
      { name: "📈 /levellb",    value: `See highest Career Levels. ${lbOptionNote}`, inline: true },
      { name: "🛤️ /distancelb", value: `Rank by Total Distance. ${lbOptionNote}`, inline: true },
      { name: "⏱️ /timelb",    value: `Rank by Total Time Driven. ${lbOptionNote}`, inline: true },
      { name: "💰 /networthlb", value: `Rank by total money earned. ${lbOptionNote}`, inline: true },
      { name: "⭐ /bestdrivers",  value: `Rank by Clean Deliveries. ${lbOptionNote}`, inline: true },
      { name: "🚨 /worstdrivers", value: `Rank by total penalties. ${lbOptionNote}`, inline: true },
      { name: "🛠️ /clearstats",   value: "**(Owner Only)** Reset a user's stats completely.", inline: true },
      { name: "🚫 /suspenduser",  value: isHQ ? "🚫 **(Owner Only)** Suspend a user from logging jobs." : "**(Owner Only)** Completely delete a user's account and remove all their run logs/contributions.", inline: true },
      ...radioFields,
      { name: "ℹ️ /help", value: "Show this information menu.", inline: true }
    ],
    footer: {
      text: "Operated by NMC"
    }
  };

  await interaction.editReply({ embeds: [helpEmbed] });
}

module.exports = { execute };
