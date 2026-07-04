const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { isOwner } = require("../owner");
const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder } = require("discord.js");

async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user");
  
  // Fetch player details
  const { data: player } = await supabase
    .from("players")
    .select("id, guild_id, guild_tag, allow_guild_change")
    .eq("discord_id", target.id)
    .maybeSingle();

  if (!player) {
    return interaction.editReply("❌ Player not found in the database.");
  }

  // Fetch all non-suspended approved guilds
  const { data: guilds, error: guildsError } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag")
    .eq("is_suspended", false);

  if (guildsError || !guilds || guilds.length === 0) {
    return interaction.editReply("❌ No active approved guilds/VTCs found.");
  }

  const guildConfig = await getGuildConfig(interaction.guild.id);

  // Build select menu
  const select = new StringSelectMenuBuilder()
    .setCustomId("select_guild")
    .setPlaceholder("Select a new company/guild")
    .addOptions(
      guilds.map(g =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${g.guild_name} [${g.guild_tag}]`)
          .setValue(g.guild_id)
      )
    );

  const row = new ActionRowBuilder().addComponents(select);

  const initialEmbed = {
    title: "🏢 Guild Change Request",
    description: `Select a new company/guild for **${target.username}**.\n\n**Current Tag:** ${player.guild_tag || "None"}\n**Current Guild ID:** ${player.guild_id || "None"}\n**Allow Status:** ${player.allow_guild_change ? "🔓 Enabled" : "🔒 Disabled (will be enabled automatically)"}`,
    color: guildConfig.embed_color || 0x0099ff
  };

  const response = await interaction.editReply({
    embeds: [initialEmbed],
    components: [row]
  });

  const filter = i => i.user.id === interaction.user.id;

  try {
    const confirmation = await response.awaitMessageComponent({ filter, time: 60000 });

    if (confirmation.customId === "select_guild") {
      const selectedGuildId = confirmation.values[0];
      const selectedGuild = guilds.find(g => g.guild_id === selectedGuildId);

      // Step 1: Force allow_guild_change to true so database allows updating the guild_id
      if (!player.allow_guild_change) {
        const { error: unlockError } = await supabase
          .from("players")
          .update({ allow_guild_change: true })
          .eq("id", player.id);

        if (unlockError) {
          console.error("Database unlock error:", unlockError);
          return confirmation.update({
            content: `❌ Failed to temporarily enable guild changes: ${unlockError.message}`,
            embeds: [],
            components: []
          });
        }
      }

      // Step 2: Update guild_id and guild_tag (triggers will allow the change and auto-relock allow_guild_change to false)
      const { error: updateError } = await supabase
        .from("players")
        .update({
          guild_id: selectedGuild.guild_id,
          guild_tag: selectedGuild.guild_tag
        })
        .eq("id", player.id);

      if (updateError) {
        console.error("Database update error:", updateError);
        return confirmation.update({
          content: `❌ Failed to update guild details: ${updateError.message}`,
          embeds: [],
          components: []
        });
      }

      // Confirm the guild change in the same embed
      const successEmbed = {
        title: "🏢 Guild Change Confirmed",
        description: `Successfully changed guild/company for **${target.username}**.\n\n**New Guild:** ${selectedGuild.guild_name} [${selectedGuild.guild_tag}]\n**New Guild ID:** ${selectedGuild.guild_id}`,
        color: 0x00ff00
      };

      await confirmation.update({
        embeds: [successEmbed],
        components: []
      });
    }
  } catch (err) {
    await interaction.editReply({
      content: "❌ Interaction timed out or error occurred.",
      embeds: [],
      components: []
    });
  }
}

module.exports = { execute };
