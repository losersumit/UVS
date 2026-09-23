// commands/activateunbeconomy.js
const { EmbedBuilder } = require("discord.js");
const { isOwner } = require("../owner");
const { supabase } = require("../stats_system/supabase");
const { clearGuildConfigCache, getGuildConfig } = require("../stats_system/guildConfig");

const UNB_BOT_ID = "292953664492929025";
const UVS_BOT_ID = process.env.UNB_BOT_CLIENT_ID || "1464033910726988011";

async function execute(interaction) {
  // 1. Owner check
  if (!isOwner(interaction.user.id)) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xff3333)
      .setDescription("❌ Only the bot owner can use this command.");
    return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: "❌ This command can only be run inside a server.", ephemeral: true });
  }

  // Defer response as non-ephemeral minimal reply
  await interaction.deferReply({ ephemeral: false });

  try {
    // 2. Check if UNB Bot and UVS Bot are both present in the guild
    const unbMember = await guild.members.fetch(UNB_BOT_ID).catch(() => null);
    const uvsMember = await guild.members.fetch(UVS_BOT_ID).catch(() => null);

    const isUnbPresent = !!unbMember;
    const isUvsPresent = !!uvsMember;

    if (!isUnbPresent || !isUvsPresent) {
      const missing = [];
      if (!isUnbPresent) missing.push(`UnbelievaBoat Bot (\`${UNB_BOT_ID}\`)`);
      if (!isUvsPresent) missing.push(`UVS Bot (\`${UVS_BOT_ID}\`)`);

      const missingEmbed = new EmbedBuilder()
        .setColor(0xff3333)
        .setTitle("UNB Economy Activation Failed")
        .setDescription(`Both **UnbelievaBoat Bot** and **UVS Bot** must be present in this server to activate UNB Economy.\n\n**Missing:** ${missing.join(", ")}`);

      return interaction.editReply({ embeds: [missingEmbed] });
    }

    // 3. Enable UNB economy in approved_guilds table
    const { error: dbError } = await supabase
      .from("approved_guilds")
      .update({ enable_unb_economy: true })
      .eq("guild_id", guild.id);

    if (dbError) {
      console.error("[ACTIVATE_UNB] Database error:", dbError);
      const failEmbed = new EmbedBuilder()
        .setColor(0xff3333)
        .setDescription(`❌ Failed to update database: ${dbError.message}`);
      return interaction.editReply({ embeds: [failEmbed] });
    }

    // Clear config cache for this guild
    clearGuildConfigCache(guild.id);

    // 4. Send minimal non-ephemeral embed response
    const currentConfig = await getGuildConfig(guild.id);
    const successEmbed = new EmbedBuilder()
      .setColor(currentConfig.embed_color || 0x2b2d31)
      .setTitle("UNB Economy Activated")
      .setDescription(`UnbelievaBoat Economy integration is now **enabled** for **${guild.name}**.\nJob log rewards will automatically sync to UnbelievaBoat cash balance.`);

    return interaction.editReply({ embeds: [successEmbed] });
  } catch (err) {
    console.error("[ACTIVATE_UNB_ERROR]", err);
    const errEmbed = new EmbedBuilder()
      .setColor(0xff3333)
      .setDescription(`❌ An error occurred: ${err.message}`);
    return interaction.editReply({ embeds: [errEmbed] });
  }
}

module.exports = { execute };
