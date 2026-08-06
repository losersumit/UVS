/**
 * ============================================================================
 * MODULE: radio.js
 * PURPOSE: Implements the /setradiofrequency slash command. Allows VTCs to
 *          configure their radio frequency for cross-server communication.
 * ============================================================================
 */

const { EmbedBuilder } = require("discord.js");
const { supabase } = require("../stats_system/supabase");
const { updateRadioDirectory } = require("../stats_system/radioDirectory");

async function setradiofrequency(interaction) {
  // Radio module is disabled in the HQ server
  if (interaction.guild.id === process.env.HQ_GUILD_ID) return;

  const guildId = interaction.guild.id;
  const frequency = interaction.options.getNumber("frequency");

  // Validate range: 100 to 120
  if (frequency < 100 || frequency > 120) {
    return interaction.reply({
      content: "❌ Invalid frequency. The radio frequency must be between **100.00** and **120.00** MHz.",
      ephemeral: true
    });
  }

  // Validate decimal places (maximum of 2 decimal places)
  const freqStr = frequency.toString();
  const decimalPart = freqStr.split(".")[1];
  if (decimalPart && decimalPart.length > 2) {
    return interaction.reply({
      content: "❌ Invalid frequency format. A maximum of **two decimal places** is permitted (e.g., `119.88`).",
      ephemeral: true
    });
  }

  await interaction.deferReply();

  // Update frequency in approved_guilds
  const { error } = await supabase
    .from("approved_guilds")
    .update({ radio_frequency: frequency })
    .eq("guild_id", guildId);

  if (error) {
    console.error("[Radio] Failed to update radio frequency:", error);
    return interaction.editReply({
      content: "❌ An error occurred while updating your radio frequency configuration."
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("📡  Radio Frequency Configured")
    .setDescription(`This server has successfully tuned into frequency **${frequency.toFixed(2)} MHz**.\n\nAll subsequent transmissions starting with \`+rd \` will be broadcast on this frequency.`)
    .setColor(0xff7801)
    .setTimestamp()
    .setFooter({ text: "Radio Service" });

  await interaction.editReply({ embeds: [embed] });

  // Update central radio directory in real-time
  updateRadioDirectory(interaction.client).catch(err => 
    console.error("[Radio] Failed to update central directory on freq change:", err)
  );
}

module.exports = { execute: setradiofrequency };
